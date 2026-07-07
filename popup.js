// Popup + side panel (panel.html adds body.panel). Abort in-flight calls on close (§6).
const aborter = new AbortController();
addEventListener('unload', () => aborter.abort());

const $ = (id) => document.getElementById(id);

let picker;
let profilesState = { index: null, profiles: {} };
let hostname = null;
let currentOutput = ''; // active output (tweak/copy/save act on this)
let currentInput = '';

async function init() {
  // First-run onboarding: no API key yet → welcome card instead of the form.
  const { keys } = await getConfig();
  if (!keys.openrouter && !keys.anthropic) {
    $('app').hidden = true;
    $('onboard').hidden = false;
    $('onboard-cta').onclick = () => chrome.runtime.openOptionsPage();
    $('open-options').onclick = () => chrome.runtime.openOptionsPage();
    return;
  }

  populateControls();
  picker = wireModelPicker({
    provider: $('provider'),
    model: $('model'),
    filter: $('model-filter'),
    free: $('free-only'),
  });

  await refreshProfilesUI();
  await initSitePin();
  renderHistory();
  renderLibrary();

  $('profile').onchange = () => {
    const p = profilesState.profiles[$('profile').value];
    if (p) applyParams(defaultParams(p.params), picker);
    syncSitePinToSelection();
  };

  $('open-options').onclick = () => chrome.runtime.openOptionsPage();

  // Side panel (§9): feature-detect; popup only.
  if (chrome.sidePanel && !document.body.classList.contains('panel')) {
    $('open-panel').hidden = false;
    $('open-panel').onclick = async () => {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    };
  }

  $('copy-btn').onclick = async () => {
    // Copies what's rendered, so it also works mid-stream (§6).
    await navigator.clipboard.writeText($('output').textContent);
    flashButton($('copy-btn'), 'Copied ✓', 'Copy');
  };

  // Save to library (§7) — inline name row (no modal dialogs in popups).
  $('save-lib-btn').onclick = () => {
    $('save-lib-row').hidden = !$('save-lib-row').hidden;
    if (!$('save-lib-row').hidden) $('save-lib-name').focus();
  };
  $('save-lib-confirm').onclick = async () => {
    try {
      const name = await saveSnippet($('save-lib-name').value, currentOutput);
      $('save-lib-row').hidden = true;
      $('save-lib-name').value = '';
      showError('');
      flashButton($('save-lib-btn'), `Saved “${name}” ✓`, 'Save to library');
      renderLibrary();
    } catch (e) {
      showError(e.message);
    }
  };

  $('lib-search').oninput = () => renderLibrary();

  // Tweak (§5)
  $('tweak').oninput = () => ($('tweak-btn').disabled = !$('tweak').value.trim());
  $('tweak-btn').disabled = true;
  $('tweak-btn').onclick = runTweak;
  $('tweak').onkeydown = (e) => {
    if (e.key === 'Enter' && $('tweak').value.trim()) runTweak();
  };

  // Variations paid-model note (§10)
  const updatePaidNote = () => {
    $('paid-note').hidden = !($('variations').checked && !$('model').value.endsWith(':free'));
  };
  $('variations').onchange = updatePaidNote;
  $('model').addEventListener('change', updatePaidNote);

  $('refine-btn').onclick = runRefine;

  // Live-refresh lists when another surface (panel/popup/background) writes (§9).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.history) renderHistory(changes.history.newValue);
    if (area === 'local' && changes.library) renderLibrary();
    if (area === 'sync' && (changes.profilesIndex || Object.keys(changes).some((k) => k.startsWith('profile:')))) {
      refreshProfilesUI();
    }
  });
}

// ---- profiles + site pin ----
async function refreshProfilesUI() {
  const tab = await activeTab();
  hostname = tab ? getHostname(tab.url) : null;
  const resolved = await resolveParams(hostname, null);
  profilesState = { index: resolved.index, profiles: resolved.profiles };

  const sel = $('profile');
  sel.innerHTML = '';
  for (const id of resolved.index.order) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = resolved.profiles[id].name + (id === resolved.index.active ? ' (active)' : '');
    sel.appendChild(o);
  }
  sel.value = resolved.profileId;
  applyParams(resolved.params, picker);
}

async function initSitePin() {
  if (!hostname) return;
  $('site-pin-wrap').hidden = false;
  $('site-pin-label').textContent = `use on ${hostname}`;
  await syncSitePinToSelection();
  $('site-pin').onchange = async () => {
    await setSiteMapping(hostname, $('site-pin').checked ? $('profile').value : null);
  };
}

async function syncSitePinToSelection() {
  if (!hostname) return;
  const siteMap = await getSiteMap();
  $('site-pin').checked = siteMap[hostname]?.profileId === $('profile').value;
}

async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

// ---- refine (single + variations) ----
async function runRefine() {
  const input = $('input').value;
  const params = readParams();
  showError('');
  setBusy(true);
  try {
    if ($('variations').checked) await runVariations(input, params);
    else await runSingle(input, params);
  } catch (e) {
    if (e.name !== 'AbortError') showError(e.message);
  } finally {
    setBusy(false);
  }
}

