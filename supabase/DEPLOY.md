# Deploying the Promptify Free tier

The free/invite tier needs a Supabase backend + a server-side OpenRouter key. These
steps require **your** credentials and can't be done from the extension repo alone.
The extension works fully in BYO-key mode without any of this — the free tier only
lights up once `pf-config.js` points at a deployed project.

## 1. Supabase project
- Use the existing project or create one at https://supabase.com.
- **Authentication → Providers → Email**: enable it, and turn **Confirm email ON**
  (email verification is part of the anti-abuse design).

## 2. Database
- SQL Editor → paste and run [`migrations/0001_mvp4.sql`](migrations/0001_mvp4.sql).
- This creates `pf_users`, `pf_referrals`, `pf_usage`, `pf_config`, the new-user
  trigger, and the `pf_spend_credit` / `pf_refund_credit` / `pf_confirm_first_use`
  RPCs. Credit amounts live in `pf_config` (defaults 10 / +10 / cap 100); edit that
  row to tune them. Set `free_tier_enabled = false` to kill the free tier instantly.

## 3. Edge function
Install the Supabase CLI, then from `extension/supabase/`:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set PROMPTIFY_OPENROUTER_KEY=sk-or-...   # a key YOU fund; free models keep it ~$0
# optional: supabase secrets set FREE_MODEL=nvidia/nemotron-3-super-120b-a12b:free
supabase functions deploy refine-proxy --no-verify-jwt
```

`--no-verify-jwt` is intentional: the function verifies the JWT itself so it can
return friendly errors. The OpenRouter key lives only in the function's secrets and
is never shipped to any client.

## 4. Point the extension at it
Edit [`../pf-config.js`](../pf-config.js):

```js
const PF_SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
const PF_ANON_KEY = 'your anon public key';   // Project Settings → API
```

Reload the unpacked extension. The "Free credits" card appears in Settings and
"Promptify Free" shows up as a provider.

## 5. Before publishing to the Web Store
- Update `PRIVACY.md` + `docs/privacy.html` are already done (they describe the
  opt-in proxy path). This is a **material change → the store re-reviews**.
- Once you know the published extension ID, you can tighten CORS in
  `functions/refine-proxy/index.ts` to that exact `chrome-extension://<id>` origin.

## How the anti-abuse pieces map to code
- **Server-authoritative credits** → `pf_users` has no client write policy; only the
  RPCs (service-definer) mutate `credits`.
- **Atomic spend, no double-spend** → `pf_spend_credit` does a single conditional UPDATE.
- **Bonus only on first real refine** → `pf_confirm_first_use`, called after a
  successful model response, not at signup.
- **No self-referral / one referrer** → trigger checks `inviter != new.id`; `pf_referrals.invitee` is unique.
- **Lifetime cap** → `pf_users.referral_earned` vs `pf_config.referral_cap`.
- **Rate limit** → `pf_spend_credit` counts `pf_usage` in the last minute.
- **Free-models-only** → the function hardcodes `FREE_MODEL`; even a breach costs ~$0.
- **Kill switch** → `pf_config.free_tier_enabled`.
- **Email verification + disposable-domain blocklist** → Supabase Auth setting (step 1);
  add a domain blocklist under Auth → Providers if desired.
