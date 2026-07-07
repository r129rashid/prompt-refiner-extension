# Promptify — MVP3 Requirements

## Scope & current state

Promptify (MVP2) is a Manifest V3 Chrome extension: toolbar popup + right-click "Refine prompt" context menu, direct API calls to OpenRouter/Anthropic with user-supplied keys, defaults + meta-prompt template in `chrome.storage.sync`, keys + history (25 entries) in `chrome.storage.local`, dark UI with indigo→violet accent. MVP3 adds ten enhancements. They are independently shippable; suggested build order is in §Phasing.

Cross-cutting rules for every feature below:
- Vanilla JS, no build step, no new dependencies, MV3 CSP-compliant (no inline scripts, no CDN).
- Keep the existing dark design language (`style.css` tokens).
- Every failure surfaces a human-readable message (popup error line or in-page toast), never a silent no-op or raw stack.
- Add a `schemaVersion` key in storage; run migrations in `chrome.runtime.onInstalled` when the shape of stored data changes (profiles, library, site map).

---

## 1. Live model list

**Goal:** stop hardcoding OpenRouter models (they rotate; we already shipped stale ids once).

**Requirements**
1. Fetch `GET https://openrouter.ai/api/v1/models` and populate the model dropdown from it (id + name).
2. Cache the list in `storage.local` with a 24-hour TTL; refresh in the background when stale, never block the UI on the fetch.
3. Add a "Free only" toggle next to the model dropdown (filters ids ending `:free`).
4. Anthropic's list stays static (small, stable).
5. Manual "refresh models" affordance on the options page.

**Edge cases**
- Fetch fails / offline → use cached list; no cache → fall back to the bundled list currently in `shared.js` and show a muted "couldn't refresh models" note.
- Saved default model no longer in the fetched list → keep it selectable at the top marked "(unavailable?)" and show a warning on refine failure; never silently swap the user's choice.
- 300+ models → dropdown must stay usable: text filter input above the select (simple `includes` filter), free-only toggle applied first.
- OpenRouter response shape changes / non-JSON → treat as fetch failure (fallback chain above).
- Rate-limited (429) on the models endpoint → back off; retry no sooner than 1 hour.

**Done when:** deleting the hardcoded list (except fallback) changes nothing visible on a warm cache, and a fresh install offline still shows working models.

---

## 2. Keyboard shortcut

**Goal:** refine the current selection without the mouse.

**Requirements**
1. Register a `chrome.commands` command `refine-selection`, suggested default `Ctrl+Shift+U` (`Cmd+Shift+U` on Mac — avoid `Cmd+Shift+P` which collides with common in-app command palettes).
2. Handler reuses the exact context-menu flow (read selection via `chrome.scripting.executeScript`, refine with active defaults/profile, replace or clipboard-fallback, toasts).
3. Document the shortcut on the options page with a link to `chrome://extensions/shortcuts` for rebinding (link must be copyable text — extensions cannot open `chrome://` URLs directly).

**Edge cases**
- No text selected → toast "Select some text first." — no API call.
- Selection in a non-editable element → refined text to clipboard + toast (same as context-menu fallback).
- Restricted pages (`chrome://*`, Chrome Web Store, PDF viewer) → `executeScript` throws; show a `chrome.notifications` notification "Promptify can't run on this page" since no toast can be injected.
- Refine already in flight on this tab → ignore the repeat trigger (existing per-tab pending guard).
- Shortcut conflicts with a site or another extension → user rebinding via `chrome://extensions/shortcuts` is the supported path; no in-extension key capture.

**Done when:** select → hotkey → replaced text works on a plain textarea and on ChatGPT's editor, and the hotkey on a `chrome://` page produces the notification, not a console error.

---

## 3. Refinement profiles

**Goal:** replace the single global default with named parameter presets ("Coding", "Work email", "Blog"…).

**Requirements**
1. A profile = name + full parameter set (role, format, length, tone, audience, extras, provider, model).
2. CRUD on the options page: create, rename, edit, delete, set active. Stored in `storage.sync`, **one key per profile** (`profile:<id>`) to stay under the 8KB per-item quota; an index key holds order + active id.
3. Migration: existing saved defaults become a non-deletable profile named "Default" (editable). Fresh installs get "Default" with all-None values.
4. Popup: profile selector at the top; picking one repopulates all controls; per-run tweaks don't modify the profile (matches current defaults behavior).
5. Context menu becomes a parent "Refine prompt" with one child item per profile; clicking a child refines with that profile.

