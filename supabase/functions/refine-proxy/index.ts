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

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });
  try {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);

  // --- auth: verify the caller's JWT ---
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in to use Promptify Free.' }, 401, origin);

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'Session expired — sign in again.' }, 401, origin);

  // --- validate input ---
  let payload: { system?: string; user?: string; temperature?: number };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Bad request.' }, 400, origin);
  }
  const system = String(payload.system || '');
  const userMsg = String(payload.user || '');
  if (!userMsg.trim()) return json({ error: 'Empty prompt.' }, 400, origin);
  if (system.length + userMsg.length > MAX_INPUT * 2) return json({ error: 'Prompt too long.' }, 400, origin);

  // --- spend a credit atomically (this is the gate; RLS uses the user's JWT) ---
  const { data: left, error: spendErr } = await asUser.rpc('pf_spend_credit', { p_model: FREE_MODEL });
  if (spendErr) {
    const msg = spendErr.message || '';
    if (msg.includes('no_credits'))
      return json({ error: 'Out of free credits — invite a friend to earn more.' }, 402, origin);
    if (msg.includes('rate_limited')) return json({ error: 'Slow down — try again in a moment.' }, 429, origin);
    if (msg.includes('free_tier_disabled'))
      return json({ error: 'Free tier is temporarily unavailable.' }, 503, origin);
    return json({ error: 'Could not start refinement.' }, 500, origin);
  }

  // --- call OpenRouter with the SERVER key; refund on failure ---
  const refund = () => asUser.rpc('pf_refund_credit');
  let text = '';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
    if (!r.ok) {
      await refund();
      return json({ error: 'Upstream model error — try again.' }, 502, origin);
    }
    const data = await r.json();
    text = data.choices?.[0]?.message?.content || '';
    if (!text.trim()) {
      await refund();
      return json({ error: 'Model returned nothing — try again.' }, 502, origin);
    }
  } catch {
    await refund();
    return json({ error: 'Network error reaching the model.' }, 502, origin);
  }

  // --- confirm first successful use → credit the inviter (idempotent, capped) ---
  // rpc() returns a thenable without a .catch method — await and swallow errors.
  try { await asUser.rpc('pf_confirm_first_use'); } catch (_) { /* best-effort */ }

  return json({ text, credits: left }, 200, origin);
  } catch (e) {
    return json({ error: `Server error: ${(e as Error)?.message || e}` }, 500, origin);
  }
});
