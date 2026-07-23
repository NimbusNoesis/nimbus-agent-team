# NimbusNoesis Agent Coding Team

## Project Overview

A Claude Code plugin that orchestrates a multi-agent coding team (coordinator, planner, plan-critic, coder, reviewer, researcher, documentation) with shared memory, a message bus, and a real-time dashboard. It also ships a standalone pre-run `recursive-planner` for bounded deep planning; that helper is not an execution/dashboard role. Built as an MCP server with a Preact web dashboard.

## Architecture

- **MCP Server** (`server/src/index.ts`) — entry point, registers tools, starts dashboard, manages persistence
- **Database** (`server/src/db/database.ts`) — in-memory SQLite database via sql.js (pure JS/WASM). Single backing store for runs, messages, and memory entries. Pure storage — no EventEmitter.
- **State Machine** (`server/src/state/machine.ts`) — manages step lifecycle: `pending` -> `coding` -> `reviewing` -> `complete` / `escalated`. Every step is canonicalized to `executionMode: "code" | "read_only"` (default `code`, including legacy restore). `markReviewed` (`team_advance` action `mark_reviewed`) is allowed only for a `read_only` step still in `coding` with no submitted result; it records a synthetic `done` result and completes the step. Code steps must use the result/reviewer lifecycle. Enforces dependency ordering, file conflict detection, and stuck detection, and validates plans at `team_start` (duplicate step IDs, unknown dependencies, and dependency cycles are rejected). The server has no WIP cap; coordinators instead bound simultaneous workers by the host capacity, which `team_status` reports as `hostCapacity`. It manages workflow state only and never manages Git worktrees, branches, commits, switches, merges, or cleanup. Backed by Database.
- **Message Bus** (`server/src/bus/message-bus.ts`) — append-only message log with EventEmitter, 10K cap per run. Backed by Database. `MessageLogSync` (`server/src/bus/message-sync.ts`) tails sibling-process `messages.jsonl` appends into it via `ingestExternal`.
- **Memory Store** (`server/src/memory/store.ts`) — key-value store in 5 namespaces (decisions, context, learnings, reviews, reflections). Extends EventEmitter, emits `entry_change` on writes and `entry_delete` on deletes (carrying the entry as it existed). Backed by Database.
- **Tool Registry** (`server/src/tools/registry.ts`) — dispatches MCP tool calls to handlers
- **Dashboard** (`server/src/dashboard/`) — Express + WebSocket server broadcasting state and message events to a Preact + Signals client
- **Persistence** (`server/src/state/persistence.ts`) — file-based persistence in `.team/` (disk I/O layer, orthogonal to the in-memory Database). Run-state saves, message appends, memory writes/deletes, and graceful-shutdown saves use one process-wide `PersistQueue` (`server/src/state/persist-queue.ts`). Its shared mutation lane serializes the complete health-preflight -> in-memory mutation -> global barrier transaction across MCP and dashboard surfaces; reads bypass the lane. The first write failure latches non-sensitive failed health for the process, rejects the triggering response, blocks queued/later mutation side effects, and requires restart. Shutdown drains the queue and exits with failure when durability cannot be confirmed.

## Key Files

```
agents/            Agent definitions (planner, plan-critic, recursive-planner, coder, reviewer, researcher, documentation)
commands/          User-invocable slash commands (begin, deep-plan, status, memory, resume, plan, research, review)
server/src/
  index.ts         MCP server setup, tool registration, Database wiring
  types.ts         All TypeScript types (StepState, RunState, Message, MemoryEntry, DashboardEvent)
  db/              Database (sql.js in-memory SQLite)
  state/           StateMachine + Persistence + PersistQueue
  bus/             MessageBus + MessageLogSync (cross-instance feed sync)
  memory/          MemoryStore
  tools/           Tool handlers (workflow, results, messages, memory)
  dashboard/
    server.ts      Express + WebSocket server
    public/        Dashboard UI (index.html, app.js, style.css)
```

## Build & Test

```bash
cd server
npm install          # install dependencies
npm run typecheck    # type check with the TypeScript 7 native CLI
npm run build        # build (ESM output to dist/)
npm test             # run tests (711 tests across 24 files)
npx vitest           # watch mode
npm run knip         # find unused files, exports, and dependencies
```

