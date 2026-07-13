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
import re
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
    "recursive-planner.toml", "researcher.toml", "reviewer.toml",
}
installed_agents = sorted((codex_home / "agents").glob("*.toml"))
assert {path.name for path in installed_agents} == expected_roles
agent_texts = {}
for role_path in installed_agents:
    role_text = role_path.read_text()
    agent_texts[role_path.name] = role_text
    role = tomllib.loads(role_text)
    assert role["name"] == role_path.stem
    assert role["developer_instructions"].strip()

expected_skills = {"begin", "deep-plan", "memory", "plan", "research", "resume", "review", "status"}
assert {path.name for path in (codex_home / "skills").iterdir() if path.is_dir()} == expected_skills
skill_paths = [codex_home / "skills" / name / "SKILL.md" for name in sorted(expected_skills)]
assert all(path.is_file() for path in skill_paths)
skill_texts = {path.parent.name: path.read_text() for path in skill_paths}

# Native task labels are constrained more tightly than role/template names. Check
# every literal in the installed copies so future skills and agent comments cannot
# accidentally introduce a label that native spawn_agent rejects.
task_name_pattern = re.compile(r'task_name\s*:\s*"([^"]+)"')
task_names = [
    match.group(1)
    for text in (*skill_texts.values(), *agent_texts.values())
    for match in task_name_pattern.finditer(text)
]
assert task_names
assert all(re.fullmatch(r"[a-z0-9_]+", name) for name in task_names), task_names

begin_skill = skill_texts["begin"]
deep_plan_skill = skill_texts["deep-plan"]
plan_skill = skill_texts["plan"]
resume_skill = skill_texts["resume"]
status_skill = skill_texts["status"]
research_skill = skill_texts["research"]
review_skill = skill_texts["review"]

expected_mcp_namespace = "mcp__software_development_team__"
invalid_raw_mcp_namespace = "mcp__software-development-team__"
for name in ("begin", "deep-plan", "plan", "resume", "status", "memory", "research"):
    assert expected_mcp_namespace in skill_texts[name], name
for name, text in agent_texts.items():
    assert expected_mcp_namespace in text, name
for name, text in (*skill_texts.items(), *agent_texts.items()):
    assert invalid_raw_mcp_namespace not in text, name

plan_critic = tomllib.loads(agent_texts["plan-critic.toml"])
recursive_planner = tomllib.loads(agent_texts["recursive-planner.toml"])
assert plan_critic["name"] == "plan-critic"
assert recursive_planner["name"] == "recursive-planner"
assert recursive_planner["sandbox_mode"] == "read-only"
assert "pre-run, pre-approval, read-only specialist" in recursive_planner["developer_instructions"]
assert "never recurse or dispatch another agent yourself" in recursive_planner["developer_instructions"]
assert "protocolVersion" in recursive_planner["developer_instructions"]
assert "dossierSignature" in recursive_planner["developer_instructions"]
assert "compactState" in recursive_planner["developer_instructions"]
assert "team_start-Compatible Appendix" in recursive_planner["developer_instructions"]
assert "current planning workflow's unique grammar-safe `plan_critic_<W>`" in agent_texts["plan-critic.toml"]
assert 'task_name: "plan_critic_1"' in agent_texts["plan-critic.toml"]
assert 'MUST use task_name: "plan_critic"' not in agent_texts["plan-critic.toml"]
assert 'task_name: "plan_critic_1"' in begin_skill
assert 'task_name: "plan_critic_1"' in plan_skill
assert "template filename remain `plan-critic`" in plan_skill
assert 'task_name: "planner_draft_1"' in plan_skill
assert 'task_name: "planner_final_1"' in plan_skill
assert "fresh positive integer" in begin_skill
assert "planner_draft_<W>" in begin_skill
assert "plan_critic_<W>" in begin_skill
assert "planner_final_<W>" in begin_skill
assert "does not depend on a run ID" in begin_skill
assert "later plan or begin invocation" in begin_skill
assert "unique invocation label" in begin_skill
assert "never loads or selects a template" in begin_skill
assert "<role>_step_<N>_attempt_<A>" in begin_skill
assert "parallel same-role workers" in begin_skill
assert "coder_step_2_attempt_1" in resume_skill
assert "reviewer_step_2_attempt_1" in resume_skill
assert "existing agent path is never reused" in resume_skill

deep_plan_labels = [
    "recursive_planner_<W>_round_1",
    "recursive_planner_<W>_round_2",
    "recursive_planner_<W>_round_3",
    "deep_plan_research_<W>_probe_1",
    "deep_plan_research_<W>_probe_2",
    "deep_plan_critic_<W>",
    "recursive_planner_<W>_synthesis",
]
assert all(label in deep_plan_skill for label in deep_plan_labels)
resolved_deep_plan_labels = [
    "recursive_planner_1_round_1",
    "recursive_planner_1_round_2",
    "recursive_planner_1_round_3",
    "deep_plan_research_1_probe_1",
    "deep_plan_research_1_probe_2",
    "deep_plan_critic_1",
    "recursive_planner_1_synthesis",
]
assert len(resolved_deep_plan_labels) == len(set(resolved_deep_plan_labels)) == 7
assert all(re.fullmatch(r"[a-z0-9_]+", label) for label in resolved_deep_plan_labels)
assert all(label in deep_plan_skill for label in resolved_deep_plan_labels)
assert "complete seven-label set is unused" in deep_plan_skill
assert "Reserve/check the complete set before the first spawn" in deep_plan_skill
assert "A later deep-plan invocation in the same session MUST allocate another `<W>`" in deep_plan_skill
assert "task labels never select role templates" in deep_plan_skill
assert "Recover the original `<W>`" in deep_plan_skill
assert "prerun-deep-plan-<D>-synthesis-reflection" in deep_plan_skill
assert "team_start({ steps: appendix })" in deep_plan_skill
assert "MUST NOT call `team_start`" in deep_plan_skill

assert "pre-approval, read-only role" in agent_texts["planner.toml"]
assert "pre-approval, read-only role" in agent_texts["plan-critic.toml"]
assert "explicitly override its reflection contract" in begin_skill
assert "Reflection key override" in begin_skill
assert "explicit pre-run reflection override" in plan_skill
assert "Reflection override: this is pre-run plan-only mode" in plan_skill

assert "## Full step context" in begin_skill
assert "## Persisted worktree lifecycle context" in begin_skill
assert "perform every repository read, verification command, and Git inspection inside this worktree" in begin_skill
assert "standalone reviewer is read-only" in begin_skill
assert "## Diff Output" in review_skill
assert "developer_instructions" in review_skill

assert "Every subagent spawn request needs all of these" in resume_skill
assert "Relevant memory" in resume_skill
assert "Prior context" in resume_skill
assert "Persisted worktree lifecycle" in resume_skill
assert "reuse this exact persisted context" in resume_skill

assert "STANDALONE-review prompt overrides the reviewer role's normal result-submission rule" in begin_skill
assert "do NOT call `team_submit_result`" in begin_skill
assert "final response must be only a valid JSON array" in begin_skill
assert "final response MUST be only a valid JSON array" in plan_skill
for skill_text in (begin_skill, deep_plan_skill, plan_skill, resume_skill, status_skill, research_skill, review_skill):
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
CODEX_HOME="$TEST_HOME" "$CODEX_BIN" debug prompt-input 'Develop an exhaustive recursive software plan without implementing it.' > "$TEST_HOME/deep-plan-prompt-input.json"
grep -F -- '- deep-plan:' "$TEST_HOME/deep-plan-prompt-input.json" >/dev/null

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
