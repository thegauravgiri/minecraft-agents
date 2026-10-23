#!/usr/bin/env bash
# Start several self-restarting agents in the same world:  ./start-team.sh <PORT> Vesper Wren Cobalt ...
# Each agent answers only to humans, keeps its own memory (data/<name>), talks to the others through the team inbox (not chat),
# and is relaunched by its supervisor if it ever dies. Stop everything with ./stop-team.sh
PORT=$1; shift
[ -z "$PORT" ] && { echo "Usage: ./start-team.sh <PORT> <Name> [<Name> ...]"; exit 1; }
NAMES=${*:-Vesper Wren}
AGENTS=$(echo $NAMES | tr ' ' ',')
cd "$(dirname "$0")"
chmod +x supervise.sh
for N in $NAMES; do
  : > "data-log-$N.txt"
  MC_GENERIC_TRIGGER=false MC_AGENT_NAMES=$AGENTS nohup ./supervise.sh "$PORT" "$N" > /dev/null 2>&1 &
  echo "started $N (supervisor pid $!) -> data-log-$N.txt"
  sleep 3
done
