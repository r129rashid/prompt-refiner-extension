# Chrome Web Store listing — copy-paste source

## Name
Promptify — AI Prompt Refiner

## Summary (≤132 chars)
Turn rough prompts into clear, high-quality ones — right-click any text, use the popup, or hit ⌘⇧U. Your keys, your data.

## Category
Productivity → Tools · Language: English

## Full description

Rough thought in. Refined prompt out.

Promptify rewrites vague, hasty prompts into clear, specific, high-quality ones — anywhere in your browser. Select text in ChatGPT, Claude, Gmail, or any input, right-click → Refine prompt, review the before/after preview, and accept. Done.

WHY PROMPTIFY
• Better prompts get dramatically better AI answers — Promptify applies prompt-engineering structure (role, context, task, constraints, what to avoid) automatically.
• Preview before anything changes: a side-by-side original vs refined view with one-click Accept, Discard, or Undo.
• Bring your own key: works with OpenRouter (including free models) and Anthropic. No account, no subscription, no middleman server.

FEATURES
• Right-click refinement with in-place text replacement on any site
• Keyboard shortcut (Ctrl+Shift+U / ⌘⇧U) for mouse-free refining
• Streaming output in the elegant popup — watch the refinement appear live
• Profiles: named answer sets ("Coding", "Work email", "Blog") switchable per refinement
• Site pins: your "Coding" profile auto-selected on GitHub, "Email" in Gmail
• ×3 variations mode: three alternative refinements, pick the best
• "Tweak it": iterate on a result — make it shorter, more formal, anything
• Prompt library: save your best refinements as snippets and insert them anywhere
• Side panel mode that survives clicking around the page
• Live model list with a free-only filter — never a stale model id
• Fully editable meta-prompt template for power users

PRIVACY, GENUINELY
Promptify has no servers and collects nothing. Your prompts go only to the AI provider you configure, with your own API key. Everything else stays in your browser. Full policy: https://r129rashid.github.io/prompt-refiner-extension/privacy.html

## Single purpose statement
Promptify rewrites user-selected or user-entered rough prompts into clear, well-structured prompts for AI models, using the AI provider and API key the user configures.

## Permission justifications (dashboard "Privacy practices" tab)

- **storage** — Saves the user's settings, refinement profiles, history, and snippet library locally/in Chrome Sync. No data leaves the browser.
- **contextMenus** — Provides the right-click "Refine prompt" and "Insert snippet" menu items, the extension's primary entry points.
- **scripting** — Injects the preview/accept UI and replaces the selected text with the refined prompt, only in the tab where the user invoked the action.
- **activeTab** — Reads the user's selected text in the tab where they explicitly triggered refinement (context menu, keyboard shortcut, or popup).
- **notifications** — Shows an error notification when the extension is invoked on a restricted page (e.g. chrome://) where no in-page message can be displayed.
- **sidePanel** — Offers an optional docked side-panel version of the popup UI.
- **Host permission https://openrouter.ai/*** — Sends the user's refinement request to OpenRouter with the user's own API key, only when the user triggers a refinement.
- **Host permission https://api.anthropic.com/*** — Same as above, for the Anthropic API.
- **Remote code** — None. All code is packaged in the extension.

## Data disclosures (dashboard questionnaire)
- Does NOT collect or use any user data → check "none of the above" for all data categories.
- Data is not sold, not used for unrelated purposes, not used for creditworthiness.
