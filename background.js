importScripts('shared.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'refine', title: 'Refine prompt', contexts: ['selection'] });
});

// ponytail: transient in-flight guard; resets if the service worker sleeps, which is fine
const pendingTabs = new Set();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'refine' || !tab?.id) return;
  if (pendingTabs.has(tab.id)) return;
  pendingTabs.add(tab.id);
  try {
    await inject(tab.id, ['', 'Refining…', true]);
    const cfg = await getConfig();
    const output = await refine(info.selectionText, defaultParams(cfg.defaults));
    await inject(tab.id, [output, '', false]);
  } catch (e) {
    await inject(tab.id, ['', e.message, false]).catch(() => {});
  } finally {
    pendingTabs.delete(tab.id);
  }
});

function inject(tabId, args) {
  return chrome.scripting.executeScript({ target: { tabId }, func: finishInPage, args });
}

// Runs inside the page. With text: replace the selection (textarea/input/contenteditable),
// falling back to clipboard. Without text: just show the message as a toast.
function finishInPage(text, message, sticky) {
  function toast(msg, stay) {
    let t = document.getElementById('__pr_toast');
    if (!t) {
      t = document.createElement('div');
      t.id = '__pr_toast';
      t.style.cssText =
        'position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:320px;' +
        'background:#151821;color:#e8eaf0;padding:10px 14px;border-radius:8px;' +
        'border-left:3px solid #6366f1;font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.45);transition:opacity .2s;opacity:0';
      document.documentElement.appendChild(t);
      requestAnimationFrame(() => (t.style.opacity = '1'));
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._hide);
    if (!stay) {
      t._hide = setTimeout(() => {
        t.style.opacity = '0';
        setTimeout(() => t.remove(), 300);
      }, 3500);
    }
  }

  if (!text) {
    toast(message, sticky);
    return;
  }

  const el = document.activeElement;
  let done = false;
  if (
    el &&
    (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') &&
    typeof el.selectionStart === 'number' &&
    el.selectionStart !== el.selectionEnd
  ) {
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    done = true;
  } else if (el && el.isContentEditable) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) done = document.execCommand('insertText', false, text);
  }

  if (done) {
    toast('Refined ✓');
  } else {
    navigator.clipboard.writeText(text).then(
      () => toast("Refined prompt copied — selection wasn't editable."),
      () => toast('Could not replace or copy the refined prompt.')
    );
  }
}
