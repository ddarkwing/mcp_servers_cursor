#!/usr/bin/env bash
# Install the OpenCode V2 MCP bridge and register it in Cursor.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.config/opencode/mcp-bridge}"
WITH_AGENTS=1

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  --dir <path>   Install directory (default: ~/.config/opencode/mcp-bridge)
  --no-agents    Do not install the example agents
  -h, --help     Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --no-agents) WITH_AGENTS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

export PATH="$HOME/.opencode/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || { [ -x /usr/local/bin/node ] && NODE_BIN=/usr/local/bin/node; } || true
[ -n "$NODE_BIN" ] || { [ -x /usr/bin/node ] && NODE_BIN=/usr/bin/node; } || true
if [ -z "$NODE_BIN" ]; then
  echo "Node.js not found. Install Node.js 22+ first." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ required, found $("$NODE_BIN" -v)." >&2
  exit 1
fi

if command -v opencode >/dev/null 2>&1; then
  OC_VERSION="$(opencode --version 2>/dev/null | grep -Eo '[0-9]+(\.[0-9]+)+' | head -1 || true)"
  case "$OC_VERSION" in
    2.*) ;;
    "") ;;
    *) echo "Warning: OpenCode $OC_VERSION detected; this bridge targets OpenCode V2." >&2 ;;
  esac
else
  echo "Warning: 'opencode' not found in PATH. Install OpenCode V2 before using the bridge." >&2
fi

echo "Installing to: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/dist"
cp -R "$DIR/dist" "$INSTALL_DIR/dist"
cp "$DIR/run.sh" "$DIR/README.md" "$DIR/LICENSE" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/run.sh"
if [ -f "$DIR/run.cmd" ]; then cp "$DIR/run.cmd" "$INSTALL_DIR/"; fi

if [ "$WITH_AGENTS" = 1 ] && [ -d "$DIR/agents" ]; then
  mkdir -p "$HOME/.config/opencode/agents"
  for f in "$DIR"/agents/*.md; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    if [ -e "$HOME/.config/opencode/agents/$base" ]; then
      echo "Agent already exists, skipped: $base"
    else
      cp "$f" "$HOME/.config/opencode/agents/$base"
      echo "Installed agent: $base"
    fi
  done
fi

"$NODE_BIN" - "$INSTALL_DIR/run.sh" <<'EOF'
const fs = require("fs");
const os = require("os");
const path = require("path");

const run = process.argv[2];
const dir = path.join(os.homedir(), ".cursor");
const file = path.join(dir, "mcp.json");
fs.mkdirSync(dir, { recursive: true });

let cfg = { mcpServers: {} };
if (fs.existsSync(file)) {
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`\nCould not parse ${file}: ${err.message}`);
    console.error("Add this entry manually:\n");
    console.error(JSON.stringify({ mcpServers: { opencode: { command: run, args: [] } } }, null, 2));
    process.exit(0);
  }
}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.opencode = { command: run, args: [] };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log(`Cursor config updated: ${file}`);
EOF

cat <<EOF

Done.

Next steps:
  1. Restart Cursor (or use "Restart" on the opencode MCP server).
  2. Make sure the OpenCode service is running: opencode service status
  3. In Cursor, call oc_agents, then oc_task.

Optional env for ~/.cursor/mcp.json:
  "env": {
    "OPENCODE_FORCE_MODEL": "opencode/deepseek-v4.1-flash-free",
    "OPENCODE_FALLBACK_MODEL": "deepseek/deepseek-flash"
  }

Docs: $INSTALL_DIR/README.md
EOF
