# Promptify — Privacy Policy

*Last updated: July 2026*

Promptify is designed so that your data stays yours.

## What Promptify does with your data

- **No collection.** Promptify has no servers, no analytics, no telemetry, and no tracking of any kind. We never see your prompts, your keys, or anything else.
- **Your prompts** are sent only to the AI provider **you** configure — OpenRouter or Anthropic — using **your own API key**, and only when you explicitly trigger a refinement. Those requests are governed by the respective provider's privacy policy.
- **Your API keys** are stored in Chrome's local extension storage on your device and are sent only to the provider they belong to, as an authentication header.
- **Your history, snippet library, and settings** are stored in Chrome's extension storage. Profiles, site pins, and your template use Chrome's built-in sync storage, which is handled by your Google account's Chrome Sync — not by us.

## Permissions, in plain English

| Permission | Why |
|---|---|
| `storage` | Save your settings, history, and snippets in your browser |
| `contextMenus` | The right-click "Refine prompt" and "Insert snippet" menus |
| `scripting` + `activeTab` | Read your selected text and show the preview/replace UI, only when you invoke Promptify |
| `notifications` | Tell you when Promptify can't run on a restricted page |
| `sidePanel` | The optional docked side-panel mode |
| `openrouter.ai` / `api.anthropic.com` | Deliver your refinement requests with your key |

Promptify never reads page content in the background, never injects anything without an explicit action from you, and never transmits data to anyone other than your chosen AI provider.

## Contact

Questions: open an issue at https://github.com/r129rashid/prompt-refiner-extension/issues
