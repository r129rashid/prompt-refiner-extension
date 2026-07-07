// Shared logic for popup/panel, options, and background (via importScripts).
// Storage layout (schemaVersion 2):
//   sync:  profilesIndex {order, active}, profile:<id> {name, params},
//          template, siteMap {hostname: {profileId, lastUsed}}
//   local: keys {openrouter, anthropic}, history [25], library [100],
//          modelsCache {ts, ids}, modelsFetchMeta {backoffUntil}

const SCHEMA_VERSION = 2;
const HISTORY_CAP = 25;
const LIBRARY_CAP = 100;
const PROFILE_CAP = 20;
const SITEMAP_CAP = 100;
const INPUT_CAP = 8000;
const MODELS_TTL = 24 * 3600 * 1000;
const MODELS_BACKOFF = 3600 * 1000;

const PRESETS = {
  role: ['None', 'Financial Analyst', 'Software Engineer', 'Teacher', 'Marketing Expert', 'Copywriter', 'Data Scientist', 'Product Manager', 'Lawyer'],
  format: ['None', 'Step-by-step guide', 'Bullet points', 'Essay', 'Table', 'Email', 'Blog post', 'Q&A', 'Code with comments'],
  length: ['None', 'Under 100 words', 'Under 300 words', 'Under 500 words', '500-1000 words', 'As long as needed'],
  tone: ['None', 'Professional', 'Casual', 'Friendly', 'Formal', 'Persuasive', 'Humorous'],
  audience: ['None', 'Beginner', 'Intermediate', 'Expert', 'General public', 'Children', 'Executives'],
};
const EXTRAS = ['include examples', 'think step-by-step', 'avoid jargon', 'ask clarifying questions before answering'];

