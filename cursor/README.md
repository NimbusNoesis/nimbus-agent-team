# Coding Team for Cursor

A port of the `software-development-team` multi-agent coding team to
[Cursor](https://cursor.com). It reuses the **same host-agnostic MCP server** as
the Claude Code plugin and the Codex distribution
([`plugins/software-development-team/server`](../plugins/software-development-team/server))
— only the host glue differs: Cursor commands as entry points, Cursor subagents
as team roles, and `~/.cursor/mcp.json` for server registration.

## Install

From a checkout of this repo:

```bash
sh cursor/install.sh
```

The installer is idempotent and does three things:

1. Adds a `mcpServers["software-development-team"]` entry to `~/.cursor/mcp.json`
   (template: [`mcp.snippet.json`](mcp.snippet.json) — `<SERVER_DIR>` and
   `<DATA_DIR>` are substituted with absolute paths). An existing entry of that
   name is left untouched.
2. Copies the subagent definitions ([`agents/*.md`](agents)) into `~/.cursor/agents/`.
3. Copies the commands ([`commands/*.md`](commands)) into `~/.cursor/commands/`.

Restart Cursor (or reload the window) afterwards so it picks up the new MCP
server, subagents, and commands. The server builds itself on first launch
(~30-60s) into `~/.cursor/data/software-development-team`; nothing compiled is
committed.

Requirements: Node.js 18+ and npm on `PATH` (for the server's first-launch
self-build).

To validate the distribution without changing your normal configuration:

```bash
sh cursor/test-install.sh
```

Set `CURSOR_HOME` to install somewhere other than `~/.cursor` (used by the smoke
test to install into a throwaway directory).

## Usage

In Cursor's agent chat:

```
/begin Implement a REST API for user management with CRUD endpoints
/deep-plan Design a zero-downtime multi-tenant data migration
/status
/memory search-term
```

Cursor commands are plain Markdown without argument templating — write the task
description in the same message as the command; the coordinator reads it as
conversational context.

## Commands

| Command      | Purpose                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `/begin`     | Full coordinator: plan → adversarial critique → approval → execute with review loops |
| `/deep-plan` | Bounded recursive planning dossier; never starts execution              |
| `/plan`      | Lightweight plan preview (planner → plan-critic → final planner)        |
| `/resume`    | Reconnect to an interrupted run and re-enter the coordinator loop       |
| `/status`    | Show run progress, escalations, conflicts, and the dashboard URL        |
| `/memory`    | Browse or search the five shared memory namespaces                      |
| `/research`  | Standalone researcher dispatch outside any run                          |
| `/review`    | Standalone reviewer dispatch over uncommitted changes or named files    |

## Subagents

The team roles are Cursor subagents in `~/.cursor/agents/`: `planner`,
`plan-critic`, `recursive-planner`, `coder`, `reviewer`, `researcher`, and
`documentation`. The coordinator (the main session running a command) dispatches
them by name and passes the full per-step context in each dispatch prompt —
subagents inherit no conversation context.

Cursor subagents inherit all session tools, including the team's MCP tools —
there is no per-agent tool allowlist (unlike the Claude Code plugin's `tools:`
frontmatter), so each agent's instructions define its tool boundaries. That
applies to the read-only roles too (planner, plan-critic, recursive-planner,
reviewer, researcher): none of them sets Cursor's `readonly: true` frontmatter
flag, because every one still needs to write MCP memory or run verification
commands, and `readonly` is documented only as "restrict write permissions" —
too coarse to rely on without blocking those writes.

## How this maps to the other hosts

| Axis             | Claude Code plugin                                                | Codex CLI                                  | Cursor                                     |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Entry points     | `commands/*.md` (frontmatter + `$ARGUMENTS`)                      | `skills/<name>/SKILL.md`                   | `~/.cursor/commands/*.md` (plain Markdown) |
| Team roles       | `agents/*.md` (`tools` allowlist)                                 | `agents/*.toml` (spawn templates)          | `~/.cursor/agents/*.md` (subagents)        |
| Dispatch         | Agent tool + `subagent_type`                                      | native `spawn_agent` + unique task labels  | named subagent dispatch                    |
| MCP registration | plugin `.mcp.json`                                                | `~/.codex/config.toml` block               | `~/.cursor/mcp.json` entry                 |
| MCP tool prefix  | `mcp__plugin_software-development-team_software-development-team__team_X` | `mcp__software_development_team__team_X` | `mcp_software-development-team_team_X`     |

If your Cursor build surfaces the team tools without the `mcp_<server>_` prefix,
call them by the exact names shown for the `software-development-team` server in
the session's tool list — the commands' `team_X` short names always refer to
those tools.

All three hosts share `.team/` run state in the project directory. Run the hosts
sequentially on a given project; concurrent sessions race on `.team/` state.

## Troubleshooting

- **Team tools missing:** check `~/.cursor/mcp.json` for the
  `software-development-team` entry, open Cursor Settings → MCP to see the
  server's status, and reload Cursor. First launch compiles the server — give it
  ~30-60s.
- **Commands don't appear when you type `/`:** some Cursor builds fail to pick up
  the *global* command library — reported [in general](https://forum.cursor.com/t/commands-are-not-detected-in-the-global-cursor-directory/150967)
  and [specifically over SSH/remote](https://forum.cursor.com/t/ssh-global-commands-from-remote-cursor-commands-not-loaded-rules-work/150941),
  where rules load but commands don't. Both the agents and the MCP server are
  unaffected; only command discovery is. Work around it by installing the
  commands per-project instead:

  ```bash
  mkdir -p .cursor/commands && cp cursor/commands/*.md .cursor/commands/
  ```

  Project commands and global commands use the same plain-Markdown format, so
  the copies need no edits. Subagents stay in `~/.cursor/agents/` (or copy them
  to `.cursor/agents/` alongside, which takes project scope).
- **Dashboard URL:** only the registered `team_dashboard_url` tool returns a
  usable URL. A localhost URL in `.team/logs/server.log` merely shows the server
  is listening; it cannot register tools into an already-running session.
- **Uninstall:** remove the `mcpServers["software-development-team"]` entry from
  `~/.cursor/mcp.json` and delete the copied files from `~/.cursor/agents/` and
  `~/.cursor/commands/`.
