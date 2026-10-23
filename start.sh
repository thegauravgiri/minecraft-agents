#!/usr/bin/env bash

PORT=$1
if [ -z "$PORT" ]; then
    echo "Usage: ./start.sh <LAN_PORT> [BOT_NAME]"
    echo "Example: ./start.sh 54321 AIBot"
    exit 1
fi

BOT_NAME=${2:-AIBot}

node src/index.js "$PORT" "$BOT_NAME"
