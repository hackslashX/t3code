#!/bin/sh
set -eu

code-server --auth none --bind-addr 0.0.0.0:3001 "$HOME" &
code_pid=$!

node /app/dist/bin.mjs serve "$HOME" &
t3_pid=$!

shutdown() {
  kill -TERM "$t3_pid" "$code_pid" 2>/dev/null || true
  wait "$t3_pid" "$code_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

while kill -0 "$t3_pid" 2>/dev/null && kill -0 "$code_pid" 2>/dev/null; do
  sleep 1
done

exit 1
