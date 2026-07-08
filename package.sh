#!/bin/bash
# Build the Chrome Web Store zip: runtime files only.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="dist/promptify-$VERSION.zip"

mkdir -p dist
rm -f "$OUT"
zip -q "$OUT" \
  manifest.json \
  background.js shared.js pf-config.js \
  popup.html popup.js panel.html \
  options.html options.js \
  style.css \
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png

echo "Built $OUT:"
unzip -l "$OUT"
