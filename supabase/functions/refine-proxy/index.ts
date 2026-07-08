// Promptify — free-tier refine proxy.
// Deploy: supabase functions deploy refine-proxy --no-verify-jwt
// (we verify the JWT ourselves so we can return friendly errors)
// Secrets required (supabase secrets set ...):
//   PROMPTIFY_OPENROUTER_KEY  — server-side OpenRouter key (NEVER shipped to clients)
//   FREE_MODEL                — optional, defaults to a :free model
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected automatically.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const OPENROUTER_KEY = Deno.env.get('PROMPTIFY_OPENROUTER_KEY')!;
const FREE_MODEL = Deno.env.get('FREE_MODEL') ?? 'nvidia/nemotron-3-super-120b-a12b:free';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const MAX_INPUT = 8000;

function cors(origin: string | null) {
  // Reflect the extension's origin (id unknown for unpacked builds); JWT is the real gate.
  const allow = origin && origin.startsWith('chrome-extension://') ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });

  // Hoisted so the single catch below can refund a spent credit on ANY failure.
  let asUser: ReturnType<typeof createClient> | null = null;
  let spent = false;

  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

    // --- auth: verify the caller's JWT ---
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) throw new HttpError(401, 'Sign in to use Promptify Free.');

    asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await asUser.auth.getUser();
    if (userErr || !userData?.user) throw new HttpError(401, 'Session expired — sign in again.');

    // --- validate input ---
    let payload: { system?: string; user?: string; temperature?: number };
    try {
      payload = await req.json();
    } catch {
      throw new HttpError(400, 'Bad request.');
    }
    const system = String(payload.system || '');
    const userMsg = String(payload.user || '');
    if (!userMsg.trim()) throw new HttpError(400, 'Empty prompt.');
    if (system.length + userMsg.length > MAX_INPUT * 2) throw new HttpError(400, 'Prompt too long.');

    // --- spend a credit atomically (the gate; checks kill switch + rate limit + balance) ---
    const { data: left, error: spendErr } = await asUser.rpc('pf_spend_credit', { p_model: FREE_MODEL });
    if (spendErr) {
      const m = spendErr.message || '';
      if (m.includes('no_credits')) throw new HttpError(402, 'Out of free credits — invite a friend to earn more.');
      if (m.includes('rate_limited')) throw new HttpError(429, 'Slow down — try again in a moment.');
      if (m.includes('free_tier_disabled')) throw new HttpError(503, 'Free tier is temporarily unavailable.');
      throw new HttpError(500, 'Could not start refinement.');
    }
    spent = true; // from here on, any failure refunds (in the catch below)

    // --- call OpenRouter with the SERVER key ---
    let r: Response;
    try {
      r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: FREE_MODEL,
          temperature: payload.temperature ?? 0.3,
          max_tokens: 2000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userMsg },
          ],
        }),
      });
    } catch {
      throw new HttpError(502, 'Network error reaching the model.');
    }
    if (!r.ok) throw new HttpError(502, 'Upstream model error — try again.');
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text.trim()) throw new HttpError(502, 'Model returned nothing — try again.');

    // Success — the credit is now truly earned. Confirm the referral (best-effort).
    try { await asUser.rpc('pf_confirm_first_use'); } catch (_) { /* best-effort */ }

    return json({ text, credits: left }, 200, origin);
  } catch (e) {
    // Any failure AFTER the credit was spent → give it back. No charge without delivery.
    if (spent && asUser) {
      try { await asUser.rpc('pf_refund_credit'); } catch (_) { /* best-effort */ }
    }
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof HttpError ? e.message : `Server error: ${(e as Error)?.message || e}`;
    return json({ error: message }, status, origin);
  }
});
