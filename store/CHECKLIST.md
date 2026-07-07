# Chrome Web Store submission checklist

Everything below `store/` and `dist/` is prepared — these are the manual steps.

## One-time setup
- [ ] Register a Chrome Web Store developer account at https://chrome.google.com/webstore/devconsole (one-time $5 fee, needs a Google account).

## Submit
- [ ] Run `./package.sh` → produces `dist/promptify-1.3.0.zip`.
- [ ] Dev console → **New item** → upload the zip.
- [ ] **Store listing** tab: paste name, summary, description, and category from [listing.md](listing.md).
- [ ] Upload screenshots from `store/screenshots/` (1280×800) and the small promo tile (`promo-440x280.png`).
- [ ] **Privacy practices** tab: paste the single-purpose statement and the per-permission justifications from listing.md; answer the data questionnaire per the "Data disclosures" section (collects nothing).
- [ ] Privacy policy URL: `https://r129rashid.github.io/prompt-refiner-extension/privacy.html`
- [ ] **Distribution** tab: Public · all regions (or narrow if you prefer).
- [ ] Submit for review. Typical review time: 1–3 business days; MV3 + no remote code + minimal permissions keeps this smooth.

## After approval
- [ ] Copy the live store URL.
- [ ] Update the Install button href in `docs/index.html` (currently points to the GitHub repo) and push.
- [ ] Update README badge/link.

## Each future release
- [ ] Bump `version` in manifest.json.
- [ ] `node test.js` + reload unpacked + quick manual pass.
- [ ] `./package.sh`, upload the new zip in the dev console, submit.
