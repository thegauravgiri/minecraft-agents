#!/usr/bin/env bash
# Keep ONE agent alive forever: relaunch on any exit (crash, out-of-memory, deliberate memory restart) with a small growing back-off.
# usage: ./supervise.sh <PORT> <Name>       (env MC_AGENT_NAMES etc. are inherited)
PORT=$1; NAME=$2
cd "$(dirname "$0")"
mkdir -p data/run
echo $$ > "data/run/$NAME.pid"
fail=0
while true; do
  start=$(date +%s)
  node --max-old-space-size=2048 bot.js "$PORT" "$NAME" >> "data-log-$NAME.txt" 2>&1
  code=$?
  up=$(( $(date +%s) - start ))
  echo "[supervisor] $NAME exited with code $code after ${up}s - restarting" >> "data-log-$NAME.txt"
  if [ "$up" -gt 120 ]; then fail=0; else fail=$((fail+1)); fi
  sleep $(( fail > 5 ? 60 : 3 + fail * 5 ))
done
