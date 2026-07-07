async function init() {
  const cfg = await getConfig();
  populateControls();
  applyParams(defaultParams(cfg.defaults));
  renderHistory(cfg.history);

  document.getElementById('open-options').onclick = () => chrome.runtime.openOptionsPage();
  document.getElementById('copy-btn').onclick = async () => {
    await navigator.clipboard.writeText(document.getElementById('output').textContent);
    const btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied ✓';
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  };

  const btn = document.getElementById('refine-btn');
  btn.onclick = async () => {
    const errEl = document.getElementById('error');
    errEl.textContent = '';
    btn.disabled = true;
    btn.classList.add('busy');
    btn.textContent = 'Refining…';
    document.getElementById('output').classList.add('pulsing');
    try {
      const output = await refine(document.getElementById('input').value, readParams());
      showOutput(output);
      const { history } = await chrome.storage.local.get({ history: [] });
      renderHistory(history);
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
      btn.textContent = 'Refine';
      document.getElementById('output').classList.remove('pulsing');
    }
  };
}

function showOutput(output) {
  document.getElementById('result').classList.remove('hidden');
  document.getElementById('output').textContent = output;
}

function renderHistory(history) {
  const list = document.getElementById('history');
  if (!history.length) {
    list.innerHTML = '<li class="muted">No refinements yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const row of history) {
    const li = document.createElement('li');
    const excerpt = row.input.length > 60 ? row.input.slice(0, 60) + '…' : row.input;
    li.innerHTML = `<button class="restore">${excerpt}</button>`;
    li.querySelector('.restore').onclick = () => {
      document.getElementById('input').value = row.input;
      applyParams(row.params);
      showOutput(row.output);
    };
    list.appendChild(li);
  }
}

init();
