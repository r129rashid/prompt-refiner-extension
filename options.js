const $ = (id) => document.getElementById(id);

function flash(msg) {
  const el = $('status');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// Saved sections show disabled fields + an ✎ edit icon instead of a Save button.
function setKeysMode(editing) {
  ['key-openrouter', 'key-anthropic'].forEach((id) => ($(id).disabled = !editing));
  $('save-keys').hidden = !editing;
  $('edit-keys').hidden = editing;
}

function setProfileMode(editing) {
  document
    .querySelectorAll('#profiles-card select:not(#profile-select), #profiles-card input:not(#model-filter)')
    .forEach((el) => (el.disabled = !editing));
  $('save-profile').hidden = !editing;
  $('edit-profile').hidden = editing;
}

let picker;
let profilesState;
let selectedId;

async function init() {
  $('back-btn').onclick = async () => {
    // Opened inside the side panel → navigate back to the main view in the dock.
    if (new URLSearchParams(location.search).get('from') === 'panel') {
      location.href = 'panel.html';
      return;
    }
    // Opened as a standalone tab (right-click → Options) → close the tab.
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) return chrome.tabs.remove(tab.id);
    } catch {}
    window.close();
  };

  const cfg = await getConfig();
  populateControls();
  picker = wireModelPicker({
    provider: $('provider'),
    model: $('model'),
    filter: $('model-filter'),
    free: $('free-only'),
  });

  // keys
  $('key-openrouter').value = cfg.keys.openrouter || '';
  $('key-anthropic').value = cfg.keys.anthropic || '';
  setKeysMode(!(cfg.keys.openrouter || cfg.keys.anthropic));
  $('edit-keys').onclick = () => setKeysMode(true);
  $('save-keys').onclick = async () => {
    await chrome.storage.local.set({
      keys: {
        openrouter: $('key-openrouter').value.trim(),
        anthropic: $('key-anthropic').value.trim(),
      },
    });
    setKeysMode(false);
    flash('Keys saved');
  };

  // profiles
  await loadProfiles();
  setProfileMode(false);
  $('edit-profile').onclick = () => setProfileMode(true);
  $('profile-select').onchange = () => selectProfile($('profile-select').value);
  $('new-profile').onclick = newProfile;
  $('delete-profile').onclick = deleteProfile;
  $('set-active').onclick = setActive;
  $('save-profile').onclick = saveCurrentProfile;

  // models
  $('refresh-models').onclick = async () => {
    $('refresh-models').disabled = true;
    const ids = await refreshModels(true);
    $('refresh-models').disabled = false;
    if (ids) {
      $('models-status').textContent = `${ids.length} OpenRouter models — refreshed just now.`;
      picker.render($('model').value);
      flash('Model list refreshed');
    } else {
      flash("Couldn't refresh models — using the cached list.");
    }
  };
  const { modelsCache } = await chrome.storage.local.get({ modelsCache: null });
  if (modelsCache) {
    $('models-status').textContent =
      `${modelsCache.ids.length} OpenRouter models — last refreshed ${new Date(modelsCache.ts).toLocaleString()}.`;
  }

  $('shortcut-url').onclick = () => {
    $('shortcut-url').select();
    navigator.clipboard.writeText('chrome://extensions/shortcuts');
    flash('Copied');
  };

  renderSiteMap();
  renderLibrary();
  $('export-lib').onclick = exportLibrary;
  $('import-lib').onclick = () => $('import-file').click();
  $('import-file').onchange = importLibrary;

  // template
  $('template').value = cfg.template;
  $('save-template').onclick = async () => {
    await chrome.storage.sync.set({ template: $('template').value });
    flash('Template saved');
  };
  $('reset-template').onclick = async () => {
    await chrome.storage.sync.remove('template');
    $('template').value = DEFAULT_TEMPLATE;
    flash('Template reset to default');
  };
}

// ---- profiles ----
async function loadProfiles(keepSelected) {
  await migrateStorage(); // safe if already migrated; guarantees Default exists
  profilesState = await getProfiles();
  const sel = $('profile-select');
  sel.innerHTML = '';
  for (const id of profilesState.index.order) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = profilesState.profiles[id].name + (id === profilesState.index.active ? ' (active)' : '');
    sel.appendChild(o);
  }
  selectProfile(keepSelected && profilesState.profiles[keepSelected] ? keepSelected : profilesState.index.active);
}

function selectProfile(id) {
  selectedId = id;
  $('profile-select').value = id;
  const p = profilesState.profiles[id];
  $('profile-name').value = p.name;
  applyParams(defaultParams(p.params), picker);
  $('delete-profile').disabled = id === 'default';
}