Local development requires Node.js 20.19+. The test stack is Vitest 4 with
jsdom 29. `@typescript/native` provides the TypeScript 7 `tsc` CLI; the
`typescript` dependency intentionally aliases TypeScript 6 because tsup still
needs its compiler API to emit declarations.

The commands above are for local development. When installed as a plugin, the server **builds itself on launch** — see "Self-building MCP server" below.

## Development Patterns

### Dashboard data paths differ from MCP tool paths
The `team_status` MCP tool handler enriches step data with computed fields (e.g., `blockingReasons`) and the non-sensitive `persistence` health object. The dashboard receives raw `RunState` via WebSocket `state_update` events and `GET /api/runs`. If you add a computed field to the tool response, the dashboard won't see it unless you also compute it client-side or add it to the broadcast event.

### MCP tool schemas are single-sourced
Each tools module (`tools/workflow.ts`, `tools/messages.ts`, `tools/memory.ts`, `tools/results.ts`) owns its zod contract. Simple tools export a raw shape that both the handler and `server.tool()` registration reuse. Workflow tools that need root strictness or cross-field refinement (`team_start`, `team_advance`, and `team_control`) export a complete object schema; both the handler and production `registerTool()` use that complete schema so `.strict()` and `superRefine()` cannot be lost by spreading a shape. `index.ts` defines no inline zod contracts. Shared validators (`positiveInt`, `memoryKey`) live in `tools/schemas.ts`, and `since` on `team_get_messages` validates as `z.string().datetime({ offset: true })`. When changing parameters, edit the owning tools module—never recreate the schema in `index.ts`, or registration and handler validation will drift.

### EventEmitter pattern for cross-component communication
StateMachine, MessageBus, and MemoryStore all extend EventEmitter. The dashboard server listens for events and broadcasts to WebSocket clients. When adding new observable state, follow this pattern: emit from the store -> listen in dashboard server -> broadcast to clients.

One deliberate asymmetry: MessageBus emits `message` for locally posted messages and a DISTINCT `external_message` for messages ingested from sibling processes (`ingestExternal`). The dashboard broadcasts BOTH as the same `new_message` event, but `index.ts` binds `Persistence.appendMessage` ONLY to `message`. Never rebind persistence to `external_message` — that would re-append lines to a `messages.jsonl` the sibling process already owns (echo loop).

