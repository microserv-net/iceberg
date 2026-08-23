#!/usr/bin/env bash
# ICEBERG — place the emulator in vendor/.
#
# v86 is not vendored into this repository: it is a large build artifact with
# its own release cadence, and pinning a copy here would rot. This fetches a
# release and puts the two files Iceberg needs where config.js expects them.
#
#   vendor/libv86.js    the emulator, as a classic script
#   vendor/v86.wasm     its primary WebAssembly
#   vendor/v86-fallback.wasm  fallback WebAssembly used if primary instantiation fails
#
# Pin V86_REF to a tag you have actually tested. A warm floe is tied to the
# emulator build that made it, so changing this is not a cosmetic upgrade.

set -euo pipefail
V86_BASE_URL="${V86_BASE_URL:-https://copy.sh/v86/build}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor"
mkdir -p "$DEST"

echo "Fetching v86 from ${V86_BASE_URL} into ${DEST}"

curl -fL --retry 3 -o "$DEST/libv86.mjs" "${V86_BASE_URL}/libv86.mjs" \
  || curl -fL --retry 3 -o "$DEST/libv86.js" "${V86_BASE_URL}/libv86.js"
curl -fL --retry 3 -o "$DEST/v86.wasm" "${V86_BASE_URL}/v86.wasm"
curl -fL --retry 3 -o "$DEST/v86-fallback.wasm" "${V86_BASE_URL}/v86-fallback.wasm"

cat > "$DEST/README.md" <<'NOTE'
Files here are fetched by tools/fetch-vendor.sh and are not part of Iceberg.
v86 is by Fabian Hemmer and contributors, BSD-2-Clause.
NOTE

echo "Done. Serve the site over https (or http://localhost) and open machine.html."