async function newProfile() {
  if (profilesState.index.order.length >= PROFILE_CAP) {
    return flash(`Profile limit (${PROFILE_CAP}) reached — delete one first.`);
  }
  const id = 'p_' + Date.now().toString(36);
  const name = uniqueName('New profile', Object.values(profilesState.profiles).map((p) => p.name));
  await chrome.storage.sync.set({
    ['profile:' + id]: { name, params: defaultParams(null) },
    profilesIndex: { ...profilesState.index, order: [...profilesState.index.order, id] },
  });
  await loadProfiles(id);
  setProfileMode(true);
  $('profile-name').focus();
}

async function deleteProfile() {
  if (selectedId === 'default') return;
  if (!confirm(`Delete profile "${profilesState.profiles[selectedId].name}"?`)) return;
  const order = profilesState.index.order.filter((id) => id !== selectedId);
  const active = profilesState.index.active === selectedId ? 'default' : profilesState.index.active;
  await chrome.storage.sync.remove('profile:' + selectedId);
  await chrome.storage.sync.set({ profilesIndex: { order, active } });
  await loadProfiles();
  renderSiteMap(); // mappings to this profile now resolve to Default
  flash('Profile deleted');
}

async function setActive() {
  await chrome.storage.sync.set({ profilesIndex: { ...profilesState.index, active: selectedId } });
  await loadProfiles(selectedId);
  flash('Active profile set');
}

async function saveCurrentProfile() {
  const name = $('profile-name').value.trim();
  if (!name) return flash('Profile name required.');
  const others = profilesState.index.order
    .filter((id) => id !== selectedId)
    .map((id) => profilesState.profiles[id].name);
  await chrome.storage.sync.set({
    ['profile:' + selectedId]: { name: uniqueName(name, others), params: readParams() },
  });
  await loadProfiles(selectedId);
  setProfileMode(false);
  flash('Profile saved');
}

// ---- site map ----
async function renderSiteMap() {
  const siteMap = await getSiteMap();
  const { profiles } = await getProfiles();
  const list = $('site-map');
  const hosts = Object.keys(siteMap);
  if (!hosts.length) {
    list.innerHTML = '<li class="muted">No site pins yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const host of hosts.sort()) {
    const li = document.createElement('li');
    li.className = 'librow';
    const span = document.createElement('span');
    span.className = 'grow';
    span.textContent = `${host} → ${profiles[siteMap[host].profileId]?.name || 'Default'}`;
    const del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '✕';
    del.title = 'Remove';
    del.onclick = async () => {
      await setSiteMapping(host, null);
      renderSiteMap();
    };
    li.append(span, del);
    list.appendChild(li);
  }
}

// ---- library ----
async function renderLibrary() {
  const library = await getLibrary();
  const list = $('library');
  if (!library.length) {
    list.innerHTML = '<li class="muted">No snippets yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const snip of library) {
    const li = document.createElement('li');
    li.className = 'librow';
    const span = document.createElement('span');
    span.className = 'grow';
    span.textContent = snip.name;
    span.title = snip.text.slice(0, 300);
    const copy = mkIcon('⧉', 'Copy', () => navigator.clipboard.writeText(snip.text).then(() => flash('Copied')));
    const ren = mkIcon('✎', 'Rename', async () => {
      const name = prompt('New name:', snip.name);
      if (!name?.trim()) return;
      const library2 = await getLibrary();
      const target = library2.find((s) => s.name === snip.name);
      if (!target) return;
      target.name = uniqueName(name.trim(), library2.filter((s) => s !== target).map((s) => s.name));
      await setLibrary(library2);
      renderLibrary();
    });
    const del = mkIcon('✕', 'Delete', async () => {
      await setLibrary((await getLibrary()).filter((s) => s.name !== snip.name));
      renderLibrary();
    });
    li.append(span, copy, ren, del);
    list.appendChild(li);
  }
}

function mkIcon(txt, title, onclick) {
  const b = document.createElement('button');
  b.className = 'icon';
  b.textContent = txt;
  b.title = title;
  b.onclick = onclick;
  return b;
}

async function exportLibrary() {
  const library = await getLibrary();
  const url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'promptify-library.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importLibrary() {
  const file = $('import-file').files[0];
  $('import-file').value = '';
  if (!file) return;
  let imported;
  try {
    imported = JSON.parse(await file.text());
    if (!Array.isArray(imported) || imported.some((s) => typeof s?.name !== 'string' || typeof s?.text !== 'string')) {
      throw new Error();
    }
  } catch {
    return flash('Invalid library file — nothing imported.');
  }
  const library = await getLibrary();
  for (const snip of imported) {
    if (library.length >= LIBRARY_CAP) break;
    library.push({
      name: uniqueName(snip.name, library.map((s) => s.name)),
      text: snip.text,
      createdAt: snip.createdAt || Date.now(),
      lastUsed: 0,
    });
  }
  await setLibrary(library);
  renderLibrary();
  flash(`Imported ${imported.length} snippet(s)`);
}

init();
