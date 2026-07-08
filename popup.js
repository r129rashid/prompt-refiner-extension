// Popup + side panel (panel.html adds body.panel). Refine jobs run in the
// service worker (survive popup close); UI state lives in chrome.storage.session.

const $ = (id) => document.getElementById(id);

let picker;
let profilesState = { index: null, profiles: {} };
let hostname = null;
let currentOutput = ''; // active output (tweak/copy/save act on this)
let currentInput = '';
let draftTimer;

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

  // Restore everything from the last popup session (fix: popup amnesia).
  const ui = await getUiState();
  if (ui.draft) $('input').value = ui.draft;
  if (ui.params) {
    applyParams(defaultParams(ui.params), picker);
    if (ui.profileId && profilesState.profiles[ui.profileId]) $('profile').value = ui.profileId;
  }
  if (ui.lastOutput) showOutput(ui.lastOutput, ui.lastInput || '');
  showView(['history', 'library'].includes(ui.view) ? ui.view : 'home', false);

  renderHistory();
  renderLibrary();

  // Resume/adopt any job the worker ran while the popup was closed.
  const { job } = await chrome.storage.session.get('job');
  adoptJob(job);

  // Persist the draft and control choices as they change.
  $('input').addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => setUiState({ draft: $('input').value }), 300);
  });
  $('view-home').addEventListener('change', () => {
    setUiState({ params: readParams(), profileId: $('profile').value });
  });

  // Navigation (fix: no way back from History/Library).
  $('back-btn').onclick = () => showView('home');
  $('nav-history').onclick = () => showView('history');
  $('nav-library').onclick = () => showView('library');

  $('profile').addEventListener('change', () => {
    const p = profilesState.profiles[$('profile').value];
    if (p) applyParams(defaultParams(p.params), picker);
    syncSitePinToSelection();
  });

  $('open-options').onclick = () => chrome.runtime.openOptionsPage();

  // Side panel: feature-detect; popup only.
  if (chrome.sidePanel && !document.body.classList.contains('panel')) {
    $('open-panel').hidden = false;
    $('open-panel').onclick = async () => {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    };
  }

  $('copy-btn').onclick = async () => {
    // Copies what's rendered, so it also works mid-stream.
    await navigator.clipboard.writeText($('output').textContent);
    flashButton($('copy-btn'), 'Copied ✓', 'Copy');
  };

  // Save to library — inline name row (no modal dialogs in popups).
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
    } catch (e) {
      showError(e.message);
    }
  };

  $('lib-search').oninput = () => renderLibrary();

  // Tweak
  $('tweak').oninput = () => ($('tweak-btn').disabled = !$('tweak').value.trim());
  $('tweak-btn').disabled = true;
  $('tweak-btn').onclick = runTweak;
  $('tweak').onkeydown = (e) => {
    if (e.key === 'Enter' && $('tweak').value.trim()) runTweak();
  };

  // Variations paid-model note
  const updatePaidNote = () => {
    $('paid-note').hidden = !($('variations').checked && !$('model').value.endsWith(':free'));
  };
  $('variations').onchange = updatePaidNote;
  $('model').addEventListener('change', updatePaidNote);

  $('refine-btn').onclick = runRefine;

  // Live updates: job progress (session) + lists (local) + profiles (sync).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.job) adoptJob(changes.job.newValue);
    if (area === 'local' && changes.history) renderHistory(changes.history.newValue);
    if (area === 'local' && changes.library) renderLibrary();
    if (area === 'sync' && (changes.profilesIndex || Object.keys(changes).some((k) => k.startsWith('profile:')))) {
      refreshProfilesUI();
    }
  });
}

