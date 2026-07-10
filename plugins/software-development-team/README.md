# Claude Coding Team

A [Claude Code](https://claude.ai/claude-code) plugin that orchestrates a multi-agent coding team. A coordinator dispatches planner, coder, reviewer, researcher, and documentation agents that work autonomously through a structured plan with shared memory, a real-time dashboard, and built-in quality gates.

> **Running in OpenAI Codex CLI?** The same team runs on Codex too — see [`../../codex/README.md`](../../codex/README.md). The Codex port reuses this plugin's `server/` unchanged; the two hosts coexist.

## Features

- **Multi-agent orchestration** -- coordinator manages a pipeline of planner, coder, reviewer, researcher, and documentation agents
- **Structured planning** -- tasks are broken into ordered steps with dependencies, file ownership, and acceptance criteria
- **Code review loop** -- every step is reviewed before approval; reviewers can request revisions (up to 3 retries)
- **In-memory SQLite database** -- all stateful storage (runs, messages, memory) backed by sql.js in-memory SQLite
- **Shared memory** -- agents share decisions, context, learnings, and reflections via a persistent key-value store
- **Message bus** -- typed messages (info, review, escalation, guidance, result) between agents and the user
- **Real-time dashboard** -- web UI showing live progress, step details, agent activity, and shared memory
- **Pipeline parallelism** -- a deterministic scheduler runs independent work concurrently within the host worker capacity; lifecycle work is prioritized and conflicting file claims are serialized
- **Stuck detection** -- automatic escalation when agents repeat the same error or exhaust retries
- **File conflict detection** -- prevents two steps from editing the same file concurrently
- **Git worktree isolation** -- mandatory run-scoped worktrees for isolated execution and reviewer-gated merge-back

## Dashboard

The dashboard provides real-time awareness of what the team is doing:

- **Run tab bar** for switching between every run — a scrollable row of tabs across the top, each showing the run number, task, live status, and step progress (the active run's tab auto-scrolls into view)
- **Step list** with expandable detail panels showing acceptance criteria, files, dependencies, blocking reasons, results, and timing
- **Progress bar** showing completed steps out of total
- **Agent status cards** for all 6 agents (coordinator, planner, coder, reviewer, researcher, documentation) with live elapsed timers
- **Shared memory panel** displaying team decisions and learnings grouped by namespace
- **Activity feed** with message type filtering (info, review, escalation, guidance, result) and count badges
- **Guidance input** for sending instructions to the team mid-run

## Quick Start

### Prerequisites

- [Claude Code](https://claude.ai/claude-code) CLI installed
- Node.js 18+ with `npm` on `PATH`

### Installation

Installed through the marketplace, the plugin is **self-building** — there is no manual install/build step. On first launch the MCP server's `launch.sh` wrapper runs `npm ci` + `tsup`, compiling into the plugin's persistent data directory (`${CLAUDE_PLUGIN_DATA}`; the plugin install directory is read-only and is reset on update). A `SessionStart` hook pre-warms the build so it is normally ready before the server starts, and a build is only re-run when the server sources change.

> The first launch after install/update may take ~30–60s (dependency download + compile). If you hit an MCP startup timeout, relaunch with `MCP_TIMEOUT=120000 claude` and reconnect — the build will have finished and subsequent starts are instant.

For local development against a checkout, build manually:

```bash
git clone <repo-url>
cd software-development-team/server
npm install
npx tsup          # build MCP server + dashboard
```

### Usage

From any project directory with Claude Code:

```bash
# Start the coding team with a task
claude
> /begin Implement a REST API for user management with CRUD endpoints

# The coordinator will:
# 1. Assess scope and dispatch the planner (or plan directly for small tasks)
# 2. Present the plan for your approval
# 3. Execute steps: dispatch coders, review results, handle retries
# 4. Show real-time progress on the dashboard
```

The dashboard URL is printed at the start of each run (e.g., `http://localhost:<port>`).

### Skills

In addition to the main `/begin` command, the plugin provides focused skills:

| Skill | Description |
| ----- | ----------- |
| `/status` | Check current run status and step progress |
| `/memory` | Browse and search team memory across all namespaces |
| `/resume <run-id>` | Resume an interrupted run |
| `/plan <task>` | Plan a task without starting execution |
| `/research <query>` | Research a topic, API, or codebase pattern |
| `/review [files]` | Review uncommitted changes or specific files |

## Architecture

```
                     User
                      |
                  /begin command
                      |
                 Coordinator
              /    |    |    |    \
        Planner  Coder Reviewer Researcher Documentation
                \     |     /
              MCP Server (SQLite DB + bus + memory)
                      |
                  Dashboard (WebSocket)
```

### Components

| Component | Description |
|-----------|-------------|
| **Coordinator** | Runs in the main session. Assesses scope, manages the plan, dispatches agents, handles escalations |
| **Planner** | Explores the codebase and produces structured implementation plans with ordered steps |
| **Coder** | Implements plan steps by writing code, running tests, and submitting results |
| **Reviewer** | Reviews code against acceptance criteria, approves or requests revisions |
| **Researcher** | Searches online for relevant information, assists other agents with research queries |
| **Documentation** | Creates and maintains documentation files (README, CHANGELOG, CLAUDE.md, API docs, etc.) |
| **MCP Server** | Manages run state, message bus, shared memory, and persistence. All stateful storage backed by in-memory SQLite (sql.js) |
| **Dashboard** | Real-time web UI for monitoring progress |

### MCP Tools

| Tool | Description |
|------|-------------|
| `team_start` | Initialize a run with plan steps |
| `team_status` | Get current run state with timing, blocking reasons, and conflicts |
| `team_advance` | Advance a step: start coding, approve, request revision, or resolve escalation |
| `team_submit_result` | Submit coder/reviewer results for a step |
| `team_send_message` | Post a message to the team bus |
| `team_get_messages` | Read messages, with filtering by type and timestamp |
| `team_memory_write` | Store a key-value entry in shared memory |
| `team_memory_read` | Read memory entries by key, namespace, or search |
| `team_memory_delete` | Delete a memory entry by namespace and key |
| `team_dashboard_url` | Get the dashboard URL |

### State Machine

Steps follow this lifecycle:

```
pending --> coding --> reviewing --> complete
              ^           |
              |           v
              +--- needs_revision (up to 3 retries)
              
              coding/reviewing --> escalated (on stuck detection or retry exhaustion)
```

### Git Worktree Isolation

Every execution step receives one mandatory run-scoped worktree, `.worktrees/{runId}/step-{N}`, on branch `team-{runId}-step-{N}`. The coordinator creates it only when the pending step is first admitted: it captures the current target branch and exact commit, creates from that commit, and persists `{targetBranch, targetCommit, path, branch}` before `start_coding`. Re-dispatches reuse that context; missing or inconsistent context blocks or escalates the step rather than recapturing or creating another worktree.

| Role | Repository location and authority |
| --- | --- |
| Planner / plan-critic | Pre-approval and read-only in the primary workspace; no execution worktree. |
| Coder / documentation | Read, write, verify, and commit only in the supplied worktree. |
| Reviewer / researcher | Read-only inspection and verification only in the supplied worktree. |

Exact declared file strings remain the scheduling contract: overlapping claims serialize even in separate worktrees. The StateMachine manages workflow state, not Git; it never creates, removes, switches, commits, or merges worktrees or branches.

Only an explicit reviewer approval permits the coordinator to switch to the captured target branch and merge the step branch there with `--no-ff`. A merge conflict is aborted, recorded with its exact conflicting files, and escalated while the worktree and branch are preserved; the coordinator never auto-resolves conflicts. After a successful merge, remove the worktree and then delete the branch. A confirmed abandoned, unmerged step is never merged: remove its worktree first, then force-delete its branch. On either cleanup failure, preserve artifacts and report the exact path, branch, and error.

### Coordinator scheduling

The coordinator treats `maxParallel` as a worker budget, not a count that includes the coordinator. It counts every spawned role worker (planner, plan-critic, coder, reviewer, researcher, and documentation); host capacity of four therefore allows three workers, while absent or unknown capacity permits one. There is no server-side WIP cap.

Each fresh scheduling pass prioritizes eligible review and revision lifecycle work, then selects dependency-complete pending steps in plan order. A step must have no reported blocker or conflict and its exact planned file strings must be disjoint from active and same-batch claims. `start_coding` is authoritative: a rejection refreshes status and restarts selection. Spawn failures are submitted as `blocked`, and every worker completion refills capacity. Normal scheduling never pauses or cancels steps.

### Data Model

- **RunState** -- id, status, steps[], timestamps
- **StepState** -- status, retryCount, assignedAgent, result, claimedFiles, timing (startedAt/completedAt), stuck detection counters
- **Message** -- from, to, type, body, timestamp
- **MemoryEntry** -- key, namespace, value, optional runId, timestamp

## Development

```bash
cd server

# Type check
npx tsc --noEmit

# Build
npx tsup

# Run tests
npx vitest run

# Watch mode
npx vitest

# Find unused files, exports, and dependencies
npm run knip
```

## Project Structure

```
software-development-team/
  agents/                    Agent definitions
    planner.md               Planner agent
    plan-critic.md           Plan critic agent (read-only critique)
    coder.md                 Coder agent
    reviewer.md              Reviewer agent
    researcher.md            Researcher agent
    documentation.md         Documentation agent
  commands/
    begin.md                 /begin command entry point (defines the coordinator)
  hooks/
    hooks.json               SessionStart hook that pre-warms the server build
  skills/
    status.md                Check run status and progress
    memory.md                Browse and search team memory
    resume.md                Resume an interrupted run
    plan.md                  Plan-only mode (no execution)
    research.md              Standalone research queries
    review.md                Standalone code review
  server/
    launch.sh                MCP entry point — builds if needed, then runs the server
    scripts/
      ensure-build.sh        Idempotent install+build into ${CLAUDE_PLUGIN_DATA}
    src/
      index.ts               MCP server setup, tool registration, Database wiring
      types.ts               TypeScript type definitions
      logger.ts              Logging utility
      db/
        database.ts          In-memory SQLite database (sql.js)
      state/
        machine.ts           State machine (step lifecycle, conflicts)
        persistence.ts       File-based persistence (disk I/O)
      bus/
        message-bus.ts       Message bus with EventEmitter
      memory/
        store.ts             Shared memory store with EventEmitter
      tools/
        registry.ts          Tool dispatcher
        workflow.ts          team_start, team_status, team_advance
        results.ts           team_submit_result
        messages.ts          team_send_message, team_get_messages
        memory.ts            team_memory_write, team_memory_read, team_memory_delete
      dashboard/
        server.ts            Express + WebSocket server
        client/              Preact + Signals client source (bundled by esbuild)
        public/
          index.html         Dashboard layout
          style.css          Dashboard styles
    dist/                    Built output (ESM); dashboard/public/app.js is the bundled client
```

## License

MIT
