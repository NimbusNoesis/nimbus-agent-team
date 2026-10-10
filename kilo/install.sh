#!/bin/sh
# Installs the software-development-team coding team into Kilo Code.
#
# Idempotent — safe to re-run. It:
#   1. Resolves the shared MCP server (plugins/software-development-team/server).
#   2. Merges mcp["software-development-team"] into ~/.config/kilo/kilo.jsonc
#      (backing the file up first; keeps an existing entry of that name).
#   3. Copies the agent definitions into ~/.config/kilo/agent/.
#   4. Copies the commands into ~/.config/kilo/command/.
#
# The MCP server is the SAME host-agnostic server the Claude Code plugin, Codex
# and Cursor distributions use; it self-builds on first launch into a writable
# data dir. Nothing here touches the other hosts.
#
# Kilo reads kilo.jsonc as JSONC, but a programmatic merge cannot preserve
# comments, so the installer keeps a timestamped backup and rewrites the file
# as plain JSON. Usage: sh kilo/install.sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SERVER_DIR="$REPO_ROOT/plugins/software-development-team/server"

KILO_HOME="${KILO_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}"
CONFIG_FILE="$KILO_HOME/kilo.jsonc"
AGENTS_DIR="$KILO_HOME/agent"
COMMANDS_DIR="$KILO_HOME/command"
DATA_DIR="$KILO_HOME/data/software-development-team"
SERVER_NAME="software-development-team"

log() { printf '[install] %s\n' "$1"; }
err() { printf '[install] ERROR: %s\n' "$1" >&2; }

[ -f "$SERVER_DIR/launch.sh" ] || { err "MCP server not found at $SERVER_DIR"; exit 1; }
command -v node >/dev/null 2>&1 || { err "node not found (needs Node.js 18+)"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' 2>/dev/null \
  || { err "Node.js 18+ required (found $(node --version 2>/dev/null))"; exit 1; }

mkdir -p "$KILO_HOME" "$AGENTS_DIR" "$COMMANDS_DIR" "$DATA_DIR"

# --- 1. Merge the MCP server into kilo.jsonc (JSONC-tolerant read) ----------
node - "$CONFIG_FILE" "$SERVER_DIR" "$DATA_DIR" "$SERVER_NAME" <<'JS'
const fs = require('node:fs');
const [, configFile, serverDir, dataDir, serverName] = process.argv.slice(1);

// Tolerant JSONC read: strip // and /* */ comments before JSON.parse. Comments
// are not preserved on write; a timestamped backup keeps the original.
function readJsonc(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  const stripped = raw
    .replace(/\\"|"(?:\\.|[^"\\])*"|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g,
             (m) => (m[0] === '/' ? '' : m));
  const t = stripped.trim();
  if (!t) return {};
  try { return JSON.parse(t); }
  catch (e) {
    console.error(`[install] ERROR: ${file} is not valid JSON/JSONC: ${e.message}`);
    console.error('[install] Fix or move the file, then re-run.');
    process.exit(1);
  }
}

const config = readJsonc(configFile);
if (typeof config !== 'object' || config === null || Array.isArray(config)) {
  console.error('[install] ERROR: top-level config is not an object.'); process.exit(1);
}
config.mcp = config.mcp || {};
if (config.mcp[serverName]) {
  console.error(`[install] mcp["${serverName}"] already present — leaving it as is.`);
} else {
  config.mcp[serverName] = {
    type: 'local',
    command: ['sh', `${serverDir}/launch.sh`, serverDir, dataDir],
    enabled: true,
    timeout: 60000,
  };
  if (fs.existsSync(configFile)) {
    const bak = `${configFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(configFile, bak);
    console.error(`[install] backed up existing config to ${bak}`);
  }
  const tmp = `${configFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, configFile);
  console.error(`[install] wrote mcp["${serverName}"] into ${configFile}`);
}
JS

# --- 2. Copy agents and commands -------------------------------------------
cp "$SCRIPT_DIR"/agents/*.md "$AGENTS_DIR"/ && log "installed agents -> $AGENTS_DIR"
cp "$SCRIPT_DIR"/commands/*.md "$COMMANDS_DIR"/ && log "installed commands -> $COMMANDS_DIR"

log "Done. In VS Code (Kilo Code) reload the window, then type /begin <task>."
log "Agents: $(ls "$SCRIPT_DIR"/agents | sed 's/\.md//' | tr '\n' ' ')"
log "Commands: $(ls "$SCRIPT_DIR"/commands | sed 's/\.md//' | tr '\n' ' ')"
