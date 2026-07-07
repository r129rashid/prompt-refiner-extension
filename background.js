importScripts('shared.js');

chrome.runtime.onInstalled.addListener(async () => {
  await migrateStorage();
  queueMenuRebuild();
});
chrome.runtime.onStartup.addListener(queueMenuRebuild);

// Rebuild menus when profiles or library change (serialized to avoid duplicate-id races).
chrome.storage.onChanged.addListener((changes, area) => {
  const profileChange = area === 'sync' &&
    (changes.profilesIndex || Object.keys(changes).some((k) => k.startsWith('profile:')));
  const libraryChange = area === 'local' && changes.library;
  if (profileChange || libraryChange) queueMenuRebuild();
});

let menuQueue = Promise.resolve();
function queueMenuRebuild() {
  menuQueue = menuQueue.then(rebuildMenus).catch(() => {});
}

async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  const { index, profiles } = await getProfiles();
  if (index.order.length === 1) {
    chrome.contextMenus.create({ id: 'refine:' + index.order[0], title: 'Refine prompt', contexts: ['selection'] });
  } else {
    chrome.contextMenus.create({ id: 'refine-parent', title: 'Refine prompt', contexts: ['selection'] });
    for (const id of index.order) {
      chrome.contextMenus.create({
        id: 'refine:' + id,
        parentId: 'refine-parent',
        title: profiles[id].name + (id === index.active ? ' ✓' : ''),
        contexts: ['selection'],
      });
    }
  }
  const recent = (await getLibrary()).slice().sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 10);
  if (recent.length) {
    chrome.contextMenus.create({ id: 'library-parent', title: 'Insert snippet', contexts: ['editable'] });
    for (const s of recent) {
      chrome.contextMenus.create({
        id: 'snippet:' + s.name,
        parentId: 'library-parent',
        title: s.name,
        contexts: ['editable'],
      });
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id.startsWith('snippet:')) return insertSnippet(id.slice(8), tab);
  if (!id.startsWith('refine:')) return;
  // Explicit submenu pick skips site-mapping; the single-profile item uses it.
  const explicit = info.parentMenuItemId === 'refine-parent';
  runRefineFlow(tab, info.selectionText, explicit ? id.slice(7) : null);
});

// ---- keyboard shortcut (§2) ----
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'refine-selection') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  let selection;
  try {
    [{ result: selection }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readSelectionInPage,
    });
  } catch {
    return notify("Promptify can't run on this page.");
  }
  if (!(selection || '').trim()) {
    return pageToast(tab.id, 'Select some text first.').catch(() => {});
  }
  runRefineFlow(tab, selection, null);
});

function notify(message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'Promptify', message });
}

// ---- refine flow shared by context menu + hotkey ----
// ponytail: transient in-flight guard; resets if the service worker sleeps, which is fine
const pendingTabs = new Set();

async function runRefineFlow(tab, selectionText, profileId) {
  if (!tab?.id || pendingTabs.has(tab.id)) return;
  const text = (selectionText || '').trim();
  if (!text) return pageToast(tab.id, 'Select some text first.').catch(() => {});
  pendingTabs.add(tab.id);
  try {
    await pageToast(tab.id, 'Refining…', true);
    const { params } = await resolveParams(getHostname(tab.url), profileId);
    const output = await refine(text, params);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showPreviewInPage,
      args: [text, output],
    });
  } catch (e) {
    await pageToast(tab.id, e.message).catch(() => notify(e.message));
  } finally {
    pendingTabs.delete(tab.id);
  }
}

function pageToast(tabId, message, sticky) {
  return chrome.scripting.executeScript({ target: { tabId }, func: toastInPage, args: [message, !!sticky] });
}

async function insertSnippet(name, tab) {
  if (!tab?.id) return;
  const library = await getLibrary();
  const snip = library.find((s) => s.name === name);
  if (!snip) return;
  snip.lastUsed = Date.now();
  await setLibrary(library);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: insertTextInPage, args: [snip.text] });
  } catch {
    notify("Promptify can't run on this page.");
  }
}

// =====================================================================
// Injected functions — run inside the page, no access to outer scope.
// =====================================================================

function readSelectionInPage() {
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') &&
      typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd) {
    return el.value.substring(el.selectionStart, el.selectionEnd);
  }
  return window.getSelection()?.toString() || '';
}

function toastInPage(message, sticky) {
  let t = document.getElementById('__pf_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '__pf_toast';
    t.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:320px;' +
      'background:#151821;color:#e8eaf0;padding:10px 14px;border-radius:8px;' +
      'border-left:3px solid #6366f1;font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.45);transition:opacity .2s;opacity:0';
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => (t.style.opacity = '1'));
  }
  t.textContent = message;
  t.style.opacity = '1';
  clearTimeout(t._hide);
  if (!sticky) {
    t._hide = setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 3500);
  }
}

function insertTextInPage(text) {
  function toast(msg) {
    const t = document.createElement('div');
    t.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:320px;' +
      'background:#151821;color:#e8eaf0;padding:10px 14px;border-radius:8px;' +
      'border-left:3px solid #6366f1;font:13px/1.4 -apple-system,sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.45)';
    t.textContent = msg;
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }
  const el = document.activeElement;
  let done = false;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && typeof el.selectionStart === 'number') {
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    done = true;
  } else if (el && el.isContentEditable) {
    done = document.execCommand('insertText', false, text);
  }
  if (done) toast('Inserted ✓');
  else navigator.clipboard.writeText(text).then(
    () => toast('Snippet copied — click into a text field to paste.'),
    () => toast('Could not insert the snippet.')
  );
}

