#!/bin/sh
set -eu

DOCKER_CLI="${NANOCLAW_DOCKER_CLI:-/usr/local/bin/docker}"
if [ ! -x "$DOCKER_CLI" ] && [ -x /opt/homebrew/bin/docker ]; then
  DOCKER_CLI="/opt/homebrew/bin/docker"
fi

OPEN_CMD="${NANOCLAW_OPEN_CMD:-/usr/bin/open}"
NODE_BIN="${NANOCLAW_NODE_BIN:-/opt/homebrew/bin/node}"
DIST_ENTRY="${NANOCLAW_DIST_ENTRY:-/Users/bob/nanoclaw/dist/index.js}"
TIMEOUT_SECONDS="${NANOCLAW_DOCKER_TIMEOUT_SECONDS:-120}"
POLL_SECONDS="${NANOCLAW_DOCKER_POLL_SECONDS:-3}"

if ! "$DOCKER_CLI" info >/dev/null 2>&1; then
  "$OPEN_CMD" -a Docker >/dev/null 2>&1 || true
fi

elapsed=0
while ! "$DOCKER_CLI" info >/dev/null 2>&1; do
  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    echo "Docker did not become ready within ${TIMEOUT_SECONDS}s" >&2
    exit 1
  fi
  sleep "$POLL_SECONDS"
  elapsed=$((elapsed + POLL_SECONDS))
done

exec "$NODE_BIN" "$DIST_ENTRY"
