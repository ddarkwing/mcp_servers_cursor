#!/usr/bin/env bash
# MCP bridge for OpenCode V2.
# Cursor (or any MCP client) starts this over stdio.
#
# Cursor does not inherit a login-shell PATH, so resolve the binaries explicitly.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PATH="$HOME/.opencode/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

OPENCODE_BIN="${OPENCODE_BIN:-}"
[ -n "$OPENCODE_BIN" ] || OPENCODE_BIN="$(command -v opencode || true)"
[ -n "$OPENCODE_BIN" ] || { [ -x "$HOME/.opencode/bin/opencode" ] && OPENCODE_BIN="$HOME/.opencode/bin/opencode"; } || true

NODE_BIN="${NODE_BIN:-}"
[ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { [ -x /usr/local/bin/node ] && NODE_BIN=/usr/local/bin/node; } || true
[ -n "$NODE_BIN" ] || { [ -x /usr/bin/node ] && NODE_BIN=/usr/bin/node; } || true

if [ -z "$NODE_BIN" ]; then
  echo "Node.js not found. Install Node.js 22+ to use this MCP bridge." >&2
  exit 1
fi

if [ -z "${OPENCODE_BASE_URL:-}" ]; then
  URL=""
  if [ -n "$OPENCODE_BIN" ]; then
    URL="$("$OPENCODE_BIN" service status 2>/dev/null | grep -Eo 'https?://[^[:space:]]+' | head -1 || true)"
  fi
  if [ -z "$URL" ] && [ -n "$OPENCODE_BIN" ]; then
    # The MCP client may start before the OpenCode service is up.
    "$OPENCODE_BIN" service start >/dev/null 2>&1 || true
    for _ in $(seq 1 60); do
      URL="$("$OPENCODE_BIN" service status 2>/dev/null | grep -Eo 'https?://[^[:space:]]+' | head -1 || true)"
      [ -n "$URL" ] && break
      sleep 0.25
    done
  fi
  if [ -z "$URL" ]; then
    echo "OpenCode service is not running and could not be started." >&2
    echo "Run manually: ${OPENCODE_BIN:-opencode} service start" >&2
    exit 1
  fi
  export OPENCODE_BASE_URL="$URL"
fi

if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ] && [ -f "$HOME/.config/opencode/service.json" ]; then
  export OPENCODE_SERVER_PASSWORD="$("$NODE_BIN" -e '
const fs = require("fs"), os = require("os"), path = require("path");
try {
  const p = path.join(os.homedir(), ".config/opencode/service.json");
  process.stdout.write((JSON.parse(fs.readFileSync(p, "utf8")).password) || "");
} catch {}
' 2>/dev/null || true)"
fi

if [ -f "$DIR/dist/index.mjs" ]; then
  exec "$NODE_BIN" "$DIR/dist/index.mjs"
fi
exec "$NODE_BIN" "$DIR/src/index.mjs"
