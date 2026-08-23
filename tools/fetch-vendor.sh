#!/usr/bin/env bash
# ICEBERG — place the emulator in vendor/.
#
# v86 is not vendored into this repository: it is a large build artifact with
# its own release cadence, and pinning a copy here would rot. This fetches a
# release and puts the two files Iceberg needs where config.js expects them.
#
#   vendor/libv86.mjs   the emulator, as an ES module
#   vendor/v86.wasm     its WebAssembly
#
# Pin V86_REF to a tag you have actually tested. A warm floe is tied to the
# emulator build that made it, so changing this is not a cosmetic upgrade.

set -euo pipefail
V86_REF="${V86_REF:-v0.5.0}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor"
mkdir -p "$DEST"

base="https://github.com/copy/v86/releases/download/${V86_REF}"
echo "Fetching v86 ${V86_REF} into ${DEST}"

curl -fL --retry 3 -o "$DEST/libv86.mjs" "${base}/libv86.mjs" \
  || curl -fL --retry 3 -o "$DEST/libv86.js" "${base}/libv86.js"
curl -fL --retry 3 -o "$DEST/v86.wasm" "${base}/v86.wasm"

cat > "$DEST/README.md" <<'NOTE'
Files here are fetched by tools/fetch-vendor.sh and are not part of Iceberg.
v86 is by Fabian Hemmer and contributors, BSD-2-Clause.
NOTE

echo "Done. Serve the site over https (or http://localhost) and open machine.html."