async function runSingle(input, params) {
  $('cards').classList.add('hidden');
  let streamed = false;
  try {
    const output = await refine(input, params, {
      signal: aborter.signal,
      onToken: (t) => {
        streamed = true;
        showOutput(t, input, { partial: true });
      },
    });
    showOutput(output, input);
  } catch (e) {
    // Keep the partial visible on stream interruption (§6); rethrow for the error line.
    if (!streamed) $('result').classList.add('hidden');
    throw e;
  }
}

async function runVariations(input, params) {
  $('result').classList.add('hidden');
  const cards = $('cards');
  cards.classList.remove('hidden');
  cards.innerHTML = [0, 1, 2]
    .map((i) => `<div class="card vcard" id="vcard-${i}"><div class="lbl">${'ABC'[i]}</div><div class="vtxt muted">Refining…</div></div>`)
    .join('');

  const temps = [0.3, 0.7, 0.9];
  const results = await Promise.all(
    temps.map((temperature, i) =>
      // 300ms stagger softens provider rate limits on parallel calls (§10)
      new Promise((r) => setTimeout(r, i * 300)).then(() =>
        refine(input, params, { temperature, saveHistory: false, signal: aborter.signal }).then(
          (out) => ({ ok: true, out }),
          (e) => ({ ok: false, err: e.message })
        )
      )
    )
  );

  let anyOk = false;
  results.forEach((r, i) => {
    const card = $(`vcard-${i}`);
    const txt = card.querySelector('.vtxt');
    if (r.ok) {
      anyOk = true;
      txt.classList.remove('muted');
      txt.textContent = r.out;
      const btn = document.createElement('button');
      btn.textContent = 'Use this';
      btn.onclick = async () => {
        cards.classList.add('hidden');
        showOutput(r.out, input);
        await pushHistory({ ts: Date.now(), input: input.trim(), params, output: r.out });
      };
      card.appendChild(btn);
    } else {
      txt.textContent = r.err;
      txt.classList.add('errtxt');
    }
  });
  if (!anyOk) {
    cards.classList.add('hidden');
    throw new Error(results[0].err);
  }
}

async function runTweak() {
  const instruction = $('tweak').value;
  const params = readParams();
  showError('');
  setBusy(true, $('tweak-btn'));
  try {
    const output = await tweak(currentOutput, instruction, params, {
      signal: aborter.signal,
      onToken: (t) => showOutput(t, currentInput, { partial: true }),
    });
    showOutput(output, currentInput);
    $('tweak').value = '';
    $('tweak-btn').disabled = true;
  } catch (e) {
    if (e.name !== 'AbortError') showError(e.message);
  } finally {
    setBusy(false, $('tweak-btn'));
  }
}

// ---- rendering ----
function showOutput(output, input, opts = {}) {
  $('result').classList.remove('hidden');
  $('output').textContent = output;
  if (!opts.partial) {
    currentOutput = output;
    currentInput = input;
  }
}

function setBusy(busy, btn = $('refine-btn')) {
  btn.disabled = busy;
  $('refine-btn').classList.toggle('busy', busy);
  $('output').classList.toggle('pulsing', busy);
  if (btn === $('refine-btn')) btn.textContent = busy ? 'Refining…' : 'Refine';
}

function showError(msg) {
  $('error').textContent = msg;
}

function flashButton(btn, flashText, normalText) {
  btn.textContent = flashText;
  setTimeout(() => (btn.textContent = normalText), 1500);
}

async function renderHistory(history) {
  if (!history) history = (await chrome.storage.local.get({ history: [] })).history;
  const list = $('history');
  if (!history.length) {
    list.innerHTML = '<li class="muted">No refinements yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const row of history) {
    const li = document.createElement('li');
    const prefix = row.iterated ? '↻ ' : '';
    const excerpt = row.input.length > 60 ? row.input.slice(0, 60) + '…' : row.input;
    const btn = document.createElement('button');
    btn.className = 'restore';
    btn.textContent = prefix + excerpt;
    btn.onclick = () => {
      $('input').value = row.iterated ? '' : row.input;
      applyParams(row.params, picker);
      showOutput(row.output, row.input);
    };
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function renderLibrary() {
  const list = $('library');
  const q = $('lib-search').value.trim().toLowerCase();
  let library = await getLibrary();
  if (q) {
    library = library.filter(
      (s) => s.name.toLowerCase().includes(q) || s.text.toLowerCase().includes(q)
    );
  }
  if (!library.length) {
    list.innerHTML = `<li class="muted">${q ? 'No matches.' : 'No snippets yet — refine something and save it.'}</li>`;
    return;
  }
  list.innerHTML = '';
  for (const snip of library) {
    const li = document.createElement('li');
    li.className = 'librow';
    const btn = document.createElement('button');
    btn.className = 'restore';
    btn.textContent = snip.name;
    btn.title = snip.text.slice(0, 200);
    btn.onclick = () => showOutput(snip.text, '');
    const copy = document.createElement('button');
    copy.className = 'icon';
    copy.textContent = '⧉';
    copy.title = 'Copy';
    copy.onclick = () => navigator.clipboard.writeText(snip.text);
    li.append(btn, copy);
    list.appendChild(li);
  }
}

init();
