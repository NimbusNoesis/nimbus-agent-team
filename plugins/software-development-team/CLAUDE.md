# Claude Coding Team

## Project Overview

A Claude Code plugin that orchestrates a multi-agent coding team (coordinator, planner, plan-critic, coder, reviewer, researcher, documentation) with shared memory, a message bus, and a real-time dashboard. Built as an MCP server with a Preact web dashboard.

## Architecture

- **MCP Server** (`server/src/index.ts`) — entry point, registers tools, starts dashboard, manages persistence
- **Database** (`server/src/db/database.ts`) — in-memory SQLite database via sql.js (pure JS/WASM). Single backing store for runs, messages, and memory entries. Pure storage — no EventEmitter.
- **State Machine** (`server/src/state/machine.ts`) — manages step lifecycle: `pending` -> `coding` -> `reviewing` -> `complete` / `escalated`. A read-only review step that never submits a code result can be closed directly via `markReviewed` (`team_advance` action `mark_reviewed`), which moves `coding`/`reviewing` -> `complete` with a synthetic `done` result so it doesn't appear stuck. Enforces dependency ordering, file conflict detection, and stuck detection. There is no WIP cap — any number of independent steps may be active at once. Backed by Database.
- **Message Bus** (`server/src/bus/message-bus.ts`) — append-only message log with EventEmitter, 10K cap per run. Backed by Database.
- **Memory Store** (`server/src/memory/store.ts`) — key-value store in 5 namespaces (decisions, context, learnings, reviews, reflections). Extends EventEmitter, emits `entry_change` on writes. Backed by Database.
- **Tool Registry** (`server/src/tools/registry.ts`) — dispatches MCP tool calls to handlers
- **Dashboard** (`server/src/dashboard/`) — Express + WebSocket server broadcasting state and message events to a Preact + Signals client
- **Persistence** (`server/src/state/persistence.ts`) — file-based persistence in `.team/` directory (disk I/O layer, orthogonal to in-memory Database)

## Key Files

```
agents/            Agent definitions (planner, plan-critic, coder, reviewer, researcher, documentation)
commands/begin.md  Coordinator command (the /begin entry point)
skills/            User-invocable skills (status, memory, resume, plan, research, review)
server/src/
  index.ts         MCP server setup, tool registration, Database wiring
  types.ts         All TypeScript types (StepState, RunState, Message, MemoryEntry, DashboardEvent)
  db/              Database (sql.js in-memory SQLite)
  state/           StateMachine + Persistence
  bus/             MessageBus
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
npx tsc --noEmit     # type check
npx tsup             # build (ESM output to dist/)
npx vitest run       # run tests (309 tests across 17 files)
npx vitest           # watch mode
npm run knip         # find unused files, exports, and dependencies
```

The commands above are for local development. When installed as a plugin, the server **builds itself on launch** — see "Self-building MCP server" below.

## Development Patterns

### Dashboard data paths differ from MCP tool paths
The `team_status` MCP tool handler enriches step data with computed fields (e.g., `blockingReasons`). The dashboard receives raw `RunState` via WebSocket `state_update` events and `GET /api/runs`. If you add a computed field to the tool response, the dashboard won't see it unless you also compute it client-side or add it to the broadcast event.

### EventEmitter pattern for cross-component communication
StateMachine, MessageBus, and MemoryStore all extend EventEmitter. The dashboard server listens for events and broadcasts to WebSocket clients. When adding new observable state, follow this pattern: emit from the store -> listen in dashboard server -> broadcast to clients.

