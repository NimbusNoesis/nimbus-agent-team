#!/bin/sh
# Smoke-test the Cursor distribution without modifying the caller's CURSOR_HOME.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_HOME=$(mktemp -d "${TMPDIR:-/tmp}/software-development-team-cursor.XXXXXX")

err() {
  printf '[test-install] ERROR: %s\n' "$1" >&2
}

cleanup() {
  rm -rf "$TEST_HOME"
}
trap cleanup EXIT HUP INT TERM

if ! command -v node >/dev/null 2>&1; then
  err "Node.js 18+ is required to run the installer and parse generated JSON, but node was not found on PATH."
  exit 1
fi

CURSOR_HOME="$TEST_HOME" sh "$SCRIPT_DIR/install.sh"
# Re-run to prove idempotency: the existing entry must be left untouched.
CURSOR_HOME="$TEST_HOME" sh "$SCRIPT_DIR/install.sh" >/dev/null

node - "$TEST_HOME/mcp.json" "$TEST_HOME" <<'JS'
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const [, configPath, cursorHome] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

assert.deepStrictEqual(Object.keys(config), ['mcpServers']);
assert.deepStrictEqual(Object.keys(config.mcpServers), ['software-development-team']);
const server = config.mcpServers['software-development-team'];

assert.strictEqual(server.type, 'stdio');
assert.strictEqual(server.command, 'sh');
assert.strictEqual(server.args.length, 3);
assert.ok(fs.statSync(server.args[0]).isFile(), 'args[0] must be launch.sh');
assert.ok(fs.statSync(server.args[1]).isDirectory(), 'args[1] must be the server dir');
assert.strictEqual(server.args[2], path.join(cursorHome, 'data', 'software-development-team'));

const expectedRoles = [
  'coder.md', 'documentation.md', 'plan-critic.md', 'planner.md',
  'recursive-planner.md', 'researcher.md', 'reviewer.md',
];
const agentsDir = path.join(cursorHome, 'agents');
const installedAgents = fs.readdirSync(agentsDir).filter((name) => name.endsWith('.md')).sort();
assert.deepStrictEqual(installedAgents, expectedRoles);
const agentTexts = {};
for (const file of installedAgents) {
  const text = fs.readFileSync(path.join(agentsDir, file), 'utf8');
  agentTexts[file] = text;
  const stem = file.replace(/\.md$/, '');
  assert.ok(text.startsWith(`---\nname: ${stem}\n`), `${file} frontmatter must declare name: ${stem}`);
  assert.ok(/\ndescription: \|\n/.test(text), `${file} frontmatter must declare a description`);
}

const expectedCommands = [
  'begin.md', 'deep-plan.md', 'memory.md', 'plan.md',
  'research.md', 'resume.md', 'review.md', 'status.md',
];
const commandsDir = path.join(cursorHome, 'commands');
const installedCommands = fs.readdirSync(commandsDir).filter((name) => name.endsWith('.md')).sort();
assert.deepStrictEqual(installedCommands, expectedCommands);
const commandTexts = {};
for (const file of installedCommands) {
  const text = fs.readFileSync(path.join(commandsDir, file), 'utf8');
  commandTexts[file] = text;
  // Cursor commands are plain Markdown — no frontmatter, no $ARGUMENTS templating.
  assert.ok(!text.startsWith('---'), `${file} must not carry frontmatter`);
  assert.ok(!text.includes('$ARGUMENTS'), `${file} must not use $ARGUMENTS templating`);
}

// Cursor surfaces MCP tools with a single-underscore mcp_<server>_ prefix;
// the double-underscore Claude/Codex namespaces do not exist on Cursor.
const expectedNamespace = 'mcp_software-development-team_';
const forbiddenNamespaces = [
  'mcp__software_development_team__',
  'mcp__software-development-team__',
  'mcp__plugin_software-development-team_software-development-team__',
];
for (const [file, text] of Object.entries({ ...commandTexts, ...agentTexts })) {
  if (file !== 'review.md') {
    assert.ok(text.includes(expectedNamespace), `${file} must use the Cursor MCP namespace`);
  }
  for (const forbidden of forbiddenNamespaces) {
    assert.ok(!text.includes(forbidden), `${file} must not use ${forbidden}`);
  }
  assert.ok(!text.includes('subagent_type'), `${file} must not use the Claude Agent-tool dispatch`);
  assert.ok(!text.includes('spawn_agent'), `${file} must not use the Codex native spawn dispatch`);
}