**Edge cases**
- Cap at 20 profiles (sync total quota is 100KB) → "Delete one first" message beyond that.
- Duplicate names → auto-suffix "(2)" rather than reject.
- Deleting the active profile → active falls back to "Default"; "Default" itself cannot be deleted, only reset.
- Profile references a model that no longer exists (see §1) → same unavailable-model handling.
- Context menu must be rebuilt on every profile change **and** on service-worker startup (menus don't persist reliably across SW restarts) — rebuild idempotently (`removeAll` then create).
- `storage.sync` write conflict across two devices → last-write-wins; acceptable, note in code.
- Profile edited while popup is open in another window → popup listens to `chrome.storage.onChanged` and refreshes the selector.

**Done when:** two profiles with different roles produce visibly different refinements from the context submenu, and the old single-default install migrates without losing saved values.

---

## 4. Preview & undo for in-page replacement

**Goal:** never destroy the user's original text with an unreviewed model output.

**Requirements**
1. Context-menu/hotkey refine no longer replaces immediately. When the result arrives, show an overlay anchored near the field (rendered inside a **shadow DOM** to isolate from site CSS): original (truncated ~300 chars, expandable) vs refined, with **Accept** and **Discard** buttons.
2. Keyboard: `Enter` accepts, `Esc` discards.
3. On Accept → replace selection (existing logic); then show a 5-second toast with an **Undo** button that restores the stored original text.
4. Clipboard-fallback cases (non-editable target) skip the overlay — straight to clipboard + toast, as today.

**Edge cases**
- Page navigates / re-renders while the overlay is open → overlay dies with the page and nothing was replaced — safe by design.
- Field content or selection changed between refine start and Accept → verify the original selected substring still matches before replacing; if not, copy to clipboard + toast "Field changed — refined prompt copied instead."
- Second refine triggered while an overlay is open → dismiss the first overlay (discard) before starting.
- Undo after further user edits to the field → restore only if the refined text is still present verbatim at the insertion point; otherwise toast "Can't undo — field was edited."
- Very long original/refined → both panes clamp with "show more"; overlay max-height with internal scroll; never taller than the viewport.
- Site with aggressive z-index/fixed headers → overlay uses max z-index inside shadow root and repositions to stay in viewport.

**Done when:** a bad model output can always be rejected without losing the original, verified on textarea + contenteditable.

---

## 5. Follow-up refinement (iterate)

**Goal:** refine the refinement — "make it shorter", "more formal" — without starting over.

**Requirements**
1. Popup only. Below a non-empty output: a one-line "Tweak it…" input + button.
2. Sends a dedicated system prompt: expert prompt-editor, receives the current refined prompt + the tweak instruction, returns only the revised prompt (same strict output rules as the main template).
3. Output panel updates in place; each successful iteration appends its own history entry (flagged `iterated: true`).
4. Works on outputs restored from history.

**Edge cases**
- Empty tweak instruction → ignore (button disabled while input empty).
- No output yet → the tweak row is hidden entirely.
- Popup closes mid-iteration → request dies, nothing written to history (existing pattern); the pre-iteration output is still in history from its own entry.
- Iteration chain length → no artificial limit, but input+output capped by the existing 8,000-char guard; over cap → "Too long to iterate — start a new refinement."
- Model returns commentary/fences → same `cleanResponse` path.

**Done when:** "make it under 100 words" on a long refined prompt returns a shortened version and both versions exist in history.

---

## 6. Streaming output

**Goal:** kill the blank multi-second wait in the popup.

**Requirements**
1. Popup refines (including iterations) request `stream: true` and render tokens incrementally into the output panel. OpenRouter: OpenAI-style SSE `data:` lines with `[DONE]` sentinel; Anthropic: event stream with `content_block_delta` events — one small parser per provider in `shared.js`.
2. Keep the existing "refining" visual state until the stream completes; Copy is enabled the whole time (copies what's rendered).
3. `AbortController` wired to popup unload.
4. Context-menu/hotkey flows stay non-streaming (nowhere to render partial text; overlay from §4 shows the final result).
5. `cleanResponse` (fence stripping) runs on the final assembled text — re-render once at completion.

**Edge cases**
- Stream drops mid-response (network) → keep the partial text visible + error line "Stream interrupted — partial result shown." No history entry for partials.
- Model/provider rejects `stream: true` → retry that request once without streaming, transparently.
- SSE chunk boundaries splitting JSON or multibyte characters → buffer by newline and decode with a streaming `TextDecoder`.
- History written only on completed streams.
- Popup closed mid-stream → abort; no history entry (existing behavior, now explicit via AbortController).
- Empty stream (connects, then `[DONE]` with no tokens) → "Model returned nothing — try another model."

**Done when:** a slow free model shows visible progressive text within ~1s of the request on a normal connection, and killing Wi-Fi mid-stream leaves a readable partial + error instead of a spinner.

---

## 7. Prompt library

**Goal:** reusable named snippets, separate from the chronological history.

**Requirements**
1. "Save to library" action on the popup output and on each history row → prompts for a name.
2. Library UI: a tab/section in the popup (name-searchable list; click = load into output; buttons: copy, delete, rename) and a fuller table on the options page.
3. Context menu gains an "Insert snippet ▸" parent (contexts: `editable`) listing the 10 most recently used snippets; clicking inserts at the cursor (same injection/fallback machinery as refine-replace).
4. Stored in `storage.local` (snippets can be large); export/import as JSON from the options page.

**Edge cases**
- Name required; duplicate name → auto-suffix "(2)".
- Cap 100 snippets; at cap → "Delete some snippets first."
- Search filters on name + content, case-insensitive, debounced 150ms.
- Insert target not editable / restricted page → clipboard fallback + toast (reuse §2 handling).
- Import: validate shape (`[{name, text, createdAt}]`); on invalid → error toast, import nothing; on name collisions → imported entry gets suffix, never overwrites.
- Export contains only snippets — no keys, no history.
- Context submenu rebuilt on SW startup and on library change (same idempotent rebuild as §3).

**Done when:** save → search → insert into a Gmail compose works end-to-end, and export→wipe→import round-trips losslessly.

---

## 8. Site-aware defaults

**Goal:** the right profile picked automatically per site. (Depends on §3.)

**Requirements**
1. Popup shows "Use this profile on <hostname>" checkbox; when checked, stores `siteMap[hostname] = profileId` in `storage.sync`.
2. On popup open, context-menu default item, and hotkey: if the active tab's hostname has a mapping, that profile is preselected/used; otherwise the globally active profile.
3. Options page lists all mappings with remove buttons.

**Edge cases**
- Exact hostname match only (`mail.google.com` ≠ `google.com`); no wildcard logic in MVP3.
- Mapped profile was deleted → drop the mapping lazily on first lookup, fall back to "Default".
- No tab URL available (`chrome://`, `file://` without permission, detached devtools) → global active profile, no error.
- Iframes → always key on the top-level tab URL.
- Cap 100 mappings; oldest-unused evicted (store `lastUsed` per entry).
- Manual profile switch in the popup on a mapped site → applies for that run only; the mapping changes only via the checkbox.

**Done when:** github.com auto-selects "Coding" while gmail auto-selects "Email", with both visible in the popup's profile selector on open.

---

## 9. Side panel mode

**Goal:** a persistent workspace that survives clicking into the page (the popup dies on every focus loss, killing in-flight refines).

**Requirements**
1. `sidePanel` permission + a `panel.html` that reuses the popup's markup/JS/CSS (same files or thin wrapper; popup layout already near-panel width).
2. "Open in side panel" button in the popup footer (`chrome.sidePanel.open`); panel has no such button.
3. Toolbar click keeps opening the popup (no behavior change for existing muscle memory).
4. Popup and panel are independent instances; both listen to `chrome.storage.onChanged` so history/library/profile changes reflect live in whichever is open.

**Edge cases**
- Chrome < 114 (no `sidePanel` API) → feature-detect; hide the button.
- Popup and panel open simultaneously → allowed; no shared in-memory state, storage events keep lists consistent; concurrent refines are independent.
- Very narrow panel widths → CSS `min-width` + wrap; no horizontal scroll.
- `sidePanel.open` requires a user gesture → only ever call it from the button click handler.
- In-flight refine in the panel while user browses other tabs → completes normally (this is the point); history written as usual.

**Done when:** a refine started in the side panel completes while clicking around another tab, and the result also appears in a freshly opened popup's history.

---

## 10. Variations mode

**Goal:** three alternative refinements when you don't know which framing you want.

**Requirements**
1. "×3" toggle next to Refine (popup only, off by default, not persisted).
2. Fires 3 parallel requests with temperatures 0.3 / 0.7 / 0.9 (identical otherwise) — non-streaming.
3. Results render as three cards (A/B/C) with a "Use this" button each; choosing one makes it the active output (Copy / tweak / save-to-library all apply to it) and collapses the others.
4. Only the chosen variation is written to history.
5. A muted "3 requests will be sent" note when the toggle is on and a paid (non-`:free`) model is selected.

**Edge cases**
- Partial failures → show successful cards + one error card with the failure message; 1 success is still usable; 0 successes → normal error line.
- 429 on parallel calls → stagger launches by 300ms; a variation that still 429s shows as a failed card (no auto-retry loop).
- Near-identical outputs (deterministic model) → expected at low temperature; the 0.3/0.7/0.9 spread is the mitigation; no dedup logic.
- Toggle on + iterate (§5) → iteration always runs single (the tweak row applies to the chosen output only).
- Popup closed mid-flight → all three aborted, nothing in history.

**Done when:** one click yields three distinct cards from a free model, picking B makes Copy/tweak act on B, and only B shows up in history.

---

## Phasing (suggested)

| Phase | Features | Rationale |
|-------|----------|-----------|
| 1 | §1 live models, §2 hotkey | Highest value, smallest code, no schema changes |
| 2 | §3 profiles, §8 site-aware | One storage migration, shared context-menu rework |
| 3 | §4 preview/undo, §5 iterate, §6 streaming | Core UX trust + speed |
| 4 | §7 library, §9 side panel, §10 variations | Additive workspace features |

## Out of scope for MVP3

Login/cloud sync beyond `storage.sync`, Firefox/Edge ports, Google Docs canvas-editor support, i18n, telemetry, Chrome Web Store publishing assets.
