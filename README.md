# Promptify — Chrome Extension

Rewrite rough prompts into clear, specific, high-quality prompts — anywhere in the browser.

## Features

- **Toolbar popup** — paste a rough prompt, pick refinement options, hit Refine, copy the result. Output streams in live.
- **Right-click menu** — select rough text in any input, right-click → "Refine prompt" (with a submenu per profile). A before/after preview lets you Accept or Discard, with a 5-second Undo after replacing.
- **Keyboard shortcut** — `Ctrl+Shift+U` (`⌘⇧U` on Mac) refines the current selection without the mouse. Rebind at `chrome://extensions/shortcuts`.
- **Profiles** — named answer sets ("Coding", "Work email", …) managed in Settings; switchable in the popup and the right-click submenu.
- **Site pins** — "use on this site" remembers a profile per hostname and auto-selects it there.
- **Live model list** — OpenRouter models fetched daily (with a free-only filter), so the dropdown never goes stale.
- **Tweak it** — iterate on a result ("make it shorter", "more formal") without starting over.
- **×3 variations** — three alternative refinements at different temperatures; pick the best.
- **Prompt library** — save refinements as named snippets; insert them via right-click → Insert snippet; export/import as JSON.
- **Side panel** — open Promptify in Chrome's docked side panel so in-flight refines survive clicking into the page.
- **Settings page** — API keys, profiles, site pins, library, and the editable meta-prompt template.

No server, no login, no build step. API keys and history stay in the browser's extension storage; profiles, site pins, and the template sync across your Chrome profile via `chrome.storage.sync`.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the extension icon → ⚙ Settings → paste your API key → Save.

## Structure

```
manifest.json   — Manifest V3 config (commands, side panel, notifications)
shared.js       — presets, template, provider calls + SSE streaming, storage helpers
background.js   — service worker: menus, hotkey, preview/undo overlay injection
popup.html/js   — toolbar popup UI (also reused by panel.html for the side panel)
options.html/js — settings: keys, profiles, models, site pins, library, template
style.css       — shared styling
test.js         — node test.js → smoke-checks the pure helpers
mvp3.md         — requirements doc for this feature set
```

See [mvp3.md](mvp3.md) for the full requirements and edge cases.
