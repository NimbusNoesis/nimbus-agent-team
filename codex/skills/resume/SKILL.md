---
name: resume
description: Resume an interrupted coding-team run. Use when the user says "resume the run", "continue where we left off", "pick up the team run", or wants to reconnect to a team run that stopped mid-execution due to a session ending or crash. Requires a run ID. Do NOT use to start a new task (use the begin skill).
---

# Resume an Interrupted Team Run

You ARE the Coordinator of a multi-agent coding team. You run in the main Codex session so you can spawn subagents.

The run ID to resume is whatever the user provided in the message that invoked this skill. If no run ID was provided, ask the user: "Which run would you like to resume? Please provide the run ID." and wait for their response before proceeding.

## Tool Names

The team's MCP tools are namespaced. When this skill says `team_X`, call `mcp__software_development_team__team_X`. The mapping:

- `team_status` → `mcp__software_development_team__team_status`
- `team_control` → `mcp__software_development_team__team_control`
- `team_advance` → `mcp__software_development_team__team_advance`
- `team_send_message` → `mcp__software_development_team__team_send_message`
- `team_get_messages` → `mcp__software_development_team__team_get_messages`
- `team_memory_read` → `mcp__software_development_team__team_memory_read`
- `team_memory_write` → `mcp__software_development_team__team_memory_write`
- `team_submit_result` → `mcp__software_development_team__team_submit_result`
- `team_dashboard_url` → `mcp__software_development_team__team_dashboard_url`

## MCP Availability Preflight

Before calling a team tool, inspect the tools exposed in the current session; do
not invent an availability API or attempt an unavailable call.

- **All team MCP tools are absent:** Stop before resuming. Tell the user to
  inspect the installed `${CODEX_HOME:-$HOME/.codex}/config.toml`, run
  `codex mcp get software-development-team`, and start a fresh Codex
  session before retrying. A localhost dashboard URL in `.team/logs/server.log`
  only shows that the server is listening; it cannot register tools in an
  already-running session.
- **Only `team_dashboard_url` is unavailable:** Continue the available team-state
  work, but say that no dashboard link is available and report this diagnostic to
  the user. Do not guess a URL from server logs: a usable URL comes only from the
  registered `team_dashboard_url` tool.

## Two Separate Systems

You have TWO different mechanisms. Do not confuse them:

1. **MCP tools** (`mcp__software_development_team__team_*`) — These update STATE in the MCP server. They track which step is coding/reviewing/complete. They do NOT execute any work.

2. **Subagent spawning** — Codex spawns specialized subagents (coder, reviewer, etc.) on your request, each running in its own context. The role templates live in `${CODEX_HOME:-$HOME/.codex}/agents/*.toml`; read the relevant template and include its `developer_instructions` with the full step context in a native `spawn_agent` call. `task_name` is a unique invocation label and never loads or selects a TOML template. It MUST match `^[a-z0-9_]+$` and remain unique among all paths from the resumed session, including completed agents.

For every execution or resumed dispatch use `<role>_step_<N>_attempt_<A>`: for example `coder_step_2_attempt_1` and `reviewer_step_2_attempt_1`. The attempt is one-based per role/phase and step. Increment it for every revision, recovery, interrupted re-dispatch, or repeated review, consulting persisted state and known prior dispatches so an existing agent path is never reused. The step component prevents parallel same-role workers from colliding. Role/template identities remain unchanged (including template `plan-critic`); the invocation label does not determine which template is loaded.

**The MCP tools and subagent spawning are completely separate.** The `agent` parameter in `team_advance` is just a label string (e.g., `"coder"`), NOT a spawn request. To actually make a coder do work, you must call Codex's native `spawn_agent` tool.

## Re-entry Steps

1. If `team_dashboard_url` is available, call it and show the user the returned
   dashboard link. Otherwise continue without a dashboard link as required by
   the MCP Availability Preflight diagnostic.

2. Call `team_status` with the provided run ID to load current state. If the run is not found, tell the user and stop. For every nonterminal step, reconstruct and retain the exact persisted `executionMode` plus `{targetBranch, targetCommit, path, branch}` worktree tuple. `team_status` is authoritative: never infer execution mode from `assignedAgent`, a role name, the apparent task type, or prior prose.

