# NimbusNoesis Agent Coding Team (Kilo Code)

Runs the same multi-agent coding team as the Claude Code plugin, Codex and Cursor
distributions — this port targets **Kilo Code** (the OpenCode-based VS Code
extension / `kilo` CLI). A coordinator dispatches planner, plan-critic, coder,
reviewer, researcher and documentation subagents through a structured plan, with
shared memory, a message bus, quality-gated review loops and a live dashboard.

It reuses `plugins/software-development-team/server` unchanged (it self-builds on
first launch) and does not touch the other hosts.

## Install

From a checkout of this repo:

```sh
sh kilo/install.sh
```

This merges the MCP server into `~/.config/kilo/kilo.jsonc` (backing it up first),
and copies the agents into `~/.config/kilo/agent/` and the commands into
`~/.config/kilo/command/`. Reload the Kilo Code window afterward.

To validate the installer without touching your real config:

```sh
sh kilo/test-install.sh
```

## Use

In the Kilo Code chat (or `kilo` TUI):

```
/begin Implement a REST API for user management with CRUD endpoints
/deep-plan Design a zero-downtime multi-tenant data migration
/status
/resume
```

`/begin` runs the coordinator in the primary session; it dispatches the role
subagents and calls the team's MCP tools.

## Model & key

Kilo reaches models through its providers; this team is model-agnostic. On a
Venice setup the provider block and `VENICE_API_KEY` live in `kilo.jsonc` /
the environment — see your host notes. Pick a model that supports tool calling.

## Tool names

Kilo exposes the MCP tools as `software-development-team_<tool>` (e.g.
`software-development-team_team_start`). The agent and command prompts use these
names; if a build lists them differently, call them as shown in the session's
tool list for the `software-development-team` server.

## Layout

```
kilo/
├── install.sh            Wire MCP + copy agents/commands into ~/.config/kilo
├── test-install.sh       Installer smoke test (throwaway KILO_CONFIG_HOME)
├── mcp.snippet.jsonc     The MCP block, for manual setup
├── agents/*.md           Subagent definitions (mode: subagent)
└── commands/*.md         Commands (begin, deep-plan, plan, research, review, status, resume, memory)
```
