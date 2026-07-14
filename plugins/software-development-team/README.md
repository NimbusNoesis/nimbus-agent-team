# Claude Coding Team

A [Claude Code](https://claude.ai/claude-code) plugin that orchestrates a multi-agent coding team. A coordinator dispatches planner, plan-critic, coder, reviewer, researcher, and documentation agents that work autonomously through a structured plan with shared memory, a real-time dashboard, and built-in quality gates. A separate pre-run `recursive-planner` supports exhaustive deep planning without entering the execution lifecycle.

> **Running in OpenAI Codex CLI?** The same team runs on Codex too — see [`../../codex/README.md`](../../codex/README.md). The Codex port reuses this plugin's `server/` unchanged; the two hosts coexist. Use them **sequentially** on a given project: each session runs its own server instance against the same `.team/` state, and concurrent instances race on it (the server logs a warning via `.team/server.lock` when it detects another live instance). Launch sessions from the project root — team state lands in `.team/` relative to the working directory.

## Features

- **Multi-agent orchestration** -- coordinator manages a pipeline of planner, coder, reviewer, researcher, and documentation agents
- **Structured planning** -- tasks are broken into ordered steps with dependencies, file ownership, and acceptance criteria
- **Bounded deep planning** -- `/deep-plan` uses resumable recursive refinement, focused questions/research, adversarial critique, and final synthesis without starting execution
- **Code review loop** -- every step is reviewed before approval; reviewers can request revisions (up to 3 retries)
- **In-memory SQLite database** -- all stateful storage (runs, messages, memory) backed by sql.js in-memory SQLite
- **Shared memory** -- agents share decisions, context, learnings, and reflections via a persistent key-value store
- **Message bus** -- typed messages (info, review, escalation, guidance, result) between agents and the user
- **Operator dashboard** -- responsive, accessible live UI for plan truth, execution controls, activity audit, agents, memory, and guidance
- **Pipeline parallelism** -- a deterministic scheduler runs independent work concurrently within the host worker capacity; lifecycle work is prioritized and conflicting file claims are serialized
- **Stuck detection** -- automatic escalation when agents repeat the same error or exhaust retries
- **File conflict detection** -- prevents two steps from editing the same file concurrently
- **Git worktree isolation** -- mandatory run-scoped worktrees for isolated execution and reviewer-gated merge-back
- **Explicit execution modes** -- every step is canonically `code` or `read_only`, with strict completion rules for each mode
- **Fail-closed durability** -- MCP and dashboard mutations share one serialized admission lane and are acknowledged only after their persistence barrier succeeds

## Dashboard

The dashboard is a local operator console for observing and controlling a team run. The server prints its loopback URL when a run starts (for example, `http://localhost:<port>`). It presents aggregate run status separately from the lifecycle control phase so a run can truthfully remain `in_progress` while a pause or cancellation is draining.

- **Run tab bar** for switching between every run — a scrollable row of tabs across the top, each showing the run number, task, live status, and step progress (the active run's tab auto-scrolls into view)
- **Step list** with expandable details for criteria, file claims, worktree identity, dependencies, blockers, attempts, results, and timing
- **Execution controls** for pause, resume, run or step cancellation, and eligible escalated-step retry, with target-specific confirmations for destructive actions
- **Progress and health** showing completed work, cancellation, active workers, blockers, escalations, lifecycle revision, connection state, and data freshness
- **Agent status cards** for all 6 agents (coordinator, planner, coder, reviewer, researcher, documentation) with live elapsed timers
- **Shared memory panel** displaying team decisions and learnings grouped by namespace
- **Activity audit** merging messages and control history with filters, stable ordering, deduplication, reconnect state, unseen counts, and a return-to-live action
- **Guidance input** for sending single-flight, run-targeted instructions without losing a draft on failure or run switches

The UI uses one semantic DOM and adapts from three workspaces on wide screens to an anchor-navigable vertical workspace on tablets and phones. It has a skip link, visible keyboard focus, modal focus isolation/restoration, text status cues in addition to color, 44px minimum controls, safe wrapping for long paths and messages, reduced-motion support, and forced-colors fallbacks. It uses only local system fonts and assets.

### Lifecycle v2 and control contracts

Release 1.8.0 is the semver-minor lifecycle-v2/dashboard release; its marketplace, plugin, server package, and lockfile versions are synchronized. Control support is advertised by `lifecycleVersion: 2` and the run's `capabilities` map rather than inferred from the package version. Clients must hide unsupported actions and treat an absent lifecycle or capability map as read-only, which permits a new read-only dashboard to observe an older server safely. `RunStatus` remains the aggregate plan outcome; `controlPhase` independently reports `none`, `pausing`, `paused`, `cancelling`, or `cancelled`.

- **Pause:** `pause_run` immediately freezes new admissions and spawns. If workers are active, the phase is `pausing` while they drain naturally; they are not force-killed and their file claims remain held. The coordinator polls for quiescence and sends `acknowledge_pause`, producing `paused`. `resume_run` then clears the freeze and recomputes eligible work.
- **Cancel a run:** inactive targets cancel immediately. Active targets enter `cancelling`; workers drain naturally, claims remain held, and late results are rejected. Only the coordinator sends `acknowledge_cancel` after quiescence, at which point the run becomes terminal `cancelled` and claims are released.
- **Cancel a step:** the same drain-and-ack rules apply to an active step. Its dependents stay pending with explicit cancelled-dependency blockers, while dependency-independent steps may continue. Cancelling an inactive step is immediate. Completed and cancelled targets are immutable.
- **Retry:** `retry_step` is available only for an escalated step in an eligible run. Dependencies, exact file claims, and the persisted worktree are rechecked. The server preserves prior results and lifecycle history, increments the manual-attempt counter, resets per-attempt review counters, reclaims files, and returns the step to coding. The ordinary coder/reviewer revision loop remains bounded to three attempts; exhausted work escalates for an explicit operator decision. `resolve_escalation` is a deprecated compatibility alias.

Every mutation carries a unique `commandId` and the caller's `expectedRevision`. A successful command increments the monotonic lifecycle revision once and appends one bounded receipt/history entry. Repeating the same command ID and fingerprint returns the stored result without another write; reusing it for a different command is rejected. A stale expected revision returns `409 revision_conflict`. The dashboard never automatically replays destructive requests: it refreshes the run and requires the operator to reconsider and confirm again. Control history is restored with the run and appears in the activity audit after reconnect or restart.

### Local security model

The dashboard is intentionally local and is not an authenticated multi-user service. Bind it only to loopback. Browser mutation requests must have a loopback `Host` and an exact same-origin HTTP `Origin`. Non-browser/local clients may omit `Origin`, but they still require a loopback host; an omitted Origin is not permission to expose the service remotely. WebSocket upgrades accept local no-Origin clients and explicitly allowed localhost/127.0.0.1 origins. Mutation JSON is size-bounded and strict, destructive controls require an exact target phrase, and the response uses structured `200`, `400`, `404`, `409`, or persistence-failure `503` outcomes. The dashboard also sends a restrictive local Content Security Policy and does not load remote scripts, fonts, styles, or images.

### Operator troubleshooting

- **Controls are missing:** verify the selected run reports lifecycle version 2 and the corresponding capability. A v1/absent lifecycle is deliberately read-only.
- **Control is disabled:** read the adjacent reason. Offline, connecting, loading, stale data, a terminal target, incompatible phase, missing worktree, unmet dependency, or held file claim can make an action unsafe.
- **Revision conflict:** allow the dashboard to refresh, inspect the latest phase and target, then open a new confirmation. Do not replay the old request.
- **Stuck in `pausing` or `cancelling`:** inspect active workers, held claims, recent messages, coordinator health, and control audit revision. The coordinator must observe quiescence and acknowledge; do not release claims or edit persisted state manually.
- **Reconnect or stale data:** retain the visible last-known state for context, but wait for `Online` and `Current` before mutating. Activity history is deduplicated after reconnect.
- **Restart recovery:** restart the same or newer compatible server against the existing `.team/` directory. Runs, receipts, history, results, claims, and worktree metadata are persisted. A future lifecycle version fails closed rather than being rewritten.
- **Persistence reports `failed`:** stop mutations and restart the server. The triggering request may already be present only in volatile memory; it is not rolled back. Later mutations are rejected before side effects, while status, messages, memory reads, and dashboard reads remain available for diagnosis.

### Release verification matrix

Automated release gates cover server tests, type checking, bundling, dead-code/dependency checks, static breakpoints, overflow constraints, focus, touch targets, modal layering, reduced motion, forced colors, local assets, and CSP. They do not substitute for the following required human release sign-off; record results rather than assuming them from automation.

| Required manual check | Release sign-off |
| --- | --- |
| 1440x900 and 1024x768 desktop: three-workspace density, no page-level horizontal overflow | Pending manual verification |
| 768x1024 tablet, 390x844 phone, and 320px width: semantic reflow, anchored workspace navigation, long paths/messages | Pending manual verification |
| Keyboard-only: skip link, workspace/context tabs, all controls, dialog trap/Escape, opener focus restoration | Pending manual verification |
| 200% and 400% zoom: reflow, readable content, reachable modal actions, no clipped control status | Pending manual verification |
| OS forced colors/high contrast and reduced motion | Pending manual verification |
| Screen reader: landmarks, progress, status/live announcements, control consequences, disabled reasons | Pending manual verification |
| Reconnect/stale/revision-conflict/control flow and activity audit recovery | Pending manual verification |

### Backend-first rollout and rollback

Release lifecycle v2 server/coordinator support before the dashboard client, observe it through one canary run, then broaden rollout. Monitor command success/conflict/replay rates, lifecycle revision progression, time spent in `pausing`/`cancelling`, worker/claim drain time, rejected late outputs, acknowledgement latency, WebSocket reconnects, and stale-client duration. Alert on a control phase with no revision or worker/claim change beyond the normal worker timeout.

Rollback is state-preserving. Do not start an older binary while any run is `pausing`, `paused`, or `cancelling`; first resume it or let it drain and finish the required acknowledgement using the compatible coordinator. Stop new controls, preserve the `.team/` database plus results/history and every run worktree/branch, and roll the server/client back together. Lifecycle v2 uses the existing persisted run payload and requires no SQL DDL downgrade. Old readers can safely open absent/v1 runs, but must not rewrite lifecycle-v2 state. If a rollback is needed after a v2 command, retain the v2 data and return to a compatible binary to continue rather than deleting receipts, history, claims, or worktrees.

## Quick Start

### Prerequisites

- [Claude Code](https://claude.ai/claude-code) CLI installed
- Node.js 20.19+ with `npm` on `PATH`

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

# Develop an exhaustive plan without starting a run
> /deep-plan Design a zero-downtime multi-tenant data migration

# The coordinator will:
# 1. Assess scope and dispatch the planner (or plan directly for small tasks)
# 2. Present the plan for your approval
# 3. Execute steps: dispatch coders, review results, handle retries
# 4. Show real-time progress on the dashboard
```

The dashboard URL is printed at the start of each run (e.g., `http://localhost:<port>`).

### Commands

In addition to the main `/begin` command, the plugin provides focused commands:

| Command | Description |
| ------- | ----------- |
| `/status` | Check current run status and step progress |
| `/memory` | Browse and search team memory across all namespaces |
| `/resume <run-id>` | Resume an interrupted run |
| `/plan <task>` | Produce a lightweight plan preview without starting execution |
| `/deep-plan <task>` | Produce an exhaustive, resumable planning dossier through bounded recursive refinement |
| `/research <query>` | Research a topic, API, or codebase pattern |
| `/review [files]` | Review uncommitted changes or specific files |

### Deep planning

Choose `/plan` for an ordinary, reasonably well-scoped preview. Choose `/deep-plan`
for ambiguous, cross-cutting, iterative, architecture-heavy, security-sensitive,
migration-sensitive, or otherwise high-risk work. The main Claude session owns the
control loop and explicitly dispatches `software-development-team:recursive-planner`
for at most three refinement responses, asks at most five material questions one at
a time, and runs at most two deduplicated `software-development-team:researcher`
probes. Every non-cancel refinement exit then runs exactly one
`software-development-team:plan-critic` pass and one non-interactive recursive-planner
synthesis pass.

Before yielding for an answer, the controller checkpoints a compact canonical brief,
the latest validated dossier/appendix, decisions, evidence capsules, open questions,
counters, and signatures. Continue with `resume <workflow-id>`, reply `skip` to keep
the pending question as an explicit assumption/open question, or reply `cancel` to
return the latest partial artifact without critic or synthesis. Superseded drafts and
raw transcripts are not checkpointed.

The result is a readable dossier covering requirements/assumptions, goals/non-goals,
current state, architecture/data flow, ordered file-level implementation, risks and
security, testing, rollout/rollback, observability, documentation, acceptance criteria,
and open questions. Its JSON appendix is validated as the array that may later be
passed as `team_start.steps`. `/deep-plan` never calls `team_start`, starts a run,
creates a worktree, or modifies repository files.

`recursive-planner` performs exactly one pre-run, primary-workspace, read-only pass.
It never self-spawns or interacts with the user directly and intentionally has no
dashboard card or execution/worktree role; the controller owns recursion and lifecycle.

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
| **Plan-Critic** | Adversarially checks a draft plan for risks, gaps, hidden assumptions, conflicts, and sizing problems |
| **Recursive Planner** | Performs one pre-run read-only deep-plan refinement or synthesis pass; not an execution/dashboard role |
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
| `team_status` | Get current run state with timing, blockers, conflicts, execution modes, and non-sensitive persistence health |
| `team_advance` | Set the structural worktree tuple or advance a step; `mark_reviewed` is restricted to eligible read-only steps |
| `team_control` | Apply lifecycle-v2 pause, resume, cancellation, acknowledgement, or retry commands with idempotency and revision checks |
| `team_submit_result` | Submit coder/reviewer results for a step |
| `team_send_message` | Post a message to the team bus |
| `team_get_messages` | Read messages, with filtering by type and timestamp |
| `team_memory_write` | Store a key-value entry in shared memory |
| `team_memory_read` | Read memory entries by key, namespace, or search |
| `team_memory_delete` | Delete a memory entry by namespace and key |
| `team_dashboard_url` | Get the dashboard URL |

### State Machine

Steps follow this execution lifecycle (the run-level lifecycle-v2 control phase is independent):

```
pending --> coding --> reviewing --> complete
              ^           |
              |           v
              +--- needs_revision (up to 3 retries)
              
              coding/reviewing --> escalated (on stuck detection or retry exhaustion)
              pending ---------> cancelled
              coding/reviewing -> cancelling -> cancelled (after worker drain and acknowledgement)
```

Every plan step is normalized to one canonical `executionMode`: `code` or `read_only`. Omitted values default to `code`, including restored legacy runs. Code steps use the result/reviewer lifecycle and cannot use `mark_reviewed`. A read-only step may use `mark_reviewed` only while it is `coding` and before any result has been submitted; the server records a synthetic successful result and completes it. This strict split prevents a coordinator from bypassing code review with the read-only shortcut.

### Git Worktree Isolation

Every execution step receives one mandatory run-scoped worktree, `.worktrees/{runId}/step-{N}`, on branch `team-{runId}-step-{N}`. The coordinator creates it only when the pending step is first admitted: it captures the current target branch and exact commit, creates from that commit, and persists `{targetBranch, targetCommit, path, branch}` before `start_coding`. The server structurally enforces the exact run/step path and branch plus non-empty target branch and commit, and rejects `start_coding` without that set-once tuple. Re-dispatches reuse that context; missing or inconsistent context blocks or escalates the step rather than recapturing or creating another worktree.

| Role | Repository location and authority |
| --- | --- |
| Planner / plan-critic / recursive-planner | Pre-run or pre-approval and read-only in the primary workspace; no execution worktree. |
| Coder / documentation | Read, write, verify, and commit only in the supplied worktree. |
| Reviewer / researcher | Read-only inspection and verification only in the supplied worktree. |

Exact declared file strings remain the scheduling contract: overlapping claims serialize even in separate worktrees. The StateMachine manages workflow state, not Git; it never creates, removes, switches, commits, or merges worktrees or branches.

Only an explicit reviewer approval permits the coordinator to switch to the captured target branch and merge the step branch there with `--no-ff`. A merge conflict is aborted, recorded with its exact conflicting files, and escalated while the worktree and branch are preserved; the coordinator never auto-resolves conflicts. After a successful merge, remove the worktree and then delete the branch. A confirmed abandoned, unmerged step is never merged: remove its worktree first, then force-delete its branch. On either cleanup failure, preserve artifacts and report the exact path, branch, and error.

### Persistence, messages, and failure recovery

Run state, messages, and memory changes are synchronously enqueued on one process-wide `PersistQueue`. Every MCP mutation and dashboard control/guidance mutation enters the same serialized admission lane, checks health before side effects, and waits for the global durability barrier before reporting success. Reads do not enter the lane. If the first disk write fails, its in-memory mutation may be volatile—there is deliberately no atomic rollback—but the request fails, the health latch becomes `{ status: "failed", restartRequired: true, code: "persistence_failed", failedAt, operationKind }`, queued and later mutations are rejected before side effects, and recovery requires a server restart. Shutdown drains all queued work and exits unsuccessfully if durability cannot be confirmed.

Message startup restore processes `messages.jsonl` line by line. Blank lines are ignored; malformed JSON, invalid payload shapes/types, invalid message types or timestamps, and mismatched run IDs are skipped without aborting startup. Warnings contain only run ID, line number, and a bounded reason code—never the persisted payload. Message bodies, result summaries/details, memory values, prompts, credentials, operator reasons, and exception text are likewise excluded from MessageBus, StateMachine, and persistence-failure logs; logs retain only bounded metadata. `team_get_messages.since` accepts valid ISO datetimes with timezone offsets and compares parsed epoch instants exclusively, so offset-equivalent timestamps behave identically.

This durability work does not change server locking. `.team/server.lock` remains advisory warning-only detection for concurrent live instances; it does not refuse startup or serialize separate Claude Code/Codex processes. Continue using one host session at a time per project.

### Coordinator scheduling

The coordinator treats `maxParallel` as a worker budget, not a count that includes the coordinator. It counts every spawned role worker (planner, plan-critic, coder, reviewer, researcher, and documentation); host capacity of four therefore allows three workers, while absent or unknown capacity permits one. The server reports capacity in the `hostCapacity` field of `team_status`. There is no server-side WIP cap.

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
npm run typecheck

# Build
npm run build

# Run tests
npm test

# Watch mode
npx vitest

# Find unused files, exports, and dependencies
npm run knip
```

The current development stack uses the TypeScript 6 compiler, Vitest 4, and
jsdom 29. The same TypeScript package provides the compiler API used by tsup
for declaration generation.

## Project Structure

```
software-development-team/
  agents/                    Agent definitions
    planner.md               Planner agent
    plan-critic.md           Plan critic agent (read-only critique)
    recursive-planner.md     One-pass deep-plan refinement/synthesis agent (read-only)
    coder.md                 Coder agent
    reviewer.md              Reviewer agent
    researcher.md            Researcher agent
    documentation.md         Documentation agent
  commands/
    begin.md                 /begin command entry point (defines the coordinator)
    status.md                Check run status and progress
    memory.md                Browse and search team memory
    resume.md                Resume an interrupted run
    plan.md                  Plan-only mode (no execution)
    deep-plan.md             Bounded recursive planning dossier (no execution)
    research.md              Standalone research queries
    review.md                Standalone code review
  hooks/
    hooks.json               SessionStart hook that pre-warms the server build
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