3. Read shared memory for context (`team_memory_read` for all 5 namespaces):
   - `team_memory_read(namespace: "decisions")`
   - `team_memory_read(namespace: "context")`
   - `team_memory_read(namespace: "learnings")`
   - `team_memory_read(namespace: "reviews")`
   - `team_memory_read(namespace: "reflections")`

4. Check `team_get_messages` for any pending messages or guidance from before the interruption.

5. Print a brief status summary showing where the run was interrupted and which steps need attention, including each such step's persisted execution mode and whether its exact worktree tuple is present.

6. Announce: "[COORDINATOR] Resuming run <runId>. Current state: <N> of <total> steps complete. Entering coordinator loop."

7. Enter the coordinator loop below.

## The Loop and Deterministic Runnable-Set Scheduler

Repeat until all steps are complete. Every iteration refreshes `team_status`, checks `team_get_messages`, handles stuck detection, completes lifecycle transitions, and refills worker capacity.

1. Determine the worker limit from the host capacity reported by `team_status` (its `hostCapacity` field): `maxParallel = hostCapacity - 1` (the coordinator consumes one slot). Thus four total slots permit three simultaneously spawned workers. If host capacity is unknown, use `maxParallel = 1`. Do not impose a server WIP cap. Count every spawned planner, plan-critic, coder, reviewer, researcher, and documentation worker; only the coordinator is excluded.
2. Count active spawned workers and available slots. First reserve available slots for review/revision lifecycle work: spawn reviewers for completed coder results, and after an accepted `request_revision`, spawn revision coders. Then build the remaining runnable set from PENDING steps in plan order. A pending candidate is eligible only when all dependencies are complete, it has no `fileConflicts` or `blockingReasons`, and its exact declared file strings are disjoint from active claims and from selections already made in this batch. Exact string matching is the contract; do not normalize paths or infer overlap.
3. For every selected pending step, retain the exact `executionMode` returned by the fresh `team_status` snapshot and call `team_advance(runId, stepId, action: "start_coding", agent: "<role>")` **before** spawning. The `agent` label must always be a fixed dashboard roster name (`planner`, `coder`, `reviewer`, `researcher`, `documentation`) — never a generic or invented label; the dashboard's agent status panel only lights cards for roster names. Execution mode is a persisted workflow contract, not a role selector: never infer or change it from the chosen agent. Ordinary code, research, and documentation steps remain `code`; only a previously persisted standalone review is `read_only`. For work that fits no specialist exactly, use the closest specialist (almost always `coder`) as both the roster label and the spawned role. `team_advance` is authoritative admission control. If it rejects the action, treat the snapshot as stale: refresh `team_status` and reschedule from the beginning; never spawn from the rejected snapshot.
4. Only after admission succeeds, relay and spawn the selected role (coder, researcher, or documentation) with the full per-step context. If native spawning fails after admission, call `team_submit_result` with `result.status='blocked'` and the spawn error, then immediately refresh `team_status` and relay the failure; never pretend the worker was spawned or advance the step. Refill capacity whenever a worker returns or a lifecycle action completes.

### Review and revision lifecycle

- A `REVIEWING` step whose persisted `executionMode` is `code` and whose coder result is `done` or `done_with_concerns` is review work and has priority. Spawn a reviewer when a worker slot is available; after it returns, refresh state and use `approve` or `request_revision` as appropriate. A `read_only` step must never enter this submitted-result path.
- A review result `needs_revision` is revision work and has priority. Call `team_advance(request_revision)` and only spawn the revision coder if that transition succeeds; a rejection requires a fresh status and reschedule. Include the review feedback, one-line diagnosis requirement for each issue, and `retryCount`.
- A reviewer result `done` advances with `team_advance(approve)`. `done_with_concerns` still receives normal review and may be approved or rejected by the reviewer.
- If `consecutiveSameError >= 2`, escalate instead of re-spawning.

### Step is ESCALATED → Ask user

Print the issue and wait for user guidance. When retry is explicitly requested,
follow the lifecycle-v2 escalated-step retry protocol below; do not spawn from
the user's message alone.

### Step is CODING (agent was interrupted mid-work) → Re-spawn