// Preview & undo overlay (§4). Captures the target field at show time, verifies
// the selection is unchanged before replacing, and offers a 5s Undo after Accept.
function showPreviewInPage(original, refined) {
  // Dismiss the toast and any previous overlay.
  document.getElementById('__pf_toast')?.remove();
  window.__pfCleanup?.();

  const target = document.activeElement;

  const host = document.createElement('div');
  host.id = '__pf_host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .box{position:fixed;bottom:16px;right:16px;z-index:2147483647;width:min(560px,calc(100vw - 32px));
        max-height:70vh;display:flex;flex-direction:column;background:#151821;color:#e8eaf0;
        border:1px solid #262b38;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.55);
        font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .hd{padding:10px 14px;font-weight:600;border-bottom:1px solid #262b38;
        background:linear-gradient(135deg,#6366f1,#a855f7);-webkit-background-clip:text;
        background-clip:text;color:transparent}
      .panes{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 14px;overflow-y:auto}
      .lbl{font-size:11px;font-weight:600;color:#8a90a3;margin-bottom:4px;text-transform:uppercase}
      .txt{background:#0a0c10;border:1px solid #262b38;border-radius:10px;padding:8px;
        white-space:pre-wrap;word-wrap:break-word;font-family:ui-monospace,Menlo,monospace;
        font-size:12px;max-height:38vh;overflow-y:auto}
      .more{background:none;border:none;color:#6366f1;cursor:pointer;font-size:11px;padding:2px 0}
      .ft{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid #262b38}
      .hint{flex:1;color:#8a90a3;font-size:11px}
      button.b{font:inherit;padding:7px 14px;border-radius:10px;border:1px solid #262b38;
        background:#151821;color:#e8eaf0;cursor:pointer}
      button.b:hover{background:#1c2030}
      button.acc{border:none;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;font-weight:600}
      @media (max-width:520px){.panes{grid-template-columns:1fr}}
    </style>
    <div class="box" role="dialog" aria-label="Promptify preview">
      <div class="hd">Promptify</div>
      <div class="panes">
        <div><div class="lbl">Original</div><div class="txt" id="o"></div></div>
        <div><div class="lbl">Refined</div><div class="txt" id="r"></div></div>
      </div>
      <div class="ft">
        <span class="hint">Enter to accept · Esc to discard</span>
        <button class="b" id="d">Discard</button>
        <button class="b acc" id="a">Accept</button>
      </div>
    </div>`;

  function fill(id, text) {
    const el = root.getElementById(id);
    if (text.length <= 300) {
      el.textContent = text;
      return;
    }
    el.textContent = text.slice(0, 300) + '…';
    const more = document.createElement('button');
    more.className = 'more';
    more.textContent = 'show more';
    more.onclick = () => {
      el.textContent = text;
      more.remove();
    };
    el.after(more);
  }
  fill('o', original);
  fill('r', refined);

  // Buttons must not steal focus from the target field (that would collapse
  // the selection in contenteditable editors before we can replace it).
  root.querySelector('.box').addEventListener('mousedown', (e) => e.preventDefault());

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      accept();
    }
  }
  document.addEventListener('keydown', onKey, true);
  document.documentElement.appendChild(host);

  function cleanup() {
    host.remove();
    document.removeEventListener('keydown', onKey, true);
    window.__pfCleanup = null;
  }
  window.__pfCleanup = cleanup;

  function toast(msg, undoFn) {
    const t = document.createElement('div');
    t.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:340px;display:flex;gap:10px;' +
      'align-items:center;background:#151821;color:#e8eaf0;padding:10px 14px;border-radius:8px;' +
      'border-left:3px solid #6366f1;font:13px/1.4 -apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.45)';
    t.appendChild(document.createTextNode(msg));
    if (undoFn) {
      const u = document.createElement('button');
      u.textContent = 'Undo';
      u.style.cssText =
        'font:inherit;font-weight:600;color:#a5a8ff;background:none;border:none;cursor:pointer;padding:0';
      u.onclick = () => {
        if (!undoFn()) t.textContent = "Can't undo — field was edited.";
        else t.remove();
      };
      t.appendChild(u);
    }
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  // Returns {ok, undo} on success, {ok:false, reason} otherwise.
  function replaceNow() {
    const el = target;
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && typeof el.selectionStart === 'number') {
      const s = el.selectionStart;
      const e = el.selectionEnd;
      if (el.value.substring(s, e) !== original) return { ok: false, reason: 'changed' };
      el.setRangeText(refined, s, e, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const snapshot = el.value;
      return {
        ok: true,
        undo: () => {
          if (el.value !== snapshot) return false;
          el.setRangeText(original, s, s + refined.length, 'end');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        },
      };
    }
    if (el && el.isContentEditable) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString() !== original) return { ok: false, reason: 'changed' };
      el.focus();
      if (!document.execCommand('insertText', false, refined)) return { ok: false, reason: 'changed' };
      const snapshot = el.textContent;
      return {
        ok: true,
        undo: () => {
          if (el.textContent !== snapshot) return false;
          el.focus();
          return document.execCommand('undo');
        },
      };
    }
    return { ok: false, reason: 'noneditable' };
  }

  function accept() {
    const r = replaceNow();
    cleanup();
    if (r.ok) {
      toast('Refined ✓ ', r.undo);
    } else {
      navigator.clipboard.writeText(refined).then(
        () => toast(r.reason === 'changed'
          ? 'Field changed — refined prompt copied instead.'
          : "Refined prompt copied — selection wasn't editable."),
        () => toast('Could not replace or copy the refined prompt.')
      );
    }
  }

  root.getElementById('a').onclick = accept;
  root.getElementById('d').onclick = cleanup;
}
