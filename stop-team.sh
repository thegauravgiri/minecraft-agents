#!/usr/bin/env bash
# Stop all supervised agents (supervisors first, so nothing is relaunched).
cd "$(dirname "$0")"
for f in data/run/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
sleep 1
ps -eo pid,args | awk '$2 == "node" && /bot\.js [0-9]+ [A-Za-z]+$/ {print $1}' | xargs -r kill
echo "all agents stopped"
