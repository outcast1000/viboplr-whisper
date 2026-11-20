#!/usr/bin/env bash
# Build whisper.zip (manifest.json + index.js [+ signature.sig] at the ZIP ROOT —
# install_plugin_from_zip requires it) and update.json. Run from anywhere:
#   scripts/package.sh
# index.js is built from align.js + plugin.js first, and the tests gate it.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/build.mjs
node --test

VERSION=$(node -e 'console.log(require("./manifest.json").version)')
MIN_APP=$(node -e 'console.log(require("./manifest.json").minAppVersion || "")')
FILE_URL="https://github.com/outcast1000/viboplr-whisper/releases/latest/download/whisper.zip"

CHANGELOG=""
if [ -f CHANGELOG.md ]; then
  CHANGELOG=$(awk '/^## /{if(seen)exit; seen=1; next} seen{print}' CHANGELOG.md | sed '/^$/d' | head -50)
fi

# Signed with the Vibo PLUGIN-signing key (never the app updater key) when it
# is in the environment, and REQUIRED in CI (REQUIRE_SIGNATURE=1). A signed
# plugin is first-party: no permission prompt except programs:run, which Vibo
# always asks for.
rm -f signature.sig
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  node scripts/plugin-signing.mjs sign .
  node scripts/plugin-signing.mjs verify .
elif [ "${REQUIRE_SIGNATURE:-}" = "1" ]; then
  echo "error: REQUIRE_SIGNATURE=1 but no TAURI_SIGNING_PRIVATE_KEY is set." >&2
  exit 1
else
  echo "note: no plugin-signing key in the environment — building UNSIGNED (local use only)."
fi

rm -f whisper.zip
if [ -f signature.sig ]; then
  zip -q whisper.zip manifest.json index.js signature.sig
else
  zip -q whisper.zip manifest.json index.js
fi
unzip -l whisper.zip

VERSION="$VERSION" MIN_APP="$MIN_APP" FILE_URL="$FILE_URL" CHANGELOG="$CHANGELOG" node -e '
const fs = require("fs");
const info = { version: process.env.VERSION, file: process.env.FILE_URL };
if (process.env.MIN_APP) info.minAppVersion = process.env.MIN_APP;
if (process.env.CHANGELOG) info.changelog = process.env.CHANGELOG;
fs.writeFileSync("update.json", JSON.stringify(info, null, 2) + "\n");
console.log("wrote update.json:", JSON.stringify(info));
'
echo
echo "To publish, push a tag and let CI build and sign it:  git tag v${VERSION} && git push origin v${VERSION}"
