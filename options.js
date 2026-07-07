function flash(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// Saved sections show disabled fields + an ✎ edit icon instead of a Save button.
function setKeysMode(editing) {
  ['key-openrouter', 'key-anthropic'].forEach((id) => {
    document.getElementById(id).disabled = !editing;
  });
  document.getElementById('save-keys').hidden = !editing;
  document.getElementById('edit-keys').hidden = editing;
}

function setDefaultsMode(editing) {
  document.querySelectorAll('#defaults-card select, #defaults-card input').forEach((el) => {
    el.disabled = !editing;
  });
  document.getElementById('save-defaults').hidden = !editing;
  document.getElementById('clear-defaults').hidden = !editing;
  document.getElementById('edit-defaults').hidden = editing;
}

async function init() {
  const cfg = await getConfig();
  populateControls();
  applyParams(defaultParams(cfg.defaults));

  document.getElementById('key-openrouter').value = cfg.keys.openrouter || '';
  document.getElementById('key-anthropic').value = cfg.keys.anthropic || '';
  document.getElementById('template').value = cfg.template;

  setKeysMode(!(cfg.keys.openrouter || cfg.keys.anthropic));
  setDefaultsMode(!cfg.defaults);
  document.getElementById('edit-keys').onclick = () => setKeysMode(true);
  document.getElementById('edit-defaults').onclick = () => setDefaultsMode(true);

  document.getElementById('save-keys').onclick = async () => {
    await chrome.storage.local.set({
      keys: {
        openrouter: document.getElementById('key-openrouter').value.trim(),
        anthropic: document.getElementById('key-anthropic').value.trim(),
      },
    });
    setKeysMode(false);
    flash('Keys saved');
  };

  document.getElementById('save-defaults').onclick = async () => {
    await chrome.storage.sync.set({ defaults: readParams() });
    setDefaultsMode(false);
    flash('Defaults saved');
  };
  document.getElementById('clear-defaults').onclick = async () => {
    await chrome.storage.sync.remove('defaults');
    populateControls();
    setDefaultsMode(true);
    flash('Defaults cleared');
  };

  document.getElementById('save-template').onclick = async () => {
    await chrome.storage.sync.set({ template: document.getElementById('template').value });
    flash('Template saved');
  };
  document.getElementById('reset-template').onclick = async () => {
    await chrome.storage.sync.remove('template');
    document.getElementById('template').value = DEFAULT_TEMPLATE;
    flash('Template reset to default');
  };
}

init();
