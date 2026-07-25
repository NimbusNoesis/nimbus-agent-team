#!/bin/sh
# Installs the software-development-team coding team into Cursor.
#
# What it does (idempotent — safe to re-run):
#   1. Resolves the absolute path to the shared MCP server (plugins/software-development-team/server).
#   2. Wires a mcpServers["software-development-team"] entry into ~/.cursor/mcp.json
#      (skips with a warning if an entry of that name already exists).
#   3. Copies the Cursor subagent definitions (agents/*.md) into ~/.cursor/agents/.
#   4. Copies the Cursor commands (commands/*.md) into ~/.cursor/commands/.
#
# The MCP server is the SAME host-agnostic server the Claude Code plugin and the
# Codex distribution use; it builds itself on first launch into a writable data
# dir. Nothing here touches or disables the other hosts — all three coexist (run
# them sequentially on a given project: concurrent sessions race on .team/ state).
#
# Usage: sh cursor/install.sh
set -eu

# --- Resolve paths ---------------------------------------------------------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SERVER_DIR="$REPO_ROOT/plugins/software-development-team/server"

CURSOR_HOME="${CURSOR_HOME:-$HOME/.cursor}"
CONFIG_FILE="$CURSOR_HOME/mcp.json"
AGENTS_DIR="$CURSOR_HOME/agents"
COMMANDS_DIR="$CURSOR_HOME/commands"
DATA_DIR="$CURSOR_HOME/data/software-development-team"

SERVER_NAME="software-development-team"

log() { printf '[install] %s\n' "$1"; }
err() { printf '[install] ERROR: %s\n' "$1" >&2; }

# --- Sanity checks ---------------------------------------------------------
if [ ! -f "$SERVER_DIR/launch.sh" ]; then
  err "MCP server not found at $SERVER_DIR (expected launch.sh). Run this script from the repo checkout."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  err "node not found on PATH. The MCP server needs Node.js 18+."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found on PATH. The MCP server uses it for the first-launch build."
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
  err "Node.js 18+ is required. Found: $(node --version 2>/dev/null || printf 'unknown')."
  exit 1
fi

mkdir -p "$CURSOR_HOME" "$AGENTS_DIR" "$COMMANDS_DIR" "$DATA_DIR"

# --- 1. Wire the MCP server into mcp.json ----------------------------------
# JSON.stringify handles all path escaping, so hostile characters in the
# checkout or CURSOR_HOME path cannot corrupt or inject into mcp.json.
#
# The rewrite goes through a temp file + atomic rename, matching the server's
# own durability convention (state/persistence.ts). This file is the user's
# GLOBAL MCP config: a truncating in-place write that died midway would take
# every other server they have configured with it.
node - "$CONFIG_FILE" "$SERVER_DIR" "$DATA_DIR" "$SERVER_NAME" <<'JS'
const fs = require('node:fs');
const [, configFile, serverDir, dataDir, serverName] = process.argv.slice(1);

let config = {};
if (fs.existsSync(configFile)) {
  const raw = fs.readFileSync(configFile, 'utf8').trim();
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch (error) {
      console.error(`[install] ERROR: ${configFile} is not valid JSON: ${error.message}`);
      console.error('[install] Fix or move the file, then re-run the installer.');
      process.exit(1);
    }
  }
}
if (typeof config !== 'object' || config === null || Array.isArray(config)) {
  console.error(`[install] ERROR: ${configFile} must contain a JSON object.`);
  process.exit(1);
}
config.mcpServers = config.mcpServers ?? {};
if (typeof config.mcpServers !== 'object' || config.mcpServers === null || Array.isArray(config.mcpServers)) {
  console.error(`[install] ERROR: "mcpServers" in ${configFile} must be a JSON object.`);
  process.exit(1);
}
if (config.mcpServers[serverName]) {
  console.log(`[install] mcp.json already has mcpServers["${serverName}"] — leaving it untouched.`);
  console.log(`[install]   If paths changed, edit the entry in ${configFile} by hand.`);
  process.exit(0);
}
config.mcpServers[serverName] = {
  type: 'stdio',
  command: 'sh',
  args: [`${serverDir}/launch.sh`, serverDir, dataDir],
};

// Atomic replace: write a sibling temp file, then rename over the original.
// rename(2) within a directory is atomic, so a reader either sees the old
// config or the new one — never a truncated file.
const tmpFile = `${configFile}.tmp.${process.pid}`;
try {
  fs.writeFileSync(tmpFile, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmpFile, configFile);
} catch (error) {
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    // Nothing to clean up if the temp file was never created.
  }
  console.error(`[install] ERROR: could not write ${configFile}: ${error.message}`);
  process.exit(1);
}
console.log(`[install] Added mcpServers["${serverName}"] to ${configFile}`);
JS

# --- 2. Install subagent definitions ---------------------------------------
log "Installing subagent definitions into $AGENTS_DIR"
for f in "$SCRIPT_DIR"/agents/*.md; do
  [ -e "$f" ] || continue
  cp "$f" "$AGENTS_DIR/"
  log "  subagent: $(basename "$f")"
done

# --- 3. Install commands ----------------------------------------------------
log "Installing commands into $COMMANDS_DIR"
for f in "$SCRIPT_DIR"/commands/*.md; do
  [ -e "$f" ] || continue
  cp "$f" "$COMMANDS_DIR/"
  log "  command: $(basename "$f")"
done

# --- Done ------------------------------------------------------------------
cat <<EOF

[install] Done.

  Server:    $SERVER_DIR
  Build:     $DATA_DIR  (created on first launch, ~30-60s)
  Config:    $CONFIG_FILE
  Subagents: $AGENTS_DIR
  Commands:  $COMMANDS_DIR

Next:
  1. Restart Cursor (or reload the window) so it picks up the new MCP server,
     subagents, and commands.
  2. Confirm registration: Cursor Settings -> MCP should list
     $SERVER_NAME with its team_* tools.
  3. Develop a deep plan:   /deep-plan <task description>
  4. Kick off a run:        /begin <task description>

First launch compiles the server (~30-60s); if the tools do not appear, give the
server time to build, then check the MCP entry in $CONFIG_FILE and reload
Cursor. A server log URL alone does not register MCP tools into an
already-running Cursor session.

To uninstall: remove the mcpServers["$SERVER_NAME"] entry from $CONFIG_FILE and
delete the copied subagent definitions (coder, documentation, plan-critic,
planner, recursive-planner, researcher, reviewer) from $AGENTS_DIR and the
commands (begin, deep-plan, status, memory, resume, plan, research, review)
from $COMMANDS_DIR.
EOF
