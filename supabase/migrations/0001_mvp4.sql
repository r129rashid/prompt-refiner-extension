-- Promptify MVP4 — invite / free-credits tier.
-- Run once in the Supabase SQL editor (or `supabase db push`).
-- Credits are server-authoritative: no client can write pf_users.credits.

-- ---- config / kill switch --------------------------------------------------
create table if not exists pf_config (
  id int primary key default 1,
  free_tier_enabled boolean not null default true,
  signup_credits int not null default 10,
  referral_bonus int not null default 10,
  referral_cap int not null default 100,
  constraint pf_config_singleton check (id = 1)
);
insert into pf_config (id) values (1) on conflict (id) do nothing;
alter table pf_config enable row level security; -- no policies => only service role reads/writes

-- ---- users -----------------------------------------------------------------
create table if not exists pf_users (
  user_id uuid primary key references auth.users on delete cascade,
  credits int not null default 0,
  referral_code text unique not null,
  referred_by text,                    -- referral_code of the inviter
  referral_earned int not null default 0,
  device_hash text,
  first_refine_at timestamptz,
  created_at timestamptz not null default now()
);
alter table pf_users enable row level security;
-- Users may READ their own row only. No insert/update/delete policies => the
-- service role (edge function) is the only writer of credits.
create policy "own row read" on pf_users for select using (auth.uid() = user_id);

-- ---- referrals -------------------------------------------------------------
create table if not exists pf_referrals (
  id uuid primary key default gen_random_uuid(),
  inviter uuid not null references auth.users on delete cascade,
  invitee uuid not null references auth.users on delete cascade unique, -- one referrer ever
  status text not null default 'pending',        -- pending | credited
  created_at timestamptz not null default now(),
  credited_at timestamptz
);
alter table pf_referrals enable row level security;
create policy "inviter reads" on pf_referrals for select using (auth.uid() = inviter);

-- ---- usage log (rate-limit + forensics) ------------------------------------
create table if not exists pf_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  ts timestamptz not null default now(),
  model text
);
alter table pf_usage enable row level security; -- service-role only
create index if not exists pf_usage_user_ts on pf_usage (user_id, ts desc);

-- ---- new-user trigger: create pf_users row, wire referral --------------------
create or replace function pf_handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_ref text := nullif(new.raw_user_meta_data ->> 'ref', '');
  v_device text := nullif(new.raw_user_meta_data ->> 'device', '');
  v_inviter uuid;
  v_code text;
  v_signup int;
begin
  select signup_credits into v_signup from pf_config where id = 1;

  -- generate a short unique referral code
  loop
    v_code := lower(substr(md5(gen_random_uuid()::text), 1, 8));
    exit when not exists (select 1 from pf_users where referral_code = v_code);
  end loop;

  -- resolve inviter (must exist, must not be self)
  if v_ref is not null then
    select user_id into v_inviter from pf_users where referral_code = v_ref;
    if v_inviter = new.id then v_inviter := null; end if;  -- no self-referral
  end if;

  insert into pf_users (user_id, credits, referral_code, referred_by, device_hash)
  values (new.id, v_signup, v_code, case when v_inviter is not null then v_ref else null end, v_device);

  if v_inviter is not null then
    insert into pf_referrals (inviter, invitee, status)
    values (v_inviter, new.id, 'pending')
    on conflict (invitee) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists pf_on_auth_user_created on auth.users;
create trigger pf_on_auth_user_created
  after insert on auth.users
  for each row execute function pf_handle_new_user();

-- ---- spend one credit (atomic gate) ----------------------------------------
create or replace function pf_spend_credit(p_model text)
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_left int;
  v_enabled boolean;
  v_recent int;
begin
  select free_tier_enabled into v_enabled from pf_config where id = 1;
  if not v_enabled then raise exception 'free_tier_disabled'; end if;

  -- per-user rate limit: max 10 / minute
  select count(*) into v_recent from pf_usage
    where user_id = auth.uid() and ts > now() - interval '1 minute';
  if v_recent >= 10 then raise exception 'rate_limited'; end if;

  update pf_users set credits = credits - 1
    where user_id = auth.uid() and credits > 0
    returning credits into v_left;
  if v_left is null then raise exception 'no_credits'; end if;

  insert into pf_usage (user_id, model) values (auth.uid(), p_model);
  return v_left;
end;
$$;

-- ---- refund on downstream failure ------------------------------------------
create or replace function pf_refund_credit()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update pf_users set credits = credits + 1 where user_id = auth.uid();
end;
$$;

-- ---- confirm first successful use → credit the inviter ---------------------
create or replace function pf_confirm_first_use()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_ref text;
  v_first timestamptz;
  v_inviter uuid;
  v_bonus int;
  v_cap int;
  v_earned int;
begin
  select referred_by, first_refine_at into v_ref, v_first
    from pf_users where user_id = auth.uid();
  if v_first is not null then return; end if;         -- already confirmed once

  update pf_users set first_refine_at = now() where user_id = auth.uid();
  if v_ref is null then return; end if;

  select referral_bonus, referral_cap into v_bonus, v_cap from pf_config where id = 1;

  select user_id, referral_earned into v_inviter, v_earned
    from pf_users where referral_code = v_ref;
  if v_inviter is null then return; end if;
  if v_earned >= v_cap then return; end if;           -- lifetime cap reached

  update pf_users
    set credits = credits + v_bonus,
        referral_earned = referral_earned + v_bonus
    where user_id = v_inviter;

  update pf_referrals set status = 'credited', credited_at = now()
    where invitee = auth.uid();
end;
$$;
