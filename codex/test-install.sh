#!/bin/sh
# Smoke-test the Codex distribution without modifying the caller's CODEX_HOME.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CODEX_BIN=${CODEX_BIN:-codex}
TEST_HOME=$(mktemp -d "${TMPDIR:-/tmp}/software-development-team-codex.XXXXXX")

err() {
  printf '[test-install] ERROR: %s\n' "$1" >&2
}

cleanup() {
  rm -rf "$TEST_HOME"
}
trap cleanup EXIT HUP INT TERM

if ! command -v python3 >/dev/null 2>&1; then
  err "Python 3.11+ is required to parse generated TOML, but python3 was not found on PATH."
  exit 1
fi
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
  err "Python 3.11+ is required to parse generated TOML; found: $(python3 --version 2>&1 || printf 'unknown')."
  exit 1
fi

case $CODEX_BIN in
  */*)
    if [ ! -f "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; then
      err "CODEX_BIN path is not an executable file: $CODEX_BIN"
      exit 1
    fi
    ;;
  *)
    if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
      err "CODEX_BIN command was not found on PATH: $CODEX_BIN"
      exit 1
    fi
    ;;
esac

CODEX_HOME="$TEST_HOME" sh "$SCRIPT_DIR/install.sh"
CODEX_HOME="$TEST_HOME" sh "$SCRIPT_DIR/install.sh" >/dev/null

python3 - "$TEST_HOME/config.toml" "$TEST_HOME" <<'PY'
import pathlib
import sys
import tomllib

config_path = pathlib.Path(sys.argv[1])
codex_home = pathlib.Path(sys.argv[2])
assert config_path.read_text().count("[mcp_servers.software-development-team]") == 1
config = tomllib.loads(config_path.read_text())
server = config["mcp_servers"]["software-development-team"]

assert server["command"] == "sh"
assert server["startup_timeout_sec"] == 120
assert len(server["args"]) == 3
assert pathlib.Path(server["args"][0]).is_file()
assert pathlib.Path(server["args"][1]).is_dir()
assert pathlib.Path(server["args"][2]) == codex_home / "data" / "software-development-team"

expected_roles = {
    "coder.toml", "documentation.toml", "plan-critic.toml", "planner.toml",
    "researcher.toml", "reviewer.toml",
}
assert {path.name for path in (codex_home / "agents").glob("*.toml")} == expected_roles
for role_path in (codex_home / "agents").glob("*.toml"):
    role = tomllib.loads(role_path.read_text())
    assert role["name"] == role_path.stem
    assert role["developer_instructions"].strip()

expected_skills = {"begin", "memory", "plan", "research", "resume", "review", "status"}
assert {path.name for path in (codex_home / "skills").iterdir() if path.is_dir()} == expected_skills
for name in expected_skills:
    assert (codex_home / "skills" / name / "SKILL.md").is_file()

begin_skill = (codex_home / "skills" / "begin" / "SKILL.md").read_text()
plan_skill = (codex_home / "skills" / "plan" / "SKILL.md").read_text()
resume_skill = (codex_home / "skills" / "resume" / "SKILL.md").read_text()
status_skill = (codex_home / "skills" / "status" / "SKILL.md").read_text()
research_skill = (codex_home / "skills" / "research" / "SKILL.md").read_text()
review_skill = (codex_home / "skills" / "review" / "SKILL.md").read_text()

assert "STANDALONE-review prompt overrides the reviewer role's normal result-submission rule" in begin_skill
assert "do NOT call `team_submit_result`" in begin_skill
assert "final response must be only a valid JSON array" in begin_skill
assert "final response MUST be only a valid JSON array" in plan_skill
for skill_text in (begin_skill, plan_skill, resume_skill, status_skill, research_skill, review_skill):
    assert "${CODEX_HOME:-$HOME/.codex}" in skill_text
    assert "$CODEX_BIN" not in skill_text
for skill_text in (begin_skill, resume_skill, status_skill):
    assert "All team MCP tools are absent" in skill_text
    assert "Only `team_dashboard_url` is unavailable" in skill_text
    assert "mcp get software-development-team" in skill_text
    assert "fresh Codex" in skill_text
    assert "session before retrying" in skill_text
    assert "cannot register tools" in skill_text
    assert "already-running session" in skill_text
assert "Dashboard: <url, when `team_dashboard_url` is registered; otherwise unavailable (team_dashboard_url is not registered)>" in status_skill
PY

CODEX_HOME="$TEST_HOME" "$CODEX_BIN" --strict-config --help >/dev/null
CODEX_HOME="$TEST_HOME" "$CODEX_BIN" mcp get software-development-team >/dev/null
CODEX_HOME="$TEST_HOME" "$CODEX_BIN" debug prompt-input 'Start the coding team.' > "$TEST_HOME/prompt-input.json"
grep -F -- '- begin:' "$TEST_HOME/prompt-input.json" >/dev/null

# install.sh derives its server path from its own checkout. Copy that complete
# sibling topology into paths containing characters that must be TOML-escaped.
HOSTILE_COMPONENT=$(printf 'toml-"\\\t\r\n\001-[mcp_servers.inject]-end')
FIXTURE_ROOT="$TEST_HOME/fixture-$HOSTILE_COMPONENT"
HOSTILE_CODEX_HOME="$FIXTURE_ROOT/codex-home-$HOSTILE_COMPONENT"
mkdir -p "$FIXTURE_ROOT/plugins"
cp -R "$SCRIPT_DIR" "$FIXTURE_ROOT/codex"
cp -R "$SCRIPT_DIR/../plugins/software-development-team" "$FIXTURE_ROOT/plugins/software-development-team"

CODEX_HOME="$HOSTILE_CODEX_HOME" sh "$FIXTURE_ROOT/codex/install.sh" >/dev/null

python3 - "$HOSTILE_CODEX_HOME/config.toml" "$FIXTURE_ROOT" "$HOSTILE_CODEX_HOME" <<'PY'
import pathlib
import sys
import tomllib

config_path = pathlib.Path(sys.argv[1])
fixture_root = pathlib.Path(sys.argv[2])
codex_home = pathlib.Path(sys.argv[3])
config = tomllib.loads(config_path.read_text())

assert set(config) == {"mcp_servers"}
assert list(config["mcp_servers"]) == ["software-development-team"]
server = config["mcp_servers"]["software-development-team"]
server_dir = fixture_root / "plugins" / "software-development-team" / "server"

assert server["command"] == "sh"
assert server["startup_timeout_sec"] == 120
assert server["args"] == [
    str(server_dir / "launch.sh"),
    str(server_dir),
    str(codex_home / "data" / "software-development-team"),
]
PY

printf '%s\n' "Codex distribution smoke test passed."
