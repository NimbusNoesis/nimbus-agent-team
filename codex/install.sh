#!/bin/sh
# Installs the software-development-team coding team into OpenAI Codex CLI.
#
# What it does (idempotent — safe to re-run):
#   1. Resolves the absolute path to the shared MCP server (plugins/software-development-team/server).
#   2. Wires an [mcp_servers.software-development-team] block into ~/.codex/config.toml
#      (skips with a warning if a block of that name already exists).
#   3. Copies the Codex agent definitions (agents/*.toml) into ~/.codex/agents/.
#   4. Copies the Codex skills (skills/<name>/SKILL.md) into ~/.codex/skills/.
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
SKILLS_DIR="$CODEX_HOME/skills"
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

mkdir -p "$CODEX_HOME" "$AGENTS_DIR" "$SKILLS_DIR" "$DATA_DIR"

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

# --- 3. Install skills -----------------------------------------------------
# Each skill is a directory containing SKILL.md (plus optional scripts/assets).
log "Installing skills into $SKILLS_DIR"
for d in "$SCRIPT_DIR"/skills/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  rm -rf "$SKILLS_DIR/$name"
  cp -R "$d" "$SKILLS_DIR/$name"
  log "  skill: $name"
done

# --- Done ------------------------------------------------------------------
cat <<EOF

[install] Done.

  Server:  $SERVER_DIR
  Build:   $DATA_DIR  (created on first launch, ~30-60s)
  Config:  $CONFIG_FILE
  Agents:  $AGENTS_DIR
  Skills:  $SKILLS_DIR

Next:
  1. Start Codex:    codex
  2. Kick off a run: /begin <task description>   (or type \$begin, or run /skills)
     (the dashboard URL prints at the start of the run)

First launch compiles the server; the startup_timeout_sec = 120 setting gives it
room. If the MCP client still times out, relaunch — the build will have finished.

To uninstall: remove the [mcp_servers.$SERVER_NAME] block from $CONFIG_FILE and
delete the copied agent files from $AGENTS_DIR and the skill directories
(begin, status, memory, resume, plan, research, review) from $SKILLS_DIR.
EOF
