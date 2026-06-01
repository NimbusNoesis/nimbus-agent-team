#!/bin/sh
# MCP server entry point used by .mcp.json. Guarantees the server is installed and
# built (building it if needed), then launches it. Because the build runs inside
# this launch command, the server is always present before `node` is invoked —
# independent of any hook/MCP startup ordering.
#
# Usage (from .mcp.json): sh launch.sh <SRC_DIR> [BUILD_DATA_DIR]
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC_DIR="${1:-$SCRIPT_DIR}"
DATA_DIR="${2:-${CLAUDE_PLUGIN_DATA:-}}"

# Defend against an arg that didn't get interpolated by the host (e.g. a literal
# "${CLAUDE_PLUGIN_DATA}"): fall back to the env var, then to in-place.
case "$SRC_DIR" in *'${'*) SRC_DIR="$SCRIPT_DIR" ;; esac
case "$DATA_DIR" in *'${'*) DATA_DIR="${CLAUDE_PLUGIN_DATA:-}" ;; esac
case "$DATA_DIR" in *'${'*) DATA_DIR="" ;; esac

# ensure-build.sh prints the entry path on stdout (diagnostics go to stderr).
ENTRY="$(sh "$SCRIPT_DIR/scripts/ensure-build.sh" "$SRC_DIR" "$DATA_DIR")"

# Hand off to the MCP server over stdio, preserving the inherited cwd (the user's
# project) so TEAM_DIR (.team) resolves there.
exec node "$ENTRY"
