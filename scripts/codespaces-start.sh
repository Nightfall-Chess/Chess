#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if curl -fsS http://127.0.0.1:4173/ >/dev/null 2>&1; then
  echo "Nightfall Chess is already running on port 4173."
  exit 0
fi

nohup npm start >/tmp/nightfall-chess.log 2>&1 </dev/null &

for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4173/ >/dev/null 2>&1; then
    echo "Nightfall Chess is ready on port 4173."
    exit 0
  fi
  sleep 1
done

echo "Nightfall Chess did not start. Server log:"
cat /tmp/nightfall-chess.log
exit 1
