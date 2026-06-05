#!/bin/sh
# Installs the software-development-team coding team into OpenAI Codex CLI.
#
# What it does (idempotent — safe to re-run):
#   1. Resolves the absolute path to the shared MCP server (plugins/software-development-team/server).
#   2. Wires an [mcp_servers.software-development-team] block into ~/.codex/config.toml
#      (skips with a warning if a block of that name already exists).
#   3. Copies the Codex agent definitions (agents/*.toml) into ~/.codex/agents/.
#   4. Copies the Codex prompts (prompts/*.md) into ~/.codex/prompts/.
#
# The MCP server is the SAME host-agnostic server the Claude Code plugin uses;
# it builds itself on first launch into a writable data dir. Nothing here touches
# or disables the Claude Code plugin — the two hosts coexist.
#
# Usage: sh codex/install.sh
set -eu

# --- Resolve paths ---------------------------------------------------------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SERVER_DIR="$REPO_ROOT/plugins/software-development-team/server"

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG_FILE="$CODEX_HOME/config.toml"
AGENTS_DIR="$CODEX_HOME/agents"
PROMPTS_DIR="$CODEX_HOME/prompts"
DATA_DIR="$CODEX_HOME/data/software-development-team"

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

mkdir -p "$CODEX_HOME" "$AGENTS_DIR" "$PROMPTS_DIR" "$DATA_DIR"

# --- 1. Wire the MCP server into config.toml -------------------------------
if [ -f "$CONFIG_FILE" ] && grep -q "^\[mcp_servers\.$SERVER_NAME\]" "$CONFIG_FILE"; then
  log "config.toml already has [mcp_servers.$SERVER_NAME] — leaving it untouched."
  log "  If paths changed, edit the block in $CONFIG_FILE by hand."
else
  log "Adding [mcp_servers.$SERVER_NAME] to $CONFIG_FILE"
  {
    printf '\n'
    printf '# Added by software-development-team codex/install.sh\n'
    printf '[mcp_servers.%s]\n' "$SERVER_NAME"
    printf 'command = "sh"\n'
    printf 'args = ["%s/launch.sh", "%s", "%s"]\n' "$SERVER_DIR" "$SERVER_DIR" "$DATA_DIR"
    printf 'startup_timeout_sec = 120\n'
  } >> "$CONFIG_FILE"
fi

# --- 2. Install agents -----------------------------------------------------
log "Installing agent definitions into $AGENTS_DIR"
for f in "$SCRIPT_DIR"/agents/*.toml; do
  [ -e "$f" ] || continue
  cp "$f" "$AGENTS_DIR/"
  log "  agent: $(basename "$f")"
done

# --- 3. Install prompts ----------------------------------------------------
log "Installing prompts into $PROMPTS_DIR"
for f in "$SCRIPT_DIR"/prompts/*.md; do
  [ -e "$f" ] || continue
  cp "$f" "$PROMPTS_DIR/"
  log "  prompt: /$(basename "$f" .md)"
done

# --- Done ------------------------------------------------------------------
cat <<EOF

[install] Done.

  Server:  $SERVER_DIR
  Build:   $DATA_DIR  (created on first launch, ~30-60s)
  Config:  $CONFIG_FILE
  Agents:  $AGENTS_DIR
  Prompts: $PROMPTS_DIR

Next:
  1. Start Codex:   codex
  2. Kick off a run: /begin <task description>
     (the dashboard URL prints at the start of the run)

First launch compiles the server; the startup_timeout_sec = 120 setting gives it
room. If the MCP client still times out, relaunch — the build will have finished.

To uninstall: remove the [mcp_servers.$SERVER_NAME] block from $CONFIG_FILE and
delete the copied files from $AGENTS_DIR and $PROMPTS_DIR.
EOF
