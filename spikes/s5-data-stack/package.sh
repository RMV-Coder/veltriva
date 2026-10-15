#!/usr/bin/env bash
# S5.4: build the minimal app/ into unpacked Windows builds with electron-builder (--dir). Nothing is installed or run as an installer.
# Run from anywhere:  bash spikes/s5-data-stack/package.sh   (logs: install.log, pack.log, pack-slim.log next to this script)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKES="$(cd "$HERE/.." && pwd)"

# 1. Dependencies of the app, installed ONLY inside app/ (no install scripts, so no compiler is ever invoked).
( cd "$HERE/app" && npm install --ignore-scripts ) 2>&1 | tee "$HERE/install.log"

rm -rf "$HERE/dist"

# 2a. Variant "default": exactly the command from the brief, no extra configuration.
( cd "$SPIKES" && ./node_modules/.bin/electron-builder --win --x64 --dir \
    --projectDir s5-data-stack/app \
    -c.electronVersion=44.7.2 \
    -c.npmRebuild=false \
    -c.directories.output=../dist ) 2>&1 | tee "$HERE/pack.log"

# 2b. Variant "slim-fuses": trimmed better-sqlite3 payload + ADR-0007 fuses (config in builder.slim.yml).
( cd "$SPIKES" && ./node_modules/.bin/electron-builder --win --x64 --dir \
    --projectDir s5-data-stack/app \
    --config ../builder.slim.yml ) 2>&1 | tee "$HERE/pack-slim.log"

ls "$HERE/dist" "$HERE/dist/slim"

# 3. (optional) What happens if the native rebuild is NOT disabled? Runs in a throw-away copy under dist/.
#    Needs Python + Visual Studio build tools; downloads Electron headers into ~/.electron-gyp. Enable with S5_REBUILD_PROBE=1.
if [ "${S5_REBUILD_PROBE:-0}" = "1" ]; then
  rm -rf "$HERE/dist/rebuild-probe" && mkdir -p "$HERE/dist/rebuild-probe" && cp -r "$HERE/app" "$HERE/dist/rebuild-probe/app"
  ( cd "$SPIKES" && ./node_modules/.bin/electron-builder --win --x64 --dir \
      --projectDir s5-data-stack/dist/rebuild-probe/app \
      -c.electronVersion=44.7.2 \
      -c.directories.output=../out ) 2>&1 | tee "$HERE/pack-rebuild-probe.log"
fi
