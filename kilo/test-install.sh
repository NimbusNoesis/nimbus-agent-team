#!/bin/sh
# Validates kilo/install.sh against a throwaway KILO_CONFIG_HOME so your real
# ~/.config/kilo is never touched. Checks: mcp entry written, agents+commands
# copied, and (if an existing config is present) that it is backed up and merged
# without dropping keys. Usage: sh kilo/test-install.sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export KILO_CONFIG_HOME="$TMP/kilo"
mkdir -p "$KILO_CONFIG_HOME"
# Seed a pre-existing JSONC config with a comment and an unrelated key.
cat > "$KILO_CONFIG_HOME/kilo.jsonc" <<'J'
{ // keep me
  "model": "venice/e2ee-glm-5-3-p"
}
J
sh "$SCRIPT_DIR/install.sh"
fail=0
grep -q '"software-development-team"' "$KILO_CONFIG_HOME/kilo.jsonc" || { echo "FAIL: mcp entry missing"; fail=1; }
grep -q '"model": "venice/e2ee-glm-5-3-p"' "$KILO_CONFIG_HOME/kilo.jsonc" || { echo "FAIL: pre-existing key lost"; fail=1; }
ls "$KILO_CONFIG_HOME"/kilo.jsonc.bak-* >/dev/null 2>&1 || { echo "FAIL: no backup"; fail=1; }
[ -f "$KILO_CONFIG_HOME/agent/coder.md" ] || { echo "FAIL: agents not copied"; fail=1; }
[ -f "$KILO_CONFIG_HOME/command/begin.md" ] || { echo "FAIL: commands not copied"; fail=1; }
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$KILO_CONFIG_HOME/kilo.jsonc" \
  || { echo "FAIL: output not valid JSON"; fail=1; }
# Re-run must be idempotent (entry kept, no crash).
sh "$SCRIPT_DIR/install.sh" >/dev/null
[ "$fail" = 0 ] && echo "TEST-INSTALL: PASS" || { echo "TEST-INSTALL: FAIL"; exit 1; }