// ---- views ----
function showView(name, persist = true) {
  for (const v of ['home', 'history', 'library']) $('view-' + v).hidden = v !== name;
  $('back-btn').hidden = name === 'home';
  if (persist) setUiState({ view: name });
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

// ---- jobs: send to the worker, render from session storage ----
function runRefine() {
  const input = $('input').value.trim();
  if (!input) return showError('Enter a rough prompt first.');
  showError('');
  const params = readParams();
  const kind = $('variations').checked ? 'variations' : 'single';
  if (kind === 'single') $('cards').classList.add('hidden');
  else $('result').classList.add('hidden');
  chrome.runtime.sendMessage({ type: 'job', kind, input, params });
  setBusy(true);
}

function runTweak() {
  const instruction = $('tweak').value.trim();
  if (!instruction || !currentOutput) return;
  showError('');
  chrome.runtime.sendMessage({
    type: 'job',
    kind: 'tweak',
    input: currentInput,
    current: currentOutput,
    instruction,
    params: readParams(),
  });
  setBusy(true, $('tweak-btn'));
}

// Paint the popup from a job record (live updates and reopen-resume).
function adoptJob(job) {
  if (!job) return;

  if (job.kind === 'variations') {
    renderVariationJob(job);
  } else if (job.output !== undefined && job.status !== 'error') {
    showOutput(job.output, job.input, { partial: job.status !== 'done' });
  }

  if (job.status === 'running') {
    // ponytail: 3-min staleness cutoff — worker was killed mid-job, tell the user
    if (Date.now() - job.startedAt > 180000) {
      setBusy(false);
      showError('Something interrupted this refinement — try again.');
      chrome.storage.session.remove('job');
    } else {
      setBusy(true, job.kind === 'tweak' ? $('tweak-btn') : undefined);
    }
  } else if (job.status === 'done') {
    setBusy(false);
    if (job.kind !== 'variations') {
      showOutput(job.output, job.input);
      if (job.kind === 'tweak') {
        $('tweak').value = '';
        $('tweak-btn').disabled = true;
      }
      chrome.storage.session.remove('job');
    }
    // variations stay in the job until a card is picked, so reopen still shows them
  } else if (job.status === 'error') {
    setBusy(false);
    showError(job.error || 'Refinement failed.');
    chrome.storage.session.remove('job');
  }
}

function renderVariationJob(job) {
  $('result').classList.add('hidden');
  const cards = $('cards');
  cards.classList.remove('hidden');
  cards.innerHTML = '';
  (job.results || []).forEach((r, i) => {
    const card = document.createElement('div');
    card.className = 'card vcard';
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = 'ABC'[i];
    const txt = document.createElement('div');
    txt.className = 'vtxt';
    card.append(lbl, txt);
    if (r.status === 'done') {
      txt.textContent = r.output;
      const btn = document.createElement('button');
      btn.textContent = 'Use this';
      btn.onclick = async () => {
        cards.classList.add('hidden');
        showOutput(r.output, job.input);
        await pushHistory({ ts: Date.now(), input: job.input, params: job.params, output: r.output });
        chrome.storage.session.remove('job');
      };
      card.appendChild(btn);
    } else if (r.status === 'error') {
      txt.classList.add('errtxt');
      txt.textContent = r.error;
    } else {
      txt.classList.add('muted');
      txt.textContent = 'Refining…';
    }
    cards.appendChild(card);
  });
}

// ---- rendering ----
function showOutput(output, input, opts = {}) {
  $('result').classList.remove('hidden');
  $('output').textContent = output;
  if (!opts.partial) {
    currentOutput = output;
    currentInput = input;
    setUiState({ lastInput: input, lastOutput: output });
  }
}

function setBusy(busy, btn = $('refine-btn')) {
  btn.disabled = busy;
  $('refine-btn').classList.toggle('busy', busy);
  $('output').classList.toggle('pulsing', busy);
  if (btn === $('refine-btn')) btn.textContent = busy ? 'Refining…' : 'Refine';
  if (!busy) $('tweak-btn').disabled = !$('tweak').value.trim();
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
      showView('home');
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
    btn.onclick = () => {
      showOutput(snip.text, '');
      showView('home');
    };
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
