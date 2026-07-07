function flash(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

async function init() {
  const cfg = await getConfig();
  populateControls();
  applyParams(defaultParams(cfg.defaults));

  document.getElementById('key-openrouter').value = cfg.keys.openrouter || '';
  document.getElementById('key-anthropic').value = cfg.keys.anthropic || '';
  document.getElementById('template').value = cfg.template;

  document.getElementById('save-keys').onclick = async () => {
    await chrome.storage.local.set({
      keys: {
        openrouter: document.getElementById('key-openrouter').value.trim(),
        anthropic: document.getElementById('key-anthropic').value.trim(),
      },
    });
    flash('Keys saved');
  };

  document.getElementById('save-defaults').onclick = async () => {
    await chrome.storage.sync.set({ defaults: readParams() });
    flash('Defaults saved');
  };
  document.getElementById('clear-defaults').onclick = async () => {
    await chrome.storage.sync.remove('defaults');
    populateControls();
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