### Dashboard uses Preact with Signals
The dashboard client is built with Preact and `@preact/signals` for reactive state management. Source lives in `server/src/dashboard/client/` with components organized by panel (header, steps, activity, status). State is managed via module-level signals in `state/store.ts`. The client is bundled by esbuild (invoked from tsup's `onSuccess` hook) into `dist/dashboard/public/app.js`. JSX auto-escaping handles XSS prevention. Styles live in `server/src/dashboard/public/style.css`; components reference stable CSS class names, so the stylesheet can be restyled without touching component markup (and tests that assert on class names stay green).

### Run navigation is a tab bar, not a `<select>`
Run switching is handled by `RunTabs.tsx` (`components/header/`) — an always-visible, horizontally-scrollable row of run tabs rendered between `<Header />` and `<main>` in `app.tsx`. Each tab derives its active state reactively from the `currentRun` signal and calls `selectRun()` on click; the active tab is auto-scrolled into view via a guarded `scrollIntoView` (jsdom lacks it, so the call is feature-detected for tests). This replaced an earlier header `<select>` (`RunSelector`) that (a) hid itself whenever there was ≤1 run and (b) used the controlled-`<select>` anti-pattern of setting `selected` on `<option>` instead of `value` on the `<select>`, which desynced after Signals-driven re-renders. When you need a controlled selection in Preact, prefer deriving state from a signal and binding `value` on the element — don't drive it through per-option `selected`.

### Subagent MCP tool inheritance
Subagents dispatched via the Agent tool inherit all MCP tools from the parent session by default. The plugin's `.mcp.json` makes the `software-development-team` MCP server available in the session, and subagents can call its tools directly. Each agent's `tools:` frontmatter acts as an allowlist, scoping which MCP tools that agent can access. Note: plugin agents cannot use the `mcpServers` frontmatter field (silently ignored for security), but this is irrelevant since the server is already session-level.

### Agent dispatches require an explicit namespaced subagent_type

Plugin agents register as `software-development-team:<name>` (e.g., `software-development-team:coder`). Every Agent-tool dispatch in the coordinator commands must pass one of those namespaced values as an explicit `subagent_type` — bare names like `"coder"` are not valid agent types, and omitting the parameter dispatches the default general-purpose agent, which has no team role instructions and never calls `team_submit_result`, stranding the step in `coding`. The `agent` label passed to `team_advance(start_coding)` is separate: it must be a fixed dashboard roster name (`planner`, `coder`, `reviewer`, `researcher`, `documentation`) or the agent status panel lights no card. As a backstop, the coordinator commands include a safety net: after any worker returns, refresh `team_status`, and if the step is still `coding`, close it (`mark_reviewed` for read-only work, `team_submit_result` on the worker's behalf otherwise).

### MCP tool names include a plugin prefix

When loaded via the plugin system, MCP tool names are prefixed with `plugin_<plugin-name>_`. The full tool name pattern is `mcp__plugin_software-development-team_software-development-team__team_X`. Agent definitions, skills, and the coordinator command must all use this full name — the shorter `mcp__software-development-team__team_X` form does not exist at runtime.

### Multi-host: also runs in OpenAI Codex CLI and Cursor

Parallel distributions live in the repo-root `codex/` directory (`codex/agents/*.toml`, `codex/skills/<name>/SKILL.md`, `codex/install.sh`) and `cursor/` directory (`cursor/agents/*.md`, `cursor/commands/*.md`, `cursor/install.sh`). Both are **additive** — they reuse this plugin's `server/` unchanged via absolute paths and do not touch the Claude Code plugin. Three host-specific differences matter when editing shared behavior:

- **Tool prefix differs per host.** Claude Code (plugin): `mcp__plugin_software-development-team_software-development-team__team_X`. Codex sanitizes the server name for native callable identifiers: `mcp__software_development_team__team_X` (the raw hyphenated `mcp__software-development-team__team_X` form is invalid on Codex). Cursor uses a single-underscore server prefix and keeps the hyphens: `mcp_software-development-team_team_X` (the Cursor surfaces also tell the model to fall back to the exact names in the session's tool list if a Cursor build surfaces them unprefixed).
- **Dispatch model differs per host.** Claude Code dispatches subagents via the built-in Agent tool with `subagent_type`. Codex spawns subagents on the coordinator's request (no Agent tool); the coordinator passes the full per-step context in the spawn request, and the static role lives in the agent TOML. Cursor dispatches its named subagents (`~/.cursor/agents/<name>.md`); like the other hosts, the coordinator passes the full per-step context in the dispatch prompt. Cursor subagents have no per-agent tool allowlist (no `tools:` frontmatter equivalent), so their mutation boundaries are instruction-enforced; only `recursive-planner` carries `readonly: true` (the analog of Codex's `sandbox_mode = "read-only"`).
- **Entry points differ per host.** Claude Code uses **commands** (`commands/*.md` — begin, deep-plan, status, memory, resume, plan, research, review — with `description`/`argument-hint` frontmatter and `$ARGUMENTS` templating). Codex uses **skills** (`codex/skills/<name>/SKILL.md`, including `deep-plan`, with `name` + `description` frontmatter only and no `$ARGUMENTS`; the user's request arrives as context). Cursor uses **commands** (`cursor/commands/*.md`, plain Markdown with no frontmatter and no `$ARGUMENTS`; the user's request arrives as context). Do not put flat `.md` files in a plugin `skills/` directory on the Claude side — the plugin system only loads skills as `skills/<name>/SKILL.md` directories, so flat files there are silently ignored.

When changing coordinator logic or an agent's instructions, update the `plugins/software-development-team/` source of truth **and** its `codex/` and `cursor/` counterparts so all hosts stay in sync. The `server/` is shared, so server changes apply to every host automatically. `server/tests/coordinator-instructions.test.ts` enforces the cross-host parity contract; extend its host arrays when adding a surface.

### Deep-plan is bounded, pre-run, and controller-owned

`commands/deep-plan.md`, `codex/skills/deep-plan/SKILL.md`, and `cursor/commands/deep-plan.md` are mirrored main-session controllers. They may produce at most three recursive-planner refinement responses, five one-at-a-time material questions, and two deduplicated research probes; every non-cancel refinement exit then gets exactly one plan-critic pass and one recursive-planner synthesis pass. `recursive-planner` itself performs exactly one read-only pass and never self-spawns or asks the user directly.

The controller checkpoints a compact canonical brief, latest validated dossier and `team_start.steps` appendix, decisions, evidence capsules, open questions, counters, signatures, and pending request under `deep-plan-<D>-checkpoint`. It writes this `context` entry on behalf of the planning role. `resume <D>` reconstructs from that checkpoint plus the new answer; `skip` records an explicit assumption/open question, and `cancel` returns the latest partial artifact without critic/synthesis. Never persist raw transcripts, chain-of-thought, superseded drafts, secrets, or full research dumps.

Claude dispatches explicit `software-development-team:recursive-planner`, `:researcher`, and `:plan-critic` types. Codex reads the corresponding installed TOML before each spawn and reserves a complete seven-label grammar-safe set (three rounds, two probes, critic, synthesis); resume reuses only not-yet-created labels from the original set. Cursor dispatches the installed `recursive-planner`, `researcher`, and `plan-critic` subagents by name. All hosts use collision-safe no-run reflection keys. Deep-plan never calls `team_start`, starts a run, creates a worktree, or mutates repository files; its validated JSON appendix is only a later handoff to the normal begin/approval workflow.

The fixed execution/dashboard roster remains coordinator, planner, coder, reviewer, researcher, and documentation. Do not add `recursive-planner` to `start_coding`, scheduler worker lists, worktree ownership, dashboard colors/cards, or merge lifecycle rules.

Coordinator scheduling is deterministic: reserve capacity for eligible review/revision lifecycle work first, then choose dependency-complete pending work in plan order. Worker budgets come from the `hostCapacity` field in the `team_status` response (`maxParallel = hostCapacity - 1`). The server reports that field only when `TEAM_HOST_CAPACITY` is configured with the host's actual total agent-slot quota; CPU parallelism is not an agent quota. If it is absent or invalid, coordinators fall back to one worker. File claims compare as exact planned strings and overlapping claims always serialize, including in worktrees. `start_coding` is the authoritative admission check; rejection requires a fresh status and reschedule. A native spawn failure must be submitted as a `blocked` result, and normal scheduling uses neither pause nor cancel semantics.

### Lifecycle-v2 controls are coordinator-drained and revisioned

All hosts implement the same lifecycle-v2 protocol in their `begin` and `resume` surfaces. Every coordinator pass polls `team_status` and treats its `lifecycleVersion`, `capabilities`, run/step `actionAvailability`, `revision`, phase, workers, and blockers as authoritative. `team_control` commands carry a unique operation-scoped `commandId`, fresh `expectedRevision`, and exact run/step target; cancellation also requires explicit confirmation. Same-fingerprint command replay is idempotent. A stale revision or a command-ID/fingerprint conflict requires a status refresh and reschedule or fresh user intent, never a blind destructive retry. Unknown future lifecycle versions fail closed.

`pause_run` freezes all admissions immediately. `pausing` is a cooperative drain, not `paused`: never kill active native workers, spawn/re-spawn work, merge, clean worktrees, or release claims. Preserve worktrees, branches, results, claims, and artifacts; only after the coordinator verifies every native worker is quiescent and fresh availability permits it may it send the distinct `acknowledge_pause`. `resume_run` is valid only from acknowledged `paused` state and requires recomputing the runnable set from fresh dependencies, blockers, and claims.

`cancel_run` and `cancel_step` use the same cooperative-drain rule. Active targets become `cancelling`, keep claims/worktrees, and reject late result state mutations; drained output is audit context only. An inactive cancellable target may become `cancelled` immediately because it has no native worker to drain. After native workers in the requested scope are quiescent, send `acknowledge_cancel` with matching run or step scope. No cancelled branch is merged, and abandoned-worktree cleanup happens only after acknowledgement. Run cancellation freezes all admissions. Step cancellation leaves dependent steps pending with cancelled-dependency blockers, while independent work may continue on a fresh scheduler pass. Completed and cancelled states are immutable.

Manual retry uses `team_control(retry_step)` only when fresh availability permits an escalated step, the run phase is `none`, the durable worktree is consistent, dependencies and claim reacquisition are clear, and the manual-attempt budget remains. It reuses the worktree, preserves result/review/audit history, increments `manualAttempt`, and resets per-attempt review counters. `team_advance(resolve_escalation)` remains a deprecated compatibility alias with identical safety rules.

After coordinator restart, reconstruct phase, revision, receipts/history, cancellation state, and worktree context from `team_status`. Restored `pausing`/`cancelling` phases continue draining and must not be acknowledged merely because the old coordinator process is absent. Preserve completed results, branches, worktrees, and artifacts. Do not downgrade to lifecycle v1 while any persisted run is `pausing`, `paused`, or `cancelling`; resolve it with a v2 binary first.

### Coordinator message relay for dashboard visibility

The coordinator posts messages on behalf of agents (`team_send_message` with the correct `from` field) at each lifecycle point to keep the dashboard activity feed populated. This is for observability only — agents call `team_submit_result` directly to submit their work.

### Timer cleanup
When using `setInterval` for live timers in the dashboard, store the interval ID in a module-level variable and clean up on run change and `beforeunload`.

### Agent definitions follow a standard template
Agent files use YAML frontmatter (`name`, `description`, `tools`, `color`; `model` is optional) followed by markdown sections: Role, Tool Names, Process, File Ownership, Verification, On Revision, Self-Review Checklist, Reflection, Submitting Results, Debug Logging, Writing to Memory. New agents should follow this structure. Agents intentionally omit `model` so each inherits the user's active session model rather than pinning a tier; add an explicit `model:` only when an agent genuinely needs a fixed model.

### Read-only / critique-only agents use a trimmed template

Agents that do not touch code and do not submit step results (for example `plan-critic` and `recursive-planner`) omit run-result lifecycle sections and explicitly define their dispatch/output contracts and mutation boundaries. Their `tools` frontmatter excludes `team_submit_result`. `plan-critic` returns seven critique sections; `recursive-planner` returns one exact JSON envelope containing compact state, a dossier, and a graph-valid appendix. Both use caller-supplied no-run reflection keys outside runs.

### Different agents use different MCP tool subsets
Not all agents get all 4 MCP tools. Planner gets memory read/write and messaging but no result submission. Plan-critic and recursive-planner get only the memory tools their read-only contracts require; recursive-planner's only write is its exact reflection. Execution roles receive lifecycle tools appropriate to their responsibilities. Keep the frontmatter allowlist, documented mapping, and actual role contract aligned.

### Memory namespace write authority
Each memory namespace has designated writer agents to prevent authority conflicts and keep signal quality high. All agents read all namespaces (`decisions`, `context`, `learnings`, `reviews`, `reflections`), but writes are scoped:

| Namespace      | Writers                        | Purpose                                                              |
| -------------- | ------------------------------ | -------------------------------------------------------------------- |
| `decisions`    | Planner                        | Architectural decisions and design choices                           |
| `context`      | Planner, Researcher            | Codebase structure, conventions, factual background                  |
| `learnings`    | Coder, Researcher, Coordinator | Patterns, gotchas, best practices from implementation or research    |
| `reviews`      | Reviewer                       | Review calibration notes and recurring quality patterns              |
| `reflections`  | All agents                     | Post-step introspection (what was tricky, gotchas for future steps)  |

Agents that discover information belonging to another namespace should note it in their result summary. The coordinator routes it to the appropriate agent. This prevents contradictory entries (e.g., coder overriding planner's architectural decision).

### Database is pure storage, stores own the EventEmitter pattern
The Database class (`server/src/db/database.ts`) is a pure storage layer backed by sql.js (in-memory SQLite). It does NOT extend EventEmitter. The stores (StateMachine, MessageBus, MemoryStore) own the EventEmitter pattern — they read from DB, mutate, write back, then emit events. This keeps the existing dashboard and persistence wiring unchanged.

### Store mutation pattern: read → mutate → write back → emit clone
All store mutations follow: `const run = this.db.getRun(id)` → mutate the local object → `this.db.updateRun(run)` → `this.emit('state_update', structuredClone(run))`. The DB returns plain objects from JSON, so mutations are on local copies that must be explicitly saved back.

### Mandatory run-scoped Git worktree workflow

Every execution step uses exactly one mandatory worktree, `.worktrees/{runId}/step-{N}`, on `team-{runId}-step-{N}`. Planner, plan-critic, and recursive-planner are pre-run/pre-approval and read-only in the primary workspace; recursive-planner is never an execution step. Coder and documentation are mutating roles: all repository reads, writes, verification, and commits occur only in the supplied worktree. Reviewer and researcher use their supplied worktree only for read-only repository inspection and verification.

On a pending step's first admission, the coordinator captures the current target branch and exact commit, creates the worktree from that commit, then calls `team_advance(action: "set_worktree", worktree: { targetBranch, targetCommit, path, branch })` before `start_coding`. The tuple is durable step state, returned by `team_status`, and set-once. StateMachine requires the exact `.worktrees/{runId}/step-{N}` path and `team-{runId}-step-{N}` branch plus non-empty `targetBranch` and `targetCommit`; `start_coding` revalidates the tuple and rejects when it is missing or malformed. Reviewer, revision-coder, researcher, documentation, and interrupted-worker re-dispatches must reuse it. If it is absent or inconsistent, block or escalate and preserve any artifacts—do not recapture or create a replacement.

File claims compare as exact planned strings. Every exact overlap serializes, even where worktrees are different; worktrees provide filesystem isolation and merge hygiene, never permission to overlap claims.

Only explicit reviewer approval authorizes the coordinator to switch to the captured target branch and merge the step branch there with `--no-ff`. On conflict, run `git merge --abort`, preserve the worktree and branch, record the exact error and conflicting files, and escalate. Never auto-resolve. After a successful merge, remove the worktree then delete the branch. A confirmed abandoned, unmerged step is never merged; remove its worktree first and then force-delete its branch. Preserve artifacts and report the exact worktree path, branch, and error if either cleanup fails.

### team_send_message requires an existing run

`handleTeamSendMessage` rejects unknown run IDs so messages cannot be orphaned under fabricated runs (the dashboard only shows messages for runs that exist). Anything running before `team_start` — the planning phase in `begin`, plan-only mode — must persist rationale via `team_memory_write` instead; the coordinator relays one planning-phase summary message right after `team_start` succeeds. The dashboard's `POST /api/guidance` applies the same check (404 for unknown runs).

### Dashboard binds loopback only

`startDashboard` listens on `127.0.0.1` explicitly. The dashboard has no authentication and `/api/guidance` injects messages the coordinator treats as user guidance — never widen the bind address.

WebSocket upgrades are additionally Origin-checked (`verifyClient` in `dashboard/server.ts`): browsers do not apply CORS to WebSockets, so loopback binding alone would let any web page open `ws://localhost:<port>` and read the event stream. The allowlist is exact-hostname only — `localhost` / `127.0.0.1` / `::1` (plus the bracketed `[::1]` form) — because substring matching would admit e.g. `http://localhost.evil.example`. Requests with no Origin header (non-browser clients: tests, wscat, curl) are allowed; malformed Origins are rejected. The CSP `connect-src` is likewise pinned to localhost ws forms (`ws://localhost:*`, `ws://127.0.0.1:*`, and their `wss:` variants).

### Memory restore preserves timestamps

Startup restore uses `MemoryStore.restore()`, which writes the entry exactly as persisted (original `updatedAt`, no `entry_change` event). `write()` is only for live writes — it re-stamps `updatedAt` and emits. Using `write()` in the restore path would re-stamp every entry to boot time and scramble `updated_at` ordering after each restart.

### Step results keep an audit trail

`submitResult` pushes any displaced result onto `stepState.resultHistory` before overwriting `result` (reviewer verdicts overwrite coder submissions by design). `markReviewed` never archives an existing result: it rejects whenever `result` is non-null and succeeds only for a pristine eligible `read_only` step still in `coding`, writing its synthetic `done` result directly. The history is persisted in `state.json` and included per step in the `team_status` response for audit and recovery. Relatedly, `resolveEscalation` re-claims the step's planned files when moving `escalated` -> `coding` (escalation cleared the claims), and rejects with a file-conflict error — before any mutation — if those files are now claimed by another active step.

### Message log compaction spans restarts

`Persistence.appendMessage` compacts a run's `messages.jsonl` every 2000 appends, but the append counter is in-memory only. So it also compacts on the first append per run per process lifetime — truncating over-cap files left by prior sessions — while keeping the hot path cheap. Compaction rewrites through a per-process unique temp name (`messages.jsonl.tmp.<pid>.<seq>`) plus atomic rename, so concurrent sibling compactions cannot corrupt the file. A bounded lost-append window remains: a sibling's `appendFile` landing between compaction's read and its rename is dropped from the on-disk log. That residual is accepted by design — the consequence is restart-restore-only (the live DB and dashboard feed already carry the message) — so do not "fix" it without revisiting the design decision.

### Message restore, filtering, and payload-safe logs

`Persistence.loadMessages` restores JSONL one non-blank line at a time. It skips malformed JSON and invalid message payloads (shape/type, empty required field, message type, timestamp, or mismatched run ID) while continuing startup and enforcing the 10K cap. Restore warnings expose only `runId`, `lineNumber`, and a bounded `reasonCode`; they never include the line or payload. `team_get_messages.since` accepts ISO datetimes with offsets and uses parsed epoch instants with exclusive semantics (`messageEpoch > sinceEpoch`), so equivalent instants in different offsets compare identically.

MessageBus and StateMachine logs must remain metadata-only. Never add message bodies, result summaries/details, memory values, prompts, credentials, operator reasons, persisted payloads, or raw exception text to those logs. Persistence failure health/logging is limited to `status`, `restartRequired`, `code`, `failedAt`, and an allowlisted `operationKind` (unknown input maps to `unknown`).

### Fail-closed persistence contract

All production persistence event listeners enqueue synchronously. `PersistQueue.runMutation()` is the single admission lane shared by `ToolRegistry` mutations and dashboard control/guidance: it holds through `assertHealthy`, the in-memory handler, and `barrier`. Do not add a per-surface mutex or move the barrier outside this lane. The first failed request may already have changed volatile SQLite/dashboard state; atomic rollback is explicitly not provided. That request still fails, queued/later mutations are rejected before handler side effects, reads and `team_status.persistence` remain available, and restart is the only recovery. `drain()` includes late enqueues; shutdown must not exit successfully after a latched failure.

### One live server per project

The server writes its PID to `.team/server.lock` at startup and logs a prominent warning when another live server already holds the lock. The lock is advisory and warning-only: it neither refuses startup nor serializes separate processes. Two concurrent sessions against the same project (a second Claude Code window, or Claude Code + Codex at once) each hold an independent in-memory DB — still use the hosts sequentially. Precisely what concurrency means now:

- **Run state stays last-writer-wins, but safely.** Every `state.json` write goes to a per-process unique temp name (`state.json.tmp.<pid>.<seq>`) followed by an atomic rename, eliminating the interleaved-content corruption two writers sharing one temp path used to produce. A lost update is now DETECTED, not silent: `saveRunState` embeds a top-level `writerStamp` `{pid, seq, savedAt}` (serialized into a copy — the live run object never gains the property) and re-reads the on-disk stamp just before rename; a mismatch logs a metadata-only warning once per run per process (debug thereafter) and proceeds. Detection never throws — an unreadable on-disk stamp (`stamp_unreadable`) skips detection rather than latching the fail-closed PersistQueue. `loadRunState` strips `writerStamp` before normalization, and salvages a legacy trailing-garbage `state.json` (a valid leading JSON document followed by junk from the historical shared-temp-path race) instead of skipping the run.
- **Messages now sync cross-instance.** `MessageLogSync` (`bus/message-sync.ts`) tails sibling processes' appends to `.team/runs/*/messages.jsonl` (fs.watch plus a ~1.5s poll backstop) and feeds validated new lines through `MessageBus.ingestExternal`, so the dashboard-hosting process's feed shows messages persisted by sibling MCP server processes — the frozen-activity-feed incident class. Accepted limitation: a run created by a sibling process AFTER this process booted is never ingested (its `isKnownRun` gate stays false); acceptable because the dashboard-hosting coordinator creates the runs it displays.

Also launch from the project root: `TEAM_DIR` resolves from the server's cwd, so a session started in a subdirectory gets a different `.team`.

### Use sql.js, not better-sqlite3
better-sqlite3 requires native C++ compilation and is incompatible with Node v24+ (needs C++20). sql.js is a pure JS/WASM SQLite that works everywhere with no native dependencies. The Database class uses a static `Database.create()` factory method for async sql.js initialization.

### All user entry points are commands

Beyond the coordinator (`begin`), the plugin ships seven focused slash commands in `commands/` that provide workflows without the full execution lifecycle (frontmatter: `description`, `argument-hint`; `$ARGUMENTS` templating). There are three patterns:

- **Utility commands** (`status`, `memory`, `resume`) — call MCP tools directly to query or manage state
- **Agent-dispatch commands** (`plan`, `research`, `review`) — dispatch a single subagent via the Agent tool (always with an explicit namespaced `subagent_type`) for focused work
- **Bounded planning controller** (`deep-plan`) — repeatedly dispatches one-pass read-only roles within hard budgets, checkpoints canonical state, and never starts execution

These files previously lived in `skills/` as flat `.md` files, where the plugin system silently ignored them (skills require `skills/<name>/SKILL.md` directories) — keep them in `commands/`.

Agent-dispatch commands that run outside a team run (no `runId`) must explicitly override run/worktree/lifecycle assumptions. Standalone research/review normally forbid result/message writes; plan and deep-plan use narrowly scoped memory writes for planning rationale, exact reflections, and canonical checkpoints. Never fabricate a run ID merely to satisfy an execution-oriented agent template.

### Memory keys are run-scoped to prevent cross-run overwrites

Reflection and review memory keys are prefixed with the first 8 characters of the run ID (e.g., `a1b2c3d4-step-1-reflection` instead of `step-1-reflection`). This prevents run N+1 from silently overwriting run N's entries, since the DB uses `PRIMARY KEY (namespace, key)` with upsert semantics. The coordinator includes the 8-char prefix in every agent dispatch prompt. Durable entries (compacted summaries, promoted learnings) use descriptive keys without a run prefix.

### Post-run promotion and compaction

After a run completes, the coordinator promotes generalizable reflections and review patterns into the `learnings` namespace with durable, descriptive keys. If the `reflections` namespace exceeds 30 entries, old entries (not from the current run) are compacted into 2-4 thematic summaries and the originals are deleted via `team_memory_delete`.

### team_memory_delete tool

The `team_memory_delete` MCP tool deletes a memory entry by namespace and key, both from the in-memory SQLite DB and from disk (`.team/memory/{namespace}/{key}.json`). `MemoryStore.delete()` emits a distinct `entry_delete` event carrying the entry exactly as it existed; the dashboard server broadcasts it as `memory_entry_delete` and the client removes the entry live. (It does NOT emit `entry_change` with an empty value — that would upsert a ghost entry instead of removing it.) Used by the coordinator during post-run compaction to clean up old reflection entries after summarizing them.

### team_memory_read search ignores namespace filter

The `handleTeamMemoryRead` handler checks `namespace` before `search`. When both are provided, `search` is ignored — it returns all entries in that namespace instead. To search, call with `search` only (no `namespace`). Results include a `namespace` field for client-side grouping. Search queries match literally: `searchMemory` escapes `%` and `_` (and the escape character itself) and uses `LIKE ... ESCAPE`, so they are not SQL wildcards.

### Inserting content into Markdown ordered lists

When adding new content between items in an existing ordered list, do NOT insert a `### Heading` between items — this breaks the list context and triggers MD029 linter warnings. Instead, nest the new content as indented bold sub-items under the parent item (e.g., **3a.** / **3b.**), keeping the top-level numbering unbroken. Similarly, when widening a Markdown table cell, also widen the header and separator rows to match the widest cell.

### Self-building MCP server (build on launch)

Claude Code has no plugin install/postinstall hook, and `${CLAUDE_PLUGIN_ROOT}` is read-only and reset on every update — so build output cannot live there. Instead the server builds itself at launch into the writable, persistent `${CLAUDE_PLUGIN_DATA}`:

- **`.mcp.json`** launches `sh ${CLAUDE_PLUGIN_ROOT}/server/launch.sh <SRC_DIR> <DATA_DIR>` instead of `node dist/index.js`.
- **`server/launch.sh`** calls `scripts/ensure-build.sh` (which prints the built entry path on stdout, all logs on stderr) then `exec node "$ENTRY"`. Because the build runs *inside* the launch command, the server is always built before `node` runs — independent of hook/MCP startup ordering, which the docs do not guarantee.
- **`server/scripts/ensure-build.sh`** is idempotent: it syncs sources into `${CLAUDE_PLUGIN_DATA}/server`, runs `npm ci` (only when the manifest changed) and `tsup`, and skips entirely when a content signature of `src/` + configs matches the last build (`.build-stamp`).
- When `DATA_DIR` is empty or equals `SRC_DIR` (local dev), `ensure-build.sh` builds in place instead of out-of-tree.

First launch after install/update runs a full `npm ci` + build (~30–60s); bump `MCP_TIMEOUT` if the MCP client times out. `dist/` and `node_modules/` stay gitignored — nothing built is committed.
