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
2. Copies the role templates into `~/.codex/agents/`.
3. Copies the skills into `~/.codex/skills/`.

It points the MCP server at this checkout and builds into
`~/.codex/data/software-development-team` on first launch. Set `CODEX_HOME` to
install into a non-default Codex home.

## Usage

Start Codex and invoke the `begin` skill with your task:

```bash
codex
> $begin Implement a REST API for user management with CRUD endpoints
```

Skills can be invoked two ways in Codex:

- **Explicitly** — `$begin <task>`, or type `$` to open the skill menu.
- **Implicitly** — Codex selects a skill when your request matches its `description`
  (e.g. "review my changes" can trigger the `review` skill).

The coordinator will:

1. Assess scope and spawn the planner (or plan directly for small tasks).
2. Run the plan → plan-critic → final-plan loop, then present the plan for approval.
3. Execute steps: spawn coders, spawn reviewers, handle retries and escalations.
4. Show a dashboard link when the `team_dashboard_url` MCP tool is registered in
   the current Codex session.

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

The skills spawn six role-specific subagents. Role identities and TOML template filenames are `planner`, `plan-critic`, `coder`, `reviewer`, `researcher`, and `documentation`; native `spawn_agent.task_name` labels are `planner`, `plan_critic`, `coder`, `reviewer`, `researcher`, and `documentation` respectively. The TOML files in
`~/.codex/agents/` are role templates: before each spawn, the coordinator reads the
appropriate template and includes its instructions plus the full per-step context in
the native `spawn_agent` request. Subagents inherit no conversation context. When the
team MCP server and a role's required tools are registered in the current Codex
session, subagents can call the mapped `mcp__software-development-team__team_*`
tools directly; skills must run their MCP availability preflight and must not assume
that every MCP tool is present.

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
  argument to `team_advance` is just a label; a native `spawn_agent` request is what
  makes a coder actually run.
- Run state and memory persist to a `.team/` directory in your project (gitignored).

### Scheduling contract

The coordinator's `maxParallel` is a simultaneous-worker limit, excluding the coordinator. It counts every role worker; a four-slot host therefore permits three workers, and unknown capacity permits one. The server itself has no WIP cap.

On every fresh status snapshot, the scheduler gives eligible review/revision lifecycle work priority, then selects dependency-complete pending steps in plan order. Claimed files are compared as exact declared strings: blockers, conflicts, and overlap with active or same-batch claims serialize work even when worktrees are used. `start_coding` is authoritative, so rejection refreshes status and reschedules; a spawn failure is submitted as `blocked`; and freed capacity is refilled without pause or cancel semantics.

### Mandatory run-scoped worktrees

Every execution step has one mandatory worktree at `.worktrees/{runId}/step-{N}` on branch `team-{runId}-step-{N}`. Planner and plan-critic are pre-approval, read-only roles in the primary workspace. Coder and documentation are mutating roles that read, write, verify, and commit only in the supplied worktree. Reviewer and researcher use the supplied worktree only for read-only inspection and verification. Worktrees do not relax exact-claim serialization: two steps whose declared file strings overlap exactly must not run concurrently.

When a pending execution step is first admitted, the coordinator captures its current target branch and exact commit, creates the worktree from that commit, and persists `{targetBranch, targetCommit, path, branch}` before `start_coding`. That capture and creation happen once; reviewer, revision-coder, researcher, documentation, and interrupted-worker dispatches reuse the same persisted context. Missing or inconsistent context blocks or escalates the step rather than creating a replacement worktree.

The StateMachine manages workflow state only; it never creates, removes, switches, commits, merges, or otherwise manages Git. After explicit reviewer approval, the coordinator switches to the captured target branch and merges the step branch there with `--no-ff`. On a merge conflict it aborts, preserves the worktree and branch, records the exact conflict, and escalates—never auto-resolves. A successful merge removes the worktree and then deletes the branch. A confirmed abandoned, unmerged step is never merged; its worktree is removed first and its branch is force-deleted. Cleanup failures preserve artifacts and report their exact path, branch, and error.

### MCP server config

The installer writes this to `~/.codex/config.toml` (paths resolved to your
checkout). See [`config.snippet.toml`](config.snippet.toml) for the template.

```toml
[mcp_servers.software-development-team]
command = "sh"
args = ["<abs>/server/launch.sh", "<abs>/server", "<CODEX_HOME>/data/software-development-team"]
startup_timeout_sec = 120
```

### MCP registration and dashboard recovery

Codex registers MCP tools when it starts a session. After installing or changing
the config, inspect `~/.codex/config.toml`, run:

```bash
codex mcp get software-development-team
```

then start a fresh `codex` session. If the team tools are missing in an existing
session, do not infer registration from `.team/logs/server.log`: a server log
line showing a localhost dashboard URL only means the server is listening. It
cannot add MCP tools to an already-running Codex session. The dashboard URL is
authoritative only when the registered `team_dashboard_url` tool returns it.

## First-launch build

The MCP server compiles itself on first launch (~30–60s: `npm ci` + `tsup`) into
`~/.codex/data/software-development-team`. The `startup_timeout_sec = 120` setting
gives Codex room to wait. If the MCP client still times out, relaunch `codex` — the
build will have finished and subsequent starts are instant. `dist/` and
`node_modules/` are never committed.

## Verify the distribution

Run the smoke test from the repository checkout:

```bash
sh codex/test-install.sh
```

The smoke test requires Python 3.11+ (for `tomllib`) and a local, runnable Codex
CLI. It installs into a temporary Codex home, validates the generated TOML and
every installed skill and role template, then asks the local Codex CLI to load
the MCP configuration. It validates configuration only: it does not download
dependencies or start the MCP server.

## Layout

```text
codex/
├── install.sh             Wires everything into ~/.codex (idempotent)
├── config.snippet.toml    MCP server config block (template)
├── agents/                Role templates used in spawn prompts (TOML)
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

## Updating skills and role templates

Codex picks up skill and role-template changes on a new session. After editing files here,
re-run `sh codex/install.sh` to re-copy them, then start a fresh `codex` session (if
a change doesn't appear, restart Codex).
