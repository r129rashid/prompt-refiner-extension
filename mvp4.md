# Promptify — MVP4 Spec: Invite / Free-Credits Tier

*Status: design only — not yet implemented. Build in a dedicated session.*

## Principle

Promptify stays **BYO-key first**. The current flow (bring your own OpenRouter/Anthropic key, anonymous, unlimited, no backend) is untouched and remains the default. The free tier is a **fully opt-in** addition: a user with no key can sign in and get free refinements, and grow their balance by inviting others. Anonymous BYO users never see auth, never hit a server of ours, and their prompts still go only to the provider they configure.

## Two modes

| | BYO key (today, default) | Promptify Free (new, opt-in) |
|---|---|---|
| Auth | none | Supabase email (verified) |
| Compute | user's key → OpenRouter/Anthropic | Promptify key → OpenRouter `:free` models via proxy |
| Limit | unlimited | credit-metered (10 start, +10/referral, cap 100) |
| Cost to us | $0 | ~$0 (free models only) |

A new provider entry **"Promptify Free"** in the popup routes to the proxy. Onboarding gains a **"Try 10 free — no key needed"** path so keyless users aren't dead-ended at the welcome card.

## Backend (existing Supabase, only when the user opts in)

**Auth:** Supabase email auth; email verification required before any credit is usable.

**Tables** (all prefixed `pf_`, RLS on):
- `pf_users` — `user_id` (pk, = auth.uid), `credits int`, `referral_code text unique`, `referred_by text null`, `device_hash text`, `created_at`. Users may **read** their own row; **no client writes to `credits`** — only the service role (edge function) mutates it.
- `pf_referrals` — `id`, `inviter uuid`, `invitee uuid`, `status` (`pending`|`credited`), `created_at`, `credited_at`. Unique on `invitee` (one referrer per person, ever).
- `pf_usage` — `user_id`, `ts`, `model` — for rate-limiting and abuse forensics.

**Edge Function `refine-proxy`** (Deno):
1. Require a valid Supabase JWT (anon → 401).
2. Load the caller's `pf_users` row; reject if `credits <= 0`.
3. Call OpenRouter with a **`:free` model** using the server-side `OPENROUTER_KEY` (function env secret — never shipped to any client).
4. On success, decrement 1 credit inside a Postgres RPC/transaction (atomic, no double-spend under concurrency) and insert a `pf_usage` row.
5. Return the refined text. CORS restricted to the extension origin (`chrome-extension://<id>`).

## Referral flow

- Every user has a `referral_code` and an invite link: `https://r129rashid.github.io/prompt-refiner-extension/?ref=CODE`.
- Invitee signs up with `?ref=CODE` → `pf_referrals` row created `pending`, `referred_by` set on the new `pf_users` row.
- **The inviter's +10 is credited only after the invitee (a) verifies their email AND (b) completes their first real refinement.** Not on signup. This is the anti-farming keystone.

## Loopholes handled (the "handle all loopholes" requirement)

| Loophole | Defense |
|---|---|
| Client fakes its credit count | Credits are server-authoritative; every spend is a DB transaction. Client display is advisory only. |
| Fake accounts to farm referrals | Bonus pays only on the invitee's **first successful refinement**, not signup — junk accounts earn nothing. |
| Throwaway emails | Email verification required + disposable-domain blocklist. |
| Self-referral | Enforce `inviter != invitee`; unique `invitee` (can't be referred twice); block referring your own account. |
| One person, many accounts | Hashed `device_hash` + per-IP daily signup cap in the edge function; flag/deny beyond threshold. |
| Unbounded farming | Lifetime referral bonus capped at 100; per-user request rate limit. |
| Someone drains our key | Free tier is `:free`-models-only → even total abuse costs ~$0; plus a server **kill-switch flag** to disable the free tier instantly. |
| Calling the proxy directly / stealing the key | Proxy is JWT-gated + CORS-locked; the real key lives only in the function env. |
| Double-spend via concurrent requests | Credit decrement is a single atomic RPC (SELECT … FOR UPDATE / transactional). |

## Client changes (when built)

- **Settings** gains a "Free credits" card: sign in/out, current balance, invite link + copy button, referral count. Reuse the ✎/saved-state pattern already in options.
- **shared.js** `callProvider` gets a `promptify` provider branch that POSTs to the edge function with the Supabase JWT instead of a raw API key.
- Feature-flagged; anonymous BYO users see none of it.

## Privacy & store impact

The free tier **does** send prompts to Promptify's proxy — a material change from "nothing leaves your browser except your own provider calls." Before shipping:
- Update `PRIVACY.md` and `docs/privacy.html` to describe the proxy path (what's sent, retention = none beyond the transient request + a usage-count row with no prompt text).
- Update the store listing's data disclosures; this **triggers a Web Store re-review**.
- Keep the BYO privacy guarantee explicit and unchanged for users who never opt in.

## Open decisions before build

- Fund/verify the Promptify OpenRouter account (free models may still require an account with limits).
- Confirm disposable-email list source and IP-cap thresholds.
- Whether the invite landing lives on the existing GitHub Pages site or a small auth page.
