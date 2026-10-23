#!/usr/bin/env bash
# Fast confidence check (~2-3 min): pure unit tests + the quickest end-to-end scenarios.
# Needs the test server (~/mc-testserver/run.sh). Full suite: run each test/e2e/*.js yourself.
set -e
cd "$(dirname "$0")/.."
node test/acquire.test.js | tail -1
node test/blueprint.test.js | tail -1
for t in "chest.js" "extras.js place_chest" "extras.js shelter" "bridge.js" "lake.js swim" "chat.js sequence"; do
  printf '%-28s' "$t"; timeout 120 node test/e2e/$t 2>&1 | grep -E "^PASS|^FAIL|^\[\[" | tail -1
done