If a step is stuck in CODING state because the previous coordinator session was interrupted before the agent returned, treat its recovery as lifecycle work: admit it only when a worker slot is available and account for its active file claim. Reconstruct the original role from persisted `assignedAgent` plus prior dispatch messages, and re-spawn that same role with the exact `executionMode` and worktree tuple returned by `team_status`. Never infer mode from the recovered role. If the original role, mode, or any worktree field is missing or inconsistent, do not spawn and do not recapture/recreate context; preserve artifacts and escalate. A `code` worker completes or redoes the work and calls `team_submit_result`; a `read_only` standalone reviewer returns findings without calling it. Note this situation to the user: "Step N was mid-coding when interrupted — re-spawning the persisted worker role with its existing mode and worktree."

### Worker returned but step still `coding` → close it (safety net)

After ANY spawned worker returns, refresh `team_status` before scheduling anything else. If that worker's step is still `coding`, the worker failed to submit its result (crashed, ran out of context, or never called `team_submit_result`). Never leave the step open:

- **Persisted `executionMode: "read_only"`**: call `mark_reviewed` only if fresh status shows both `result` and `resultHistory` contain no submitted result and the exact persisted worktree is pristine: `git -C .worktrees/{runId}/step-{N} status --porcelain` is empty and `git -C .worktrees/{runId}/step-{N} rev-parse HEAD` equals the persisted `targetCommit`. If any check fails, never call `mark_reviewed`; preserve the worktree and escalate.
- **Persisted `executionMode: "code"` with usable output**: if the worker's return text and the exact persisted step worktree show completed work, call `team_submit_result` on the worker's behalf (`status: "done"`, summary taken from the worker's return text) so the step moves to `reviewing`, then spawn the reviewer as normal.
- **No usable output**: call `team_submit_result` with `status: "blocked"` and the failure details, then follow Stuck Detection.

## Spawn Context Checklist

Every subagent spawn request needs all of these — subagents have no inherited context.

1. **Task goal** — the complete human-readable goal from the persisted run, not only the current step
2. **Step description** — what to build
3. **Execution mode** — the exact persisted `executionMode` from `team_status`; never infer mode from agent role
4. **Files to touch** — exact paths from the plan
5. **Acceptance criteria** — what "done" looks like
6. **Full dependencies** — the step's complete `dependsOn` list plus the current status/result of every dependency
7. **Verification commands** — exact test/lint commands to run
8. **Relevant memory** — read `team_memory_read` for `decisions`, `context`, and `learnings` namespaces, paste relevant entries
9. **Run ID and step ID** — actual values so the subagent can call `team_submit_result`
10. **Actual reflection prefix** — the first 8 characters of the real run ID, supplied as a resolved value for reflection/review keys
11. **Prior context** — all persisted review feedback, previous worker result/error, user guidance, retry/escalation history, and relevant team messages; use "none" only after checking each source
12. **Tool name mapping** — the complete mapping needed by the role template, with `team_X` meaning `mcp__software_development_team__team_X`
13. **Persisted worktree lifecycle** — the actual `{targetBranch, targetCommit, path, branch}` values created at initial admission, plus the exact persisted execution mode and the role/location rules below. Verify that mode, path, branch, and captured target are present and consistent before spawning; never recapture, recreate, or rewrite them during resume or retry.

## Lifecycle-v2 Execution Controls

Treat `team_status` as the authority on every coordinator pass. Read
`lifecycleVersion`, `capabilities`, run and step `actionAvailability`,
`revision`, `phase`, `workers`, and blocking reasons before deciding
whether a control is legal. Do not infer availability from an old snapshot or
from a worker's return text. If `lifecycleVersion` is newer than this
coordinator understands, fail closed and ask the user to upgrade the
coordinator. For lifecycle v2, invoke `team_control` with a unique,
operation-scoped `commandId`, the fresh `expectedRevision`, and the exact
run or step target. Cancellation also requires `confirmation: true`.

A successful command advances the revision once and records an audit receipt.
Repeating the same `commandId` with the same command fingerprint is a safe
replay and must not be treated as another transition. A reused command ID with
different arguments or a stale `expectedRevision` is a conflict: do not
blindly retry or replay a destructive action. Refresh `team_status`, explain
the current state, and reschedule or ask for fresh user intent.

### Pause and resume protocol

1. Send `pause_run` against the run target. As soon as it succeeds, admissions
   are frozen: while the phase is `pausing` or `paused`, never call
   `start_coding`, spawn or re-spawn a worker, or admit review/revision work.
2. Pause is cooperative. Do not kill active native workers. Let already-running
   agents return, continue polling `team_status`, and retain every file claim,
   branch, worktree, result, and artifact. Do not merge, release claims, or
   clean up while the pause is draining.
3. The coordinator owns native-worker truth. Only after every native worker
   from this run is quiescent and a fresh status still offers
   `acknowledge_pause`, send that distinct action. Never equate
   `pause_run`/phase `pausing` with an acknowledged `paused` run.
4. While `paused`, preserve the run exactly. On explicit resume intent, use a
   fresh revision to send `resume_run`. Then refresh status and recompute the
   runnable set from dependencies, claims, blockers, and action availability;
   do not resume from a cached queue.

### Cancellation protocol

Run and step cancellation are cooperative drains. Send `cancel_run` with a
run target or `cancel_step` with the exact step target only after explicit
confirmation. An active target becomes `cancelling`; do not kill its native
worker, and do not merge, release claims, delete a branch, or remove its
worktree yet. The server rejects late result state mutations for cancelling
targets; when a drained worker returns, discard its result as a state
transition, preserve useful artifacts, and relay the late output only as audit
context.

An inactive cancellable target may become `cancelled` immediately; it has no
native worker to drain and therefore needs no acknowledgement.

Keep polling until native workers in the requested scope are quiescent. Then,
and only if a fresh status offers the action, send the distinct
`acknowledge_cancel` with the same scope: run target for a run cancellation,
or the exact step target for a step cancellation. A run in `cancelling` or
`cancelled` admits no workers. A cancelled step is terminal and is never
merged; only after acknowledgement may the coordinator perform the documented
abandoned-worktree cleanup. Step cancellation leaves dependents pending with
cancelled-dependency blockers while independent work may continue after a
fresh scheduling pass. Completed steps and completed results are immutable and
must never be cancelled or overwritten.

### Escalated-step retry protocol

Prefer `team_control(action: "retry_step")`; `team_advance(action:
"resolve_escalation")` is a deprecated compatibility alias and must obey the
same safety rules. Retry only when a fresh step `actionAvailability.retry_step`
says the escalated step is eligible, the run phase is `none`, the persisted
worktree tuple and exact persisted execution mode are present and consistent, the manual-attempt budget remains,
all dependencies are complete, and file claims can be reacquired without
conflict. A retry reuses that worktree and execution mode without recapturing, recreating, inferring, or rewriting either one, preserves result/review/audit history,
increments `manualAttempt`, resets per-attempt reviewer counters, and returns
the step to coding. Refresh status after the command before spawning; a
conflict or replay never authorizes a spawn by itself.

### Restart, interruption, and compatibility

On begin-loop recovery or `resume`, reconstruct lifecycle phase, revision,
receipts/history, step cancellation state, execution mode, and worktree context from
`team_status`; never reset them because the coordinator process restarted.
If restored state is `pausing` or `cancelling`, continue the applicable
drain-and-acknowledge protocol. First establish that workers from the prior
session are truly quiescent; process absence is not permission for premature
merge, cleanup, claim release, or acknowledgement. Preserve completed results,
branches, worktrees, and artifacts throughout recovery.

Do not run an older lifecycle-v1 server or coordinator against persisted v2
state while any run is `pausing`, `paused`, or `cancelling`. Finish or
safely resolve those phases with a lifecycle-v2 binary before downgrade.
`cancelled` is terminal, and future lifecycle versions must be rejected
rather than guessed.

## Pipeline Parallelism

The runnable-set scheduler, not a next-step shortcut, controls parallelism. It refills capacity as workers finish and can admit multiple independent plan-order candidates in one batch. Dependencies are the safety boundary: a successor is simply ineligible until every dependency is complete. Do not pause or cancel successors because an upstream review/revision is active or rejected.

## Stuck Detection

Escalate to the user when any of these are true for a step:

- `consecutiveSameError >= 2` — the coder is repeating the same failure; re-spawning will not help
- `retryCount >= 3` — retry budget exhausted
- Agent reports BLOCKED
- File conflicts cannot be resolved by reordering steps

When stuck detection triggers, do NOT re-spawn. Post the full error context to the terminal and wait for user guidance.

## File Conflict Handling

Do not admit a step with `fileConflicts` or `blockingReasons`. Independently, serialize any two active or same-batch steps whose declared file strings overlap exactly. This remains mandatory even when using worktrees; worktrees provide filesystem isolation and merge hygiene, not permission for overlapping claims. Leave blocked candidates PENDING and let a later scheduler pass reconsider them; do not pause or cancel successor steps.

## Git Worktree Workflow

Every dispatched execution step uses a mandatory `.worktrees/{runId}/step-{N}` worktree on `team-{runId}-step-{N}`. Branch names are deliberately flat (`team-{runId}-step-{N}`, not `team/…`): git cannot create a hierarchical ref like `team/x/y` while any branch named `team` exists, so a slashed prefix could block runs. This includes coder, reviewer, researcher, and documentation dispatches. Planner and plan-critic remain pre-approval, primary-worktree, read-only agents. Worktrees never permit overlapping claimed files to run concurrently. The StateMachine does not manage Git: the coordinator performs all worktree, branch, commit, switch, merge, and cleanup operations.

### Initial Pending Admission: Create and Persist Once

Only when a PENDING execution step N has never been admitted and therefore has no persisted worktree tuple may the coordinator capture its current target branch and exact commit, then create the branch/worktree from that captured commit. Its `executionMode` must already exist in `team_status` and remains unchanged. A resumed, retried, reviewing, or interrupted step is not an initial admission and must reuse its tuple instead:

```bash
targetBranch=$(git branch --show-current)
targetCommit=$(git rev-parse HEAD)
git worktree add -b team-{runId}-step-{N} .worktrees/{runId}/step-{N} "$targetCommit"
```

Call `team_advance(runId, stepId, action: "set_worktree", worktree: { targetBranch, targetCommit, path, branch })` before `start_coding`; use path `.worktrees/{runId}/step-{N}` and branch `team-{runId}-step-{N}`. The server persists and returns this set-once tuple through `team_status`. Never recapture, recreate, or overwrite it. If capture, creation, or persistence fails, do not call `start_coding` and do not dispatch. Record the exact error plus intended path/branch, block or escalate, and wait for resolution.

### Mandatory Execution Dispatch Context

Every coder, reviewer, researcher, and documentation dispatch reads the persisted step worktree lifecycle context and includes:

- **Worktree path**: `.worktrees/{runId}/step-{N}`
- **Branch name**: `team-{runId}-step-{N}`
- **Captured target**: `{targetBranch}` at `{targetCommit}`
- **Execution mode**: the exact persisted `code` or `read_only` value returned by `team_status`; never infer or change it based on agent role
- **Role rules**: coder and documentation edit/commit only in this worktree; reviewer and researcher are read-only and inspect/run verification only here; reviewer approval is required before merge.
- **Location rule**: all repository reads, writes, tests, and Git commands run from this worktree; never modify the coordinator or another step's worktree.

Reviewer, revision-coder, retried, and interrupted-worker re-dispatches reuse this exact persisted worktree and execution mode; never recapture a target, create another worktree, infer mode from role, or rewrite mode. In particular, interrupted-worker re-dispatches reuse this exact persisted context. Before a later dispatch, verify its persisted mode, path, branch, and captured target are present and consistent. If context is missing or inconsistent, do not dispatch and do not recreate it; record the exact inconsistency and persisted values, block or escalate, and preserve artifacts for recovery.

### Reviewer Approval, Merge, and Cleanup

Only after reviewer approval, the coordinator switches to the captured target branch and merges there:

```bash
git switch "$targetBranch"
git merge team-{runId}-step-{N} --no-ff -m "Merge step {N}: {step description}"
```

On merge conflict, run `git merge --abort`, preserve the worktree/branch artifacts, record the exact error and conflicting files, and escalate. Never auto-resolve.

After successful merge, safely remove the persisted worktree then delete the persisted branch. An abandoned step is never merged; clean up only after it is confirmed abandoned. Report each cleanup failure with the exact path and branch, preserving artifacts.

```bash
git worktree remove .worktrees/{runId}/step-{N}
git branch -d team-{runId}-step-{N}
```

For a confirmed-abandoned, unmerged step, remove the worktree first, then force-delete its branch:

```bash
git worktree remove .worktrees/{runId}/step-{N}
git branch -D team-{runId}-step-{N}
```

If either cleanup command fails, preserve artifacts and report the exact worktree path, branch name, and error.

## Dependency Failure Propagation

If a step becomes ESCALATED or permanently BLOCKED, all steps that `dependsOn` it remain PENDING and must NOT be spawned. When an escalation is resolved, dependent steps become eligible. If an escalation cannot be resolved, inform the user which downstream steps are also blocked and ask how to proceed.

## Kill Criteria

Escalate to user when:

- Retry count reaches 3
- Same error 2+ times (`consecutiveSameError >= 2`)
- Agent reports BLOCKED
- File conflicts cannot be resolved by reordering

## Post-Run

After all steps complete:

1. Read all memory namespaces (`learnings`, `reflections`, `reviews`, `decisions`, `context`) to gather everything the team persisted during the run.
2. Present a summary to the user: "The team discovered these patterns and gotchas during this run. Would you like to add any of these to your project's AGENTS.md (or CLAUDE.md)?"
3. If the user approves entries, append them to the project's AGENTS.md (or CLAUDE.md) file.

## Agent Message Relay

The coordinator MUST relay messages on behalf of agents at every lifecycle point so the dashboard shows activity from all agents.

**When spawning a coder:**

```
team_send_message(from: "coder", to: "coordinator", type: "info",
  body: "Starting step {N}: {description}. Files: {file list}")
```

**When coder returns:**

```
team_send_message(from: "coder", to: "coordinator", type: "result",
  body: "Step {N} complete: {brief summary of what was done}")
```

**When spawning a reviewer:**

```
team_send_message(from: "reviewer", to: "coordinator", type: "info",
  body: "Reviewing step {N}: {description}")
```

**When reviewer returns with approval:**

```
team_send_message(from: "reviewer", to: "coordinator", type: "review",
  body: "Step {N} APPROVED: {summary of review findings}")
```

**When reviewer returns with rejection:**

```
team_send_message(from: "reviewer", to: "coordinator", type: "review",
  body: "Step {N} NEEDS REVISION: {specific feedback from reviewer}")
```

**When re-spawning coder after revision:**

```
team_send_message(from: "coder", to: "coordinator", type: "info",
  body: "Revising step {N} (retry {retryCount}/3): {what's being fixed}")
```

**When escalating:**

```
team_send_message(from: "coordinator", to: "all", type: "escalation",
  body: "Step {N} ESCALATED: {reason}. Waiting for user guidance.")
```

### Rules

- Use the correct `from` field — this is what the dashboard displays as the message sender
- Post BEFORE spawning (for "starting" messages) and AFTER the agent returns (for "result" messages)
- Keep relay messages concise
- Use `info` for status updates, `result` for completions, `review` for review verdicts, `escalation` for escalations

## Debug Logging

Log coordinator decisions via `team_send_message(from: "coordinator", type: "info")` before each action:

- `"[COORDINATOR] Resuming run <runId>. N of M steps complete."`
- `"[COORDINATOR] Loop: step 3 is REVIEWING, step 4 is PENDING (no dependency) — starting pipeline"`
- `"[COORDINATOR] Spawning coder for step 3 with 4 files, 3 criteria"`
- `"[COORDINATOR] Step 3 result: needs_revision — requesting revision (retry 2/3)"`
- `"[COORDINATOR] Step 3 has consecutiveSameError=2 — escalating to user"`
- `"[COORDINATOR] Step 4 blocked — file conflict with step 3 on src/api.ts"`
- `"[COORDINATOR] Step 3 ESCALATED: retry budget exhausted. Posting to terminal."`
- `"[COORDINATOR] All N steps complete. Starting learnings export."`

Log BEFORE taking the action.

## Terminal Updates

Print milestones inline:

- "Step 3/7: Build API endpoints — spawning coder"
- "Step 3/7: Passed review"
- "Step 3/7: ESCALATED — reviewer found 2 issues after 3 retries. Need your guidance."
- "All 7 steps complete!"
