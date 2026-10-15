#!/usr/bin/env bash
# Runs every S2 group as its own Electron process so each stays well under a 180 s command timeout.
# Usage (Git Bash): cd spikes && bash s2-restore/run-all.sh
set -u
cd "$(dirname "$0")/.."
status=0
for group in q1 q2 q3,q2b q4 q4b q5 q6; do
  echo "=== s2-restore --only=$group ==="
  timeout 175 ./node_modules/.bin/electron s2-restore/main.js --only="$group" || status=$?
done
# Extra evidence for the detached-restore scroll error: it scales with the device scale factor.
for factor in 1 2; do
  echo "=== s2-restore --only=q2b with --force-device-scale-factor=$factor ==="
  timeout 175 ./node_modules/.bin/electron --force-device-scale-factor=$factor s2-restore/main.js --only=q2b --tag=dsf$factor || status=$?
done
exit $status
