// Shared logic for popup, options, and background (via importScripts).
// Constants and pure helpers mirror public/app.js in the web app.

const PRESETS = {
  role: ['None', 'Financial Analyst', 'Software Engineer', 'Teacher', 'Marketing Expert', 'Copywriter', 'Data Scientist', 'Product Manager', 'Lawyer'],
  format: ['None', 'Step-by-step guide', 'Bullet points', 'Essay', 'Table', 'Email', 'Blog post', 'Q&A', 'Code with comments'],
  length: ['None', 'Under 100 words', 'Under 300 words', 'Under 500 words', '500-1000 words', 'As long as needed'],
  tone: ['None', 'Professional', 'Casual', 'Friendly', 'Formal', 'Persuasive', 'Humorous'],
  audience: ['None', 'Beginner', 'Intermediate', 'Expert', 'General public', 'Children', 'Executives'],
};
const EXTRAS = ['include examples', 'think step-by-step', 'avoid jargon', 'ask clarifying questions before answering'];
const MODELS = {
  openrouter: [
    'nvidia/nemotron-3-super-120b-a12b:free',
    'openai/gpt-4o-mini',
    'anthropic/claude-sonnet-5',
  ],
  anthropic: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'],
};

const DEFAULT_TEMPLATE = `You are an expert prompt engineer. Your only job is to rewrite rough, vague, or poorly structured prompts into clear, specific, high-quality prompts that get better results from AI models.

You will receive:
1. A rough prompt written by a user
2. A set of refinement parameters

Rewrite the rough prompt into a polished prompt that incorporates ALL of the parameters below.

## Refinement parameters
- Role the AI should adopt: {{ROLE}}
- Required output format: {{FORMAT}}
- Length constraint: {{LENGTH}}
- Tone: {{TONE}}
- Target audience: {{AUDIENCE}}
- Extra requirements: {{EXTRAS}}

## Rules for the refined prompt
1. Start the refined prompt with the role instruction (e.g., "Act as a {{ROLE}}...") unless role is "None".
2. Preserve the user's original intent exactly — never change WHAT they're asking for, only make it clearer and more specific.
3. If the rough prompt is ambiguous, make reasonable assumptions and state them inside the refined prompt as explicit context (e.g., "Assume the reader has no prior knowledge of X").
4. Convert vague requests into concrete, measurable instructions (e.g., "make it good" → "use clear headings, short paragraphs, and one example per concept").
5. Explicitly state the output format and length constraint inside the refined prompt.
6. Add a "What to avoid" line if the extras or the rough prompt imply common failure modes.
7. Structure the refined prompt in this order: Role → Context → Task → Constraints (format, length, tone, audience) → Extras → What to avoid.
8. The refined prompt must be self-contained — usable in a brand-new chat with zero prior context.

## Output rules (strict)
- Return ONLY the refined prompt text.
- No preamble, no explanation, no commentary, no markdown code fences around it, no "Here is your refined prompt:".
- Do not answer the prompt itself — only rewrite it.
- Write in the same language as the user's rough prompt.`;

// ---- pure helpers ----
function buildSystem(params, template) {
  return (template || DEFAULT_TEMPLATE)
    .replaceAll('{{ROLE}}', params.role)
    .replaceAll('{{FORMAT}}', params.format)
    .replaceAll('{{LENGTH}}', params.length)
    .replaceAll('{{TONE}}', params.tone)
    .replaceAll('{{AUDIENCE}}', params.audience)
    .replaceAll('{{EXTRAS}}', params.extras.length ? params.extras.join(', ') : 'None');
}

function buildUserMessage(input) {
  return `Rough prompt to refine:\n"""\n${input}\n"""`;
}

function cleanResponse(text) {
  return text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

function defaultParams(saved) {
  const p = { provider: 'openrouter', model: MODELS.openrouter[0], extras: [] };
  for (const k of Object.keys(PRESETS)) p[k] = 'None';
  return Object.assign(p, saved || {});
}

// ---- storage ----
async function getConfig() {
  const sync = await chrome.storage.sync.get({ defaults: null, template: DEFAULT_TEMPLATE });
  const local = await chrome.storage.local.get({ keys: {}, history: [] });
  return { ...sync, ...local };
}

async function pushHistory(entry) {
  const { history } = await chrome.storage.local.get({ history: [] });
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, 25) });
}

// ---- provider calls (direct; host_permissions bypass CORS) ----
async function callProvider({ provider, model, system, user, keys }) {
  const key = keys[provider];
  if (!key) throw new Error(`No ${provider} API key — add it in Options.`);

  let url, headers, body, extract;
  if (provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    body = {
      model,
      temperature: 0.3,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    extract = (d) => d.choices?.[0]?.message?.content;
  } else if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    body = {
      model,
      temperature: 0.3,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: user }],
    };
    extract = (d) => d.content?.[0]?.text;
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new Error('Network error — are you online?');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error('API key rejected — check it in Options.');
  if (res.status === 429) throw new Error('Rate limited — try again in a moment.');
  if (!res.ok) throw new Error(data.error?.message || `Provider error (${res.status})`);
  return extract(data) || '';
}

async function refine(input, params) {
  input = (input || '').trim();
  if (!input) throw new Error('Enter a rough prompt first.');
  if (input.length > 8000) throw new Error('Input too long (max 8,000 characters).');
  const { template, keys } = await getConfig();
  const raw = await callProvider({
    provider: params.provider,
    model: params.model,
    system: buildSystem(params, template),
    user: buildUserMessage(input),
    keys,
  });
  const output = cleanResponse(raw);
  if (!output) throw new Error('Model returned nothing — try another model.');
  await pushHistory({ ts: Date.now(), input, params, output });
  return output;
}

// ---- DOM helpers (popup + options; unused by background) ----
function populateControls() {
  for (const [name, options] of Object.entries(PRESETS)) {
    document.getElementById(name).innerHTML = options.map((o) => `<option>${o}</option>`).join('');
  }
  document.getElementById('extras').innerHTML = EXTRAS
    .map((e) => `<label class="check"><input type="checkbox" value="${e}"> ${e}</label>`)
    .join('');
  const prov = document.getElementById('provider');
  prov.innerHTML = Object.keys(MODELS).map((p) => `<option>${p}</option>`).join('');
  prov.onchange = () => populateModels(prov.value);
  populateModels(prov.value);
}

function populateModels(provider, selected) {
  const sel = document.getElementById('model');
  sel.innerHTML = MODELS[provider].map((m) => `<option>${m}</option>`).join('');
  if (selected && MODELS[provider].includes(selected)) sel.value = selected;
}

function readParams() {
  const p = {};
  for (const name of Object.keys(PRESETS)) p[name] = document.getElementById(name).value;
  p.extras = [...document.querySelectorAll('#extras input:checked')].map((c) => c.value);
  p.provider = document.getElementById('provider').value;
  p.model = document.getElementById('model').value;
  return p;
}

function applyParams(p) {
  if (!p) return;
  for (const name of Object.keys(PRESETS)) {
    if (p[name]) document.getElementById(name).value = p[name];
  }
  document.querySelectorAll('#extras input').forEach((c) => {
    c.checked = (p.extras || []).includes(c.value);
  });
  if (p.provider && MODELS[p.provider]) {
    document.getElementById('provider').value = p.provider;
    populateModels(p.provider, p.model);
  }
}
