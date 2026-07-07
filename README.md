# Promptify — Chrome Extension

Rewrite rough prompts into clear, specific, high-quality prompts — anywhere in the browser.

## Features

- **Toolbar popup** — paste a rough prompt, pick refinement options (role, format, length, tone, audience, extras), hit Refine, copy the result.
- **Right-click menu** — select rough text in any input on any page, right-click → "Refine prompt", and the selection is replaced in place with the refined version (falls back to clipboard copy if the field isn't editable).
- **Settings page** — enter your OpenRouter and/or Anthropic API key, save default answers for the refinement questions (used to pre-fill the popup and the context menu), and edit the underlying meta-prompt template.

No server, no login, no build step. API keys and history stay in the browser's extension storage; default answers and the template sync across your Chrome profile via `chrome.storage.sync`.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the extension icon → ⚙ Settings → paste your API key → Save.

## Structure

```
manifest.json   — Manifest V3 config
shared.js       — presets, meta-prompt template, provider calls, storage helpers
background.js   — service worker: context-menu registration + in-page replacement
popup.html/js   — toolbar popup UI
options.html/js — settings page (API keys, defaults, template)
style.css       — shared styling
```
