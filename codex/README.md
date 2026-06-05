# Coding Team for OpenAI Codex CLI

A multi-agent **coding team** for the [OpenAI Codex CLI](https://developers.openai.com/codex/cli).
A coordinator (the `begin` skill) spawns planner, plan-critic, coder, reviewer,
researcher, and documentation subagents that work through a structured plan with
shared memory, a message bus, quality-gated review loops, and a real-time web
dashboard — all backed by an MCP server.

## Prerequisites

- [OpenAI Codex CLI](https://developers.openai.com/codex/cli) installed
- Node.js 18+ with `npm` on `PATH` (the MCP server is a Node process)

## Install

From a checkout of this repo:

```bash
sh codex/install.sh
```

The installer is idempotent and wires the team into your Codex home (`$CODEX_HOME`,
default `~/.codex`):

1. Adds an `[mcp_servers.software-development-team]` block to `~/.codex/config.toml`
   (skips with a warning if a block of that name already exists).
2. Copies the agent definitions into `~/.codex/agents/`.
3. Copies the skills into `~/.codex/skills/`.

It points the MCP server at this checkout and builds into
`~/.codex/data/software-development-team` on first launch. Set `CODEX_HOME` to
install into a non-default Codex home.

## Usage

Start Codex and invoke the `begin` skill with your task:

```bash
codex
> /begin Implement a REST API for user management with CRUD endpoints
```

Skills can be invoked three ways in Codex:

- **Explicitly** — `/begin <task>`, or type `$` to open the skill menu, or run `/skills`.
- **Implicitly** — Codex selects a skill when your request matches its `description`
  (e.g. "review my changes" can trigger the `review` skill).

The coordinator will:

1. Assess scope and spawn the planner (or plan directly for small tasks).
2. Run the plan → plan-critic → final-plan loop, then present the plan for approval.
3. Execute steps: spawn coders, spawn reviewers, handle retries and escalations.
4. Show real-time progress on the dashboard (URL printed at the start of the run).

### Skills

| Skill | What it does |
| ----- | ------------ |
| `begin` | Start the full coding team on a task |
| `status` | Check current run status and step progress |
| `memory` | Browse and search team memory across namespaces |
| `resume` | Resume an interrupted run (needs a run ID) |
| `plan` | Produce a plan without starting execution |
| `research` | Research a topic, API, or codebase pattern |
| `review` | Review uncommitted changes or specific files |

### Agents

The skills spawn six subagents, defined in `~/.codex/agents/*.toml`:
`planner`, `plan-critic`, `coder`, `reviewer`, `researcher`, `documentation`. Codex
does not auto-spawn them — the coordinator requests each spawn explicitly and passes
the full per-step context (subagents inherit no conversation context). The agents
inherit the team's MCP server from the session, so they call
`mcp__software-development-team__team_*` tools directly.

## How it works

```text
                     User
                      |
                  begin skill
                      |
                 Coordinator
        /      |       |        |        \
   Planner  Coder  Reviewer  Researcher  Documentation
   (+ Plan-Critic adversarial review of the plan)
        \      |       |        |        /
              MCP Server (SQLite + bus + memory)
                      |
                  Dashboard (WebSocket)
```

- **MCP tools** (`mcp__software-development-team__team_*`) track run STATE — which step
  is coding/reviewing/complete, the message bus, and shared memory across five
  namespaces (`decisions`, `context`, `learnings`, `reviews`, `reflections`). They do
  not perform work.
- **Subagent spawning** performs the work. The two systems are separate: the `agent`
  argument to `team_advance` is just a label; spawning the `coder` subagent is what
  makes a coder actually run.
- Run state and memory persist to a `.team/` directory in your project (gitignored).

### MCP server config

The installer writes this to `~/.codex/config.toml` (paths resolved to your
checkout). See [`config.snippet.toml`](config.snippet.toml) for the template.

```toml
[mcp_servers.software-development-team]
command = "sh"
args = ["<abs>/server/launch.sh", "<abs>/server", "<CODEX_HOME>/data/software-development-team"]
startup_timeout_sec = 120
```

## First-launch build

The MCP server compiles itself on first launch (~30–60s: `npm ci` + `tsup`) into
`~/.codex/data/software-development-team`. The `startup_timeout_sec = 120` setting
gives Codex room to wait. If the MCP client still times out, relaunch `codex` — the
build will have finished and subsequent starts are instant. `dist/` and
`node_modules/` are never committed.

## Layout

```text
codex/
├── install.sh             Wires everything into ~/.codex (idempotent)
├── config.snippet.toml    MCP server config block (template)
├── agents/                Subagent definitions (TOML)
│   ├── planner.toml
│   ├── plan-critic.toml
│   ├── coder.toml
│   ├── reviewer.toml
│   ├── researcher.toml
│   └── documentation.toml
└── skills/                Skills (one folder per skill, each with SKILL.md)
    ├── begin/
    ├── status/
    ├── memory/
    ├── resume/
    ├── plan/
    ├── research/
    └── review/
```

The MCP server lives in `../plugins/software-development-team/server` and is shared,
not duplicated here.

## Uninstall

1. Remove the `[mcp_servers.software-development-team]` block from `~/.codex/config.toml`.
2. Delete the copied files:

   ```bash
   rm -f  ~/.codex/agents/{coder,planner,plan-critic,reviewer,researcher,documentation}.toml
   rm -rf ~/.codex/skills/{begin,status,memory,resume,plan,research,review}
   ```

3. Optionally delete the build dir: `rm -rf ~/.codex/data/software-development-team`.

## Updating skills and agents

Codex picks up skill/agent changes on a new session. After editing files here,
re-run `sh codex/install.sh` to re-copy them, then start a fresh `codex` session (if
a change doesn't appear, restart Codex).