// Bundled fallback only — the live OpenRouter list comes from getModelList().
const FALLBACK_MODELS = {
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

const TWEAK_TEMPLATE = `You are an expert prompt engineer. You will receive an already-refined prompt and an instruction describing how to change it. Apply the instruction to the prompt.

## Output rules (strict)
- Return ONLY the revised prompt text.
- No preamble, no explanation, no commentary, no markdown code fences.
- Do not answer the prompt itself — only revise it.
- Write in the same language as the prompt.`;

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

function buildTweakMessage(current, instruction) {
  return `Current prompt:\n"""\n${current}\n"""\n\nInstruction: ${instruction}`;
}

function cleanResponse(text) {
  return text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

function defaultParams(saved) {
  const p = { provider: 'openrouter', model: FALLBACK_MODELS.openrouter[0], extras: [] };
  for (const k of Object.keys(PRESETS)) p[k] = 'None';
  return Object.assign(p, saved || {});
}

function uniqueName(name, taken) {
  if (!taken.includes(name)) return name;
  let n = 2;
  while (taken.includes(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}

// Extract the text delta from one parsed SSE payload. Pure — covered by test.js.
function extractDelta(provider, payload) {
  if (provider === 'openrouter') return payload.choices?.[0]?.delta?.content || '';
  return payload.type === 'content_block_delta' ? payload.delta?.text || '' : '';
}

function getHostname(url) {
  try {
    const h = new URL(url).hostname;
    return h || null;
  } catch {
    return null;
  }
}

// ---- basic storage ----
async function getConfig() {
  const sync = await chrome.storage.sync.get({ template: DEFAULT_TEMPLATE });
  const local = await chrome.storage.local.get({ keys: {}, history: [] });
  return { ...sync, ...local };
}

async function pushHistory(entry) {
  const { history } = await chrome.storage.local.get({ history: [] });
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_CAP) });
}

// ---- live model list (§1) ----
// Returns the best-known list synchronously-ish: cache if present, else fallback.
async function getModelList(provider) {
  if (provider !== 'openrouter') return FALLBACK_MODELS[provider] || [];
  const { modelsCache } = await chrome.storage.local.get({ modelsCache: null });
  return modelsCache?.ids?.length ? modelsCache.ids : FALLBACK_MODELS.openrouter;
}

// Fetch + cache the OpenRouter list. Returns fresh ids, or null if it couldn't refresh.
async function refreshModels(force) {
  const { modelsCache, modelsFetchMeta } = await chrome.storage.local.get({
    modelsCache: null,
    modelsFetchMeta: {},
  });
  const now = Date.now();
  if (!force && modelsCache && now - modelsCache.ts < MODELS_TTL) return modelsCache.ids;
  if (!force && (modelsFetchMeta.backoffUntil || 0) > now) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (res.status === 429) {
      await chrome.storage.local.set({ modelsFetchMeta: { backoffUntil: now + MODELS_BACKOFF } });
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    const ids = data.data.map((m) => m.id).filter((id) => typeof id === 'string').sort();
    if (!ids.length) return null;
    await chrome.storage.local.set({ modelsCache: { ts: now, ids }, modelsFetchMeta: {} });
    return ids;
  } catch {
    return null;
  }
}

// ---- profiles (§3) + site map (§8) ----
async function getProfiles() {
  const sync = await chrome.storage.sync.get(null);
  if (!sync.profilesIndex) {
    // Pre-migration read (background hasn't migrated yet) — synthesize Default.
    return {
      index: { order: ['default'], active: 'default' },
      profiles: { default: { name: 'Default', params: defaultParams(sync.defaults) } },
    };
  }
  const profiles = {};
  const order = sync.profilesIndex.order.filter((id) => sync['profile:' + id]);
  for (const id of order) profiles[id] = sync['profile:' + id];
  const active = profiles[sync.profilesIndex.active] ? sync.profilesIndex.active : order[0];
  return { index: { order, active }, profiles };
}

async function migrateStorage() {
  const sync = await chrome.storage.sync.get(null);
  if (sync.profilesIndex) return;
  await chrome.storage.sync.set({
    profilesIndex: { order: ['default'], active: 'default' },
    'profile:default': { name: 'Default', params: defaultParams(sync.defaults) },
    schemaVersion: SCHEMA_VERSION,
  });
  await chrome.storage.sync.remove('defaults');
}

async function getSiteMap() {
  return (await chrome.storage.sync.get({ siteMap: {} })).siteMap;
}

async function setSiteMapping(hostname, profileId) {
  const siteMap = await getSiteMap();
  if (profileId) {
    siteMap[hostname] = { profileId, lastUsed: Date.now() };
    const names = Object.keys(siteMap);
    if (names.length > SITEMAP_CAP) {
      const oldest = names.sort((a, b) => siteMap[a].lastUsed - siteMap[b].lastUsed)[0];
      delete siteMap[oldest];
    }
  } else {
    delete siteMap[hostname];
  }
  await chrome.storage.sync.set({ siteMap });
}

// Resolve the parameter set to use: explicit profile > site mapping > active profile.
async function resolveParams(hostname, profileId) {
  const { index, profiles } = await getProfiles();
  let id = profileId;
  let fromSite = false;
  if (!id && hostname) {
    const siteMap = await getSiteMap();
    const m = siteMap[hostname];
    if (m && profiles[m.profileId]) {
      id = m.profileId;
      fromSite = true;
      m.lastUsed = Date.now();
      chrome.storage.sync.set({ siteMap });
    } else if (m) {
      delete siteMap[hostname]; // mapped profile was deleted
      chrome.storage.sync.set({ siteMap });
    }
  }
  if (!id || !profiles[id]) id = index.active;
  return { params: defaultParams(profiles[id].params), profileId: id, fromSite, index, profiles };
}

// ---- library (§7) ----
async function getLibrary() {
  return (await chrome.storage.local.get({ library: [] })).library;
}

async function setLibrary(library) {
  await chrome.storage.local.set({ library });
}

async function saveSnippet(name, text) {
  name = (name || '').trim();
  if (!name) throw new Error('Name required.');
  const library = await getLibrary();
  if (library.length >= LIBRARY_CAP) throw new Error(`Library full (${LIBRARY_CAP}) — delete some snippets first.`);
  name = uniqueName(name, library.map((s) => s.name));
  library.unshift({ name, text, createdAt: Date.now(), lastUsed: Date.now() });
  await setLibrary(library);
  return name;
}

// ---- provider calls (§6 streaming; host_permissions bypass CORS) ----
function buildRequest({ provider, model, system, user, key, temperature, stream }) {
  if (provider === 'openrouter') {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: {
        model,
        temperature,
        max_tokens: 2000,
        stream,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      extract: (d) => d.choices?.[0]?.message?.content,
    };
  }
  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: { model, temperature, max_tokens: 2000, stream, system, messages: [{ role: 'user', content: user }] },
      extract: (d) => d.content?.[0]?.text,
    };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

// onToken (optional) receives the accumulated text after each delta; enables SSE.
async function callProvider({ provider, model, system, user, keys, temperature = 0.3, signal, onToken }) {
  const key = keys[provider];
  if (!key) throw new Error(`No ${provider} API key — add it in Options.`);
  const streaming = typeof onToken === 'function';
  const req = buildRequest({ provider, model, system, user, key, temperature, stream: streaming });

  let res;
  try {
    res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Network error — are you online?');
  }
  if (res.status === 401 || res.status === 403) throw new Error('API key rejected — check it in Options.');
  if (res.status === 429) throw new Error('Rate limited — try again in a moment.');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Provider error (${res.status})`);
  }

  if (!streaming) {
    const data = await res.json().catch(() => ({}));
    return req.extract(data) || '';
  }

  // SSE: buffer by newline; TextDecoder in stream mode handles split multibyte chars.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^data:\s*(.*)$/);
        if (!m || m[1] === '[DONE]') continue;
        let payload;
        try { payload = JSON.parse(m[1]); } catch { continue; }
        const delta = extractDelta(provider, payload);
        if (delta) {
          full += delta;
          onToken(full);
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    if (full) throw new Error('Stream interrupted — partial result shown.');
    throw new Error('Network error — are you online?');
  }
  return full;
}

// ---- refine (core flow) ----
// opts: { onToken, signal, temperature, saveHistory=true, iterated, system, user }
async function refine(input, params, opts = {}) {
  input = (input || '').trim();
  if (!input) throw new Error('Enter a rough prompt first.');
  if (input.length > INPUT_CAP) throw new Error(`Input too long (max ${INPUT_CAP.toLocaleString()} characters).`);
  const { template, keys } = await getConfig();
  const call = {
    provider: params.provider,
    model: params.model,
    system: opts.system || buildSystem(params, template),
    user: opts.user || buildUserMessage(input),
    keys,
    temperature: opts.temperature ?? 0.3,
    signal: opts.signal,
  };

  let raw;
  if (opts.onToken) {
    let gotTokens = false;
    try {
      raw = await callProvider({ ...call, onToken: (t) => { gotTokens = true; opts.onToken(t); } });
    } catch (e) {
      // Provider rejected stream:true (no tokens arrived) → one plain retry.
      if (e.name === 'AbortError' || gotTokens) throw e;
      raw = await callProvider(call);
    }
  } else {
    raw = await callProvider(call);
  }

  const output = cleanResponse(raw);
  if (!output) throw new Error('Model returned nothing — try another model.');
  if (opts.saveHistory !== false) {
    await pushHistory({ ts: Date.now(), input, params, output, iterated: !!opts.iterated });
  }
  return output;
}

// ---- iterate on a refined prompt (§5) ----
async function tweak(current, instruction, params, opts = {}) {
  instruction = (instruction || '').trim();
  if (!instruction) throw new Error('Enter a tweak instruction first.');
  if (current.length + instruction.length > INPUT_CAP) {
    throw new Error('Too long to iterate — start a new refinement.');
  }
  return refine(instruction, params, {
    ...opts,
    system: TWEAK_TEMPLATE,
    user: buildTweakMessage(current, instruction),
    iterated: true,
  });
}

// ---- DOM helpers (popup/panel + options; unused by background) ----
function populateControls() {
  for (const [name, options] of Object.entries(PRESETS)) {
    document.getElementById(name).innerHTML = options.map((o) => `<option>${o}</option>`).join('');
  }
  document.getElementById('extras').innerHTML = EXTRAS
    .map((e) => `<label class="check"><input type="checkbox" value="${e}"> ${e}</label>`)
    .join('');
  document.getElementById('provider').innerHTML = Object.keys(FALLBACK_MODELS)
    .map((p) => `<option>${p}</option>`)
    .join('');
}

// Wires the model <select> to the live list with a text filter + free-only toggle.
// els: { provider, model, filter, free } (DOM elements). Returns { render }.
function wireModelPicker(els) {
  let models = FALLBACK_MODELS.openrouter;

  function render(keepModel) {
    const provider = els.provider.value;
    const isOR = provider === 'openrouter';
    els.filter.hidden = !isOR;
    els.free.closest('label').hidden = !isOR;
    let list = isOR ? models : FALLBACK_MODELS[provider];
    if (isOR && els.free.checked) list = list.filter((m) => m.endsWith(':free'));
    const q = els.filter.value.trim().toLowerCase();
    if (isOR && q) list = list.filter((m) => m.toLowerCase().includes(q));

    const want = keepModel || els.model.value;
    els.model.innerHTML = '';
    if (want && !list.includes(want)) {
      // Never silently drop the user's saved model (§1) — keep it selectable, flagged.
      const o = document.createElement('option');
      o.value = want;
      o.textContent = `${want} (unavailable?)`;
      els.model.appendChild(o);
    }
    for (const m of list) {
      const o = document.createElement('option');
      o.value = o.textContent = m;
      els.model.appendChild(o);
    }
    if (want) els.model.value = want;
    if (!els.model.value && els.model.options.length) els.model.selectedIndex = 0;
  }

  els.provider.addEventListener('change', () => render());
  els.filter.addEventListener('input', () => render());
  els.free.addEventListener('change', () => render());

  (async () => {
    models = await getModelList('openrouter');
    render(els.model.value);
    const fresh = await refreshModels();
    if (fresh) {
      models = fresh;
      render(els.model.value);
    }
  })();

  return { render };
}

function readParams() {
  const p = {};
  for (const name of Object.keys(PRESETS)) p[name] = document.getElementById(name).value;
  p.extras = [...document.querySelectorAll('#extras input:checked')].map((c) => c.value);
  p.provider = document.getElementById('provider').value;
  p.model = document.getElementById('model').value;
  return p;
}

function applyParams(p, picker) {
  if (!p) return;
  for (const name of Object.keys(PRESETS)) {
    if (p[name]) document.getElementById(name).value = p[name];
  }
  document.querySelectorAll('#extras input').forEach((c) => {
    c.checked = (p.extras || []).includes(c.value);
  });
  if (p.provider && FALLBACK_MODELS[p.provider]) {
    document.getElementById('provider').value = p.provider;
  }
  if (picker) picker.render(p.model);
}