### Dashboard uses Preact with Signals
The dashboard client is built with Preact and `@preact/signals` for reactive state management. Source lives in `server/src/dashboard/client/` with components organized by panel (header, steps, activity, status). State is managed via module-level signals in `state/store.ts`. The client is bundled by esbuild (invoked from tsup's `onSuccess` hook) into `dist/dashboard/public/app.js`. JSX auto-escaping handles XSS prevention. Styles live in `server/src/dashboard/public/style.css`; components reference stable CSS class names, so the stylesheet can be restyled without touching component markup (and tests that assert on class names stay green).

### Run navigation is a tab bar, not a `<select>`
Run switching is handled by `RunTabs.tsx` (`components/header/`) — an always-visible, horizontally-scrollable row of run tabs rendered between `<Header />` and `<main>` in `app.tsx`. Each tab derives its active state reactively from the `currentRun` signal and calls `selectRun()` on click; the active tab is auto-scrolled into view via a guarded `scrollIntoView` (jsdom lacks it, so the call is feature-detected for tests). This replaced an earlier header `<select>` (`RunSelector`) that (a) hid itself whenever there was ≤1 run and (b) used the controlled-`<select>` anti-pattern of setting `selected` on `<option>` instead of `value` on the `<select>`, which desynced after Signals-driven re-renders. When you need a controlled selection in Preact, prefer deriving state from a signal and binding `value` on the element — don't drive it through per-option `selected`.

### Subagent MCP tool inheritance
Subagents dispatched via the Agent tool inherit all MCP tools from the parent session by default. The plugin's `.mcp.json` makes the `software-development-team` MCP server available in the session, and subagents can call its tools directly. Each agent's `tools:` frontmatter acts as an allowlist, scoping which MCP tools that agent can access. Note: plugin agents cannot use the `mcpServers` frontmatter field (silently ignored for security), but this is irrelevant since the server is already session-level.

### MCP tool names include a plugin prefix

When loaded via the plugin system, MCP tool names are prefixed with `plugin_<plugin-name>_`. The full tool name pattern is `mcp__plugin_software-development-team_software-development-team__team_X`. Agent definitions, skills, and the coordinator command must all use this full name — the shorter `mcp__software-development-team__team_X` form does not exist at runtime.

### Dual-host: also runs in OpenAI Codex CLI

A parallel Codex distribution lives in the repo-root `codex/` directory (`codex/agents/*.toml`, `codex/skills/<name>/SKILL.md`, `codex/install.sh`). It is **additive** — it reuses this plugin's `server/` unchanged via absolute paths and does not touch the Claude Code plugin. Three host-specific differences matter when editing shared behavior:

- **Tool prefix differs per host.** Claude Code (plugin): `mcp__plugin_software-development-team_software-development-team__team_X`. Codex: `mcp__software-development-team__team_X` (server name only — Codex does not add a `plugin_…` prefix). The `codex/` files use the shorter form throughout.
- **Dispatch model differs per host.** Claude Code dispatches subagents via the built-in Agent tool with `subagent_type`. Codex spawns subagents on the coordinator's request (no Agent tool); the coordinator passes the full per-step context in the spawn request, and the static role lives in the agent TOML.
- **Entry points differ per host.** Claude Code uses `commands/begin.md` + `skills/*.md` (with `$ARGUMENTS` templating). Codex uses **skills** (`codex/skills/<name>/SKILL.md`, `name` + `description` frontmatter only, no `$ARGUMENTS` — the user's request arrives as context, and the `description` drives `/skills` selection and implicit triggering).

When changing coordinator logic or an agent's instructions, update **both** the `plugins/software-development-team/` source of truth and its `codex/` counterpart so the two hosts stay in sync. The `server/` is shared, so server changes apply to both automatically.

### Coordinator message relay for dashboard visibility

The coordinator posts messages on behalf of agents (`team_send_message` with the correct `from` field) at each lifecycle point to keep the dashboard activity feed populated. This is for observability only — agents call `team_submit_result` directly to submit their work.

### Timer cleanup
When using `setInterval` for live timers in the dashboard, store the interval ID in a module-level variable and clean up on run change and `beforeunload`.

### Agent definitions follow a standard template
Agent files use YAML frontmatter (`name`, `description`, `tools`, `color`; `model` is optional) followed by markdown sections: Role, Tool Names, Process, File Ownership, Verification, On Revision, Self-Review Checklist, Reflection, Submitting Results, Debug Logging, Writing to Memory. New agents should follow this structure. Agents intentionally omit `model` so each inherits the user's active session model rather than pinning a tier; add an explicit `model:` only when an agent genuinely needs a fixed model.

### Read-only / critique-only agents use a trimmed template

Agents that do not touch code and do not submit step results (e.g., `plan-critic`) omit the Submitting Results, File Ownership, and Verification sections. They add instead: a **Dispatch Input** section (documents the input contract callers must pass), an output-format section (structured sections defining what the agent returns), and a **What NOT to Do** guardrail block. Their `tools` frontmatter excludes `team_submit_result` and they write only to the `reflections` namespace.

### Different agents use different MCP tool subsets
Not all agents get all 4 MCP tools. Planner gets 3 (no `submit_result`). All other agents get all 4 tools. Match the tool set to the agent's actual responsibilities.

### Optional GitNexus code-intelligence integration

Each agent is also granted a role-scoped subset of the [GitNexus](https://github.com/abhigyanpatwari/GitNexus) code knowledge-graph MCP tools (`mcp__gitnexus__*`) and carries a `## Code Intelligence (GitNexus — optional)` prompt section telling it when to use them:

| Agent          | GitNexus tools                                  |
| -------------- | ----------------------------------------------- |
| planner        | `query`, `context`, `route_map`, `impact`, `explain` |
| plan-critic    | `impact`, `context`                             |
| coder          | `context`, `impact`, `trace`, `explain`         |
| reviewer       | `detect_changes`, `impact`, `api_impact`, `context` |
| researcher     | `query`, `explain`, `context`                   |
| documentation  | `query`, `route_map`                            |

GitNexus is a separate, session-level MCP server (installed via its own `gitnexus setup`), so its tools use the `mcp__gitnexus__` prefix in **both** hosts — there is no `plugin_…` prefix even in the Claude Code plugin. In the Claude `.md` agents the tools are added to the `tools:` allowlist; in the Codex `.toml` agents no allowlist change is needed (Codex agents inherit all session MCP tools).

**The integration is optional and must stay that way.** Every GitNexus prompt section uses conditional-fallback wording ("if these tools are available, prefer them; otherwise fall back to Glob/Grep/Read; never block on GitNexus"). A listed-but-absent MCP tool is simply unavailable rather than an error, so the team behaves identically when GitNexus is not installed. Do not add a `gitnexus analyze` step to the SessionStart hook or otherwise couple plugin startup to GitNexus being present — indexing is GitNexus's own responsibility. When adding the GitNexus section to a new agent, place it right after the Tool Names section and mirror it into the agent's `codex/` counterpart.

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

### Git worktree workflow
When worktree mode is active, each step runs in `.worktrees/step-{N}` on branch `team/{runId}/step-{N}`. The coordinator creates the worktree before dispatching the coder, includes the worktree path in the dispatch prompt, and merges the branch back (`--no-ff`) after review approval. The coder must commit all changes before submitting. The reviewer reviews and runs verification in the worktree directory. Merge conflicts escalate to the user. After merge, the coordinator removes the worktree and deletes the branch.

### Use sql.js, not better-sqlite3
better-sqlite3 requires native C++ compilation and is incompatible with Node v24+ (needs C++20). sql.js is a pure JS/WASM SQLite that works everywhere with no native dependencies. The Database class uses a static `Database.create()` factory method for async sql.js initialization.

### Skills are standalone slash commands

Skills in `skills/` are user-invocable slash commands that provide focused workflows without the full team orchestration. They follow the same frontmatter format as commands (`description`, `argument-hint`). There are two patterns:

- **Utility skills** (`status`, `memory`, `resume`) — call MCP tools directly to query or manage state
- **Agent-dispatch skills** (`plan`, `research`, `review`) — dispatch a single subagent via the Agent tool for focused work

Agent-dispatch skills that run outside a team run (no `runId`) must explicitly tell the dispatched agent NOT to call team MCP tools (`team_submit_result`, `team_memory_write`, `team_send_message`). The `plan` skill is an exception — it includes MCP tool mappings because the planner writes to memory.

### Memory keys are run-scoped to prevent cross-run overwrites

Reflection and review memory keys are prefixed with the first 8 characters of the run ID (e.g., `a1b2c3d4-step-1-reflection` instead of `step-1-reflection`). This prevents run N+1 from silently overwriting run N's entries, since the DB uses `PRIMARY KEY (namespace, key)` with upsert semantics. The coordinator includes the 8-char prefix in every agent dispatch prompt. Durable entries (compacted summaries, promoted learnings) use descriptive keys without a run prefix.

### Post-run promotion and compaction

After a run completes, the coordinator promotes generalizable reflections and review patterns into the `learnings` namespace with durable, descriptive keys. If the `reflections` namespace exceeds 30 entries, old entries (not from the current run) are compacted into 2-4 thematic summaries and the originals are deleted via `team_memory_delete`.

### team_memory_delete tool

The `team_memory_delete` MCP tool deletes a memory entry by namespace and key, both from the in-memory SQLite DB and from disk (`.team/memory/{namespace}/{key}.json`). Used by the coordinator during post-run compaction to clean up old reflection entries after summarizing them.

### team_memory_read search ignores namespace filter

The `handleTeamMemoryRead` handler checks `namespace` before `search`. When both are provided, `search` is ignored — it returns all entries in that namespace instead. To search, call with `search` only (no `namespace`). Results include a `namespace` field for client-side grouping.

### File-ownership checks in non-worktree runs

In non-worktree runs, prior steps' uncommitted edits sit in the shared working tree. Reviewers must scope the file-ownership check to the current step's authorized files only:

```bash
git diff HEAD -- <authorized-file-1> <authorized-file-2>
```

Never use bare `git status` or whole-repo `git diff HEAD` — those will include prior steps' edits and produce false-positive rejections. Coders re-dispatched on a false-positive must NOT revert other steps' work; re-submit `done` with a scoped diff as confirmation.

### Inserting content into Markdown ordered lists

When adding new content between items in an existing ordered list, do NOT insert a `### Heading` between items — this breaks the list context and triggers MD029 linter warnings. Instead, nest the new content as indented bold sub-items under the parent item (e.g., **3a.** / **3b.**), keeping the top-level numbering unbroken. Similarly, when widening a Markdown table cell, also widen the header and separator rows to match the widest cell.

### Self-building MCP server (build on launch)

Claude Code has no plugin install/postinstall hook, and `${CLAUDE_PLUGIN_ROOT}` is read-only and reset on every update — so build output cannot live there. Instead the server builds itself at launch into the writable, persistent `${CLAUDE_PLUGIN_DATA}`:

- **`.mcp.json`** launches `sh ${CLAUDE_PLUGIN_ROOT}/server/launch.sh <SRC_DIR> <DATA_DIR>` instead of `node dist/index.js`.
- **`server/launch.sh`** calls `scripts/ensure-build.sh` (which prints the built entry path on stdout, all logs on stderr) then `exec node "$ENTRY"`. Because the build runs *inside* the launch command, the server is always built before `node` runs — independent of hook/MCP startup ordering, which the docs do not guarantee.
- **`server/scripts/ensure-build.sh`** is idempotent: it syncs sources into `${CLAUDE_PLUGIN_DATA}/server`, runs `npm ci` (only when the manifest changed) and `tsup`, and skips entirely when a content signature of `src/` + configs matches the last build (`.build-stamp`). A `mkdir`-based lock (`.build.lock`) serializes concurrent builds.
- When `DATA_DIR` is empty or equals `SRC_DIR` (local dev), `ensure-build.sh` builds in place instead of out-of-tree.

First launch after install/update runs a full `npm ci` + build (~30–60s); bump `MCP_TIMEOUT` if the MCP client times out. `dist/` and `node_modules/` stay gitignored — nothing built is committed.
