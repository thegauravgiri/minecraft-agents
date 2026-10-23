#!/usr/bin/env bash
# Reset the agents from the terminal:  ./reset.sh [tasks|chat|all|everything] [Name ...]
#   tasks (default) - drop every running/queued task, team job and request; they stand by for new orders
#   chat            - forget the conversation        all - forget conversation, places, landmarks, journal, plans
#   everything      - tasks + all                    (the learned skill library is always kept)
cd "$(dirname "$0")" && node scripts/reset-context.js "$@"
