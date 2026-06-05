# Coding Team for OpenAI Codex CLI

This directory runs the same multi-agent **Coding Team** inside the [OpenAI Codex
CLI](https://developers.openai.com/codex/cli). It is **additive** — it reuses the
host-agnostic MCP server in [`../plugins/software-development-team/server`](../plugins/software-development-team/server)
and does not modify or disable the Claude Code plugin. Both hosts can be installed
side by side.

A coordinator (the `/begin` prompt) spawns planner, plan-critic, coder, reviewer,
researcher, and documentation subagents that work through a structured plan with
shared memory, a message bus, and a real-time dashboard — all backed by the MCP
server.

## How the Codex port maps to Claude Code

| Claude Code plugin | Codex equivalent (this dir) |
| ------------------ | --------------------------- |
| `.mcp.json` (`mcpServers`) | `[mcp_servers.software-development-team]` in `~/.codex/config.toml` (see [`config.snippet.toml`](config.snippet.toml)) |
| `agents/*.md` (YAML frontmatter) | `agents/*.toml` (`name` / `description` / `developer_instructions`) → installed to `~/.codex/agents/` |
| `commands/begin.md` + `skills/*.md` | `prompts/*.md` (slash commands) → installed to `~/.codex/prompts/` |
| Agent-tool dispatch | Codex subagent spawning (coordinator requests a spawn with full per-step context) |
| MCP tool prefix `mcp__plugin_…__team_X` | `mcp__software-development-team__team_X` |
| `SessionStart` pre-warm hook | not needed — `launch.sh` builds the server on launch |

The MCP server, dashboard, SQLite state, and `.team/` persistence are identical to
the Claude Code plugin — only the host glue differs.

## Prerequisites

- [OpenAI Codex CLI](https://developers.openai.com/codex/cli) installed
- Node.js 18+ with `npm` on `PATH` (the MCP server is Node)

## Install

From the repo checkout:

```bash
sh codex/install.sh
```

The installer is idempotent and:

1. Wires `[mcp_servers.software-development-team]` into `~/.codex/config.toml`
   (skips with a warning if a block of that name already exists).
2. Copies the agent definitions into `~/.codex/agents/`.
3. Copies the slash-command prompts into `~/.codex/prompts/`.

It points the MCP server at this checkout and builds into
`~/.codex/data/software-development-team` on first launch.

> Set `CODEX_HOME` to install into a non-default Codex home directory.

## Usage

```bash
codex
> /begin Implement a REST API for user management with CRUD endpoints
```

The coordinator will:

1. Assess scope and spawn the planner (or plan directly for small tasks).
2. Run the plan → plan-critic → final-plan loop, then present the plan for approval.
3. Execute steps: spawn coders, spawn reviewers, handle retries and escalations.
4. Show real-time progress on the dashboard (URL printed at the start of the run).

### Slash commands

| Command | Description |
| ------- | ----------- |
| `/begin <task>` | Start the full coding team on a task |
| `/status [run-id]` | Check current run status and step progress |
| `/memory [query]` | Browse and search team memory across namespaces |
| `/resume <run-id>` | Resume an interrupted run |
| `/plan <task>` | Plan a task without starting execution |
| `/research <query>` | Research a topic, API, or codebase pattern |
| `/review [files]` | Review uncommitted changes or specific files |

If the slash menu shows prompts under a `prompts:` group, the commands are
`/prompts:begin`, etc.

## First-launch build

The MCP server compiles itself on first launch (~30–60s: `npm ci` + `tsup`) into
`~/.codex/data/software-development-team`. The installer sets
`startup_timeout_sec = 120` so Codex waits long enough. If the MCP client still
times out, just relaunch `codex` — the build will have finished and subsequent
starts are instant. `dist/` and `node_modules/` are never committed.

## Uninstall

1. Remove the `[mcp_servers.software-development-team]` block from `~/.codex/config.toml`.
2. Delete the copied files:
   ```bash
   rm -f ~/.codex/agents/{coder,planner,plan-critic,reviewer,researcher,documentation}.toml
   rm -f ~/.codex/prompts/{begin,status,memory,resume,plan,research,review}.md
   ```
3. Optionally delete the build dir: `rm -rf ~/.codex/data/software-development-team`.

## Notes

- **Subagent spawning**: Codex does not auto-spawn agents. The coordinator requests
  a spawn explicitly and must include the full per-step context (the Spawn Context
  Checklist in `prompts/begin.md`) — subagents inherit no conversation context.
- **MCP inheritance**: subagents inherit the team's MCP server from the parent
  session, so they can call `mcp__software-development-team__team_*` directly. The
  agent TOMLs intentionally omit a per-agent `mcp_servers` block.
- **Custom prompts vs skills**: Codex marks custom prompts as legacy in favor of
  skills. This port uses prompts for the closest 1:1 mapping to the plugin's
  commands/skills; they can be re-authored as Codex skills later without changing
  the agents or server.