// No Cursor agent may declare the `readonly` frontmatter flag: it is documented
// only as "restrict write permissions" and may cover MCP tools, which would
// block recursive-planner's mandatory team_memory_write reflection. Read-only
// boundaries are instruction-enforced on this host.
for (const [file, text] of Object.entries(agentTexts)) {
  assert.ok(!/^readonly:/m.test(text), `${file} must not declare Cursor's readonly flag`);
}
assert.ok(agentTexts['recursive-planner.md'].includes('team_memory_write'));
assert.ok(agentTexts['recursive-planner.md'].includes('pre-run, pre-approval, read-only specialist'));
assert.ok(agentTexts['recursive-planner.md'].includes('never recurse or dispatch another agent yourself'));

const begin = commandTexts['begin.md'];
const resume = commandTexts['resume.md'];
const status = commandTexts['status.md'];
for (const text of [begin, resume, status]) {
  assert.ok(text.includes('All team MCP tools are absent'));
  assert.ok(text.includes('Only `team_dashboard_url` is unavailable'));
  assert.ok(text.includes('~/.cursor/mcp.json'));
  assert.ok(text.includes('already-running session'));
}
for (const role of ['planner', 'plan-critic', 'coder', 'reviewer', 'researcher', 'documentation']) {
  assert.ok(begin.includes(`~/.cursor/agents/${role}.md`), `begin must list the ${role} subagent`);
}
assert.ok(begin.includes('Do NOT call `team_submit_result`'));
assert.ok(commandTexts['deep-plan.md'].includes('team_start({ steps: appendix })'));
assert.ok(commandTexts['deep-plan.md'].includes('MUST NOT call `team_start`'));

console.log('Generated Cursor configuration is valid.');
JS

# install.sh derives its server path from its own checkout. Copy that complete
# sibling topology into paths containing characters that must be JSON-escaped.
HOSTILE_COMPONENT='json-"quote"-\back\slash- space-end'
FIXTURE_ROOT="$TEST_HOME/fixture-$HOSTILE_COMPONENT"
HOSTILE_CURSOR_HOME="$FIXTURE_ROOT/cursor-home-$HOSTILE_COMPONENT"
mkdir -p "$FIXTURE_ROOT/plugins"
cp -R "$SCRIPT_DIR" "$FIXTURE_ROOT/cursor"
cp -R "$SCRIPT_DIR/../plugins/software-development-team" "$FIXTURE_ROOT/plugins/software-development-team"

CURSOR_HOME="$HOSTILE_CURSOR_HOME" sh "$FIXTURE_ROOT/cursor/install.sh" >/dev/null

node - "$HOSTILE_CURSOR_HOME/mcp.json" "$FIXTURE_ROOT" "$HOSTILE_CURSOR_HOME" <<'JS'
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const [, configPath, fixtureRoot, cursorHome] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

assert.deepStrictEqual(Object.keys(config), ['mcpServers']);
assert.deepStrictEqual(Object.keys(config.mcpServers), ['software-development-team']);
const server = config.mcpServers['software-development-team'];
const serverDir = path.join(fixtureRoot, 'plugins', 'software-development-team', 'server');

assert.strictEqual(server.command, 'sh');
assert.deepStrictEqual(server.args, [
  path.join(serverDir, 'launch.sh'),
  serverDir,
  path.join(cursorHome, 'data', 'software-development-team'),
]);
console.log('Hostile-path fixture produced valid JSON.');
JS

printf '%s\n' "Cursor distribution smoke test passed."
