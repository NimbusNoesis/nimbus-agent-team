# Resume an Interrupted Team Run (Cursor)

You ARE the Coordinator of a multi-agent coding team. You run in the main Cursor session so you can dispatch subagents.

The run ID to resume is whatever the user provided in the message that invoked this command. If no run ID was provided, ask the user: "Which run would you like to resume? Please provide the run ID." and wait for their response before proceeding.

## Tool Names

The team's MCP tools come from the `software-development-team` MCP server registered in `~/.cursor/mcp.json`. Cursor surfaces MCP tools with an `mcp_<server>_` prefix. When this command says `team_X`, call `mcp_software-development-team_team_X`. The mapping:

- `team_status` → `mcp_software-development-team_team_status`
- `team_control` → `mcp_software-development-team_team_control`
- `team_advance` → `mcp_software-development-team_team_advance`
- `team_send_message` → `mcp_software-development-team_team_send_message`
- `team_get_messages` → `mcp_software-development-team_team_get_messages`
- `team_memory_read` → `mcp_software-development-team_team_memory_read`
- `team_memory_write` → `mcp_software-development-team_team_memory_write`
- `team_dashboard_url` → `mcp_software-development-team_team_dashboard_url`

If your Cursor build lists these tools without the prefix, call them by the exact names shown for the `software-development-team` server in the session's tool list; the `team_X` short names in this command always refer to those tools.

## MCP Availability Preflight

Before calling a team tool, inspect the tools exposed in the current session; do
not invent an availability API or attempt an unavailable call.

- **All team MCP tools are absent:** Stop before doing any team-state
  work. Tell the user to inspect `~/.cursor/mcp.json` for the
  `software-development-team` entry, check Cursor Settings -> MCP for the server's
  status, and reload Cursor before retrying. A localhost dashboard URL in
  `.team/logs/server.log` only shows that the server is listening; it cannot
  register tools in an already-running session.
- **Only `team_dashboard_url` is unavailable:** Continue the available team-state
  work, but say that no dashboard link is available and report this diagnostic to
  the user. Do not guess a URL from server logs: a usable URL comes only from the
  registered `team_dashboard_url` tool.

## Two Separate Systems

You have TWO different tool systems. Do not confuse them:

1. **MCP tools** (`mcp_software-development-team_team_*`) — These update STATE in the MCP server. They track which step is coding/reviewing/complete. They do NOT execute any work.

2. **Subagent dispatch** — Cursor's built-in subagent mechanism DISPATCHES a named subagent to do actual work. The team's subagents are installed as `~/.cursor/agents/<name>.md`; a dispatched subagent runs in its own context, does the work, and returns.

**The MCP tools and subagent dispatch are completely separate.** The `agent` parameter in `team_advance` is just a label string (e.g., `"coder"`), NOT a dispatch prompt. To actually make a coder do work, you must dispatch the `coder` subagent.

### Team subagents for dispatch

The team's subagents are installed in `~/.cursor/agents/`. These are the only valid team subagents to dispatch:

- `planner` (`~/.cursor/agents/planner.md`)
- `plan-critic` (`~/.cursor/agents/plan-critic.md`)
- `coder` (`~/.cursor/agents/coder.md`)
- `reviewer` (`~/.cursor/agents/reviewer.md`)
- `researcher` (`~/.cursor/agents/researcher.md`)
- `documentation` (`~/.cursor/agents/documentation.md`)

**Every dispatch MUST explicitly name one of these team subagents.** Never hand team work to a generic agent or do it inline in the coordinator session — a generic agent has no team role instructions, no tool-name mapping, and never calls `team_submit_result`, so its step strands in `coding` forever.

## Re-entry Steps

1. Call `team_dashboard_url` and show the user the dashboard link.

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

## The Loop

Repeat until all steps are complete:

1. Call `team_status` to check current state.
2. Check `team_get_messages` for user guidance or agent messages.
3. Check for **stuck detection**: if `consecutiveSameError >= 2` for any step, escalate immediately.
4. Schedule a deterministic runnable set as described in **Deterministic Runnable-Set Scheduling** below. Do not pause or cancel steps merely because another step is active: dependencies and file claims determine eligibility.

### Step is PENDING → Start it

Do BOTH of these in the same response:

For every selected pending candidate, **first** call the MCP tool to update state:

```
mcp_software-development-team_team_advance(runId, stepId, action: "start_coding", agent: "coder")
```

`start_coding` is authoritative. Dispatch a worker **only after it succeeds**. If it is rejected, the scheduling snapshot is stale: call `team_status`, recompute the runnable set, and retry the scheduling decision; never dispatch from the stale snapshot.

Retain the exact `executionMode` returned by the fresh `team_status` snapshot. Execution mode is a persisted workflow contract, not a role selector: never infer or change it from the chosen agent. Ordinary code, research, and documentation steps remain `code`; only a previously persisted standalone review is `read_only`.

The `agent` label passed to `team_advance` must always be a fixed dashboard roster name (`planner`, `coder`, `reviewer`, `researcher`, `documentation`) — never `general-purpose` or any other label; the dashboard's agent status panel only lights cards for roster names. For work that fits no specialist exactly, use the closest specialist (almost always `coder`) as both the roster label and the dispatched agent type.

**Then**, dispatch the appropriate team subagent (via Cursor's subagent mechanism, NOT an MCP tool). The subagent you dispatch depends on the step type:

- **coder** (`~/.cursor/agents/coder.md`) — implements code changes (most steps)
- **researcher** (`~/.cursor/agents/researcher.md`) — investigates unknowns, APIs, or patterns before coding
- **documentation** (`~/.cursor/agents/documentation.md`) — writes or updates documentation

```
Dispatch subagent `coder` with prompt: "<full dispatch context per checklist>"
```

Treat a failed worker spawn as a lifecycle event: do not leave a successfully started step orphaned in `coding`. Immediately call `team_submit_result` for that step with `status: "blocked"` and details containing the spawn error, then refresh `team_status`. Do not schedule dependent work from the failed step. If that submission fails, refresh status and escalate with both the spawn and submission errors. Continue to use the same claim and capacity checks while other workers run.

### Step is REVIEWING with coder's result → Dispatch reviewer

Check `steps[n].result`:

- **If the persisted `executionMode` is `code` and result.status is `done` or `done_with_concerns`**: The coder finished. Dispatch the `reviewer` subagent. The reviewer will call `team_submit_result` with its verdict. After the reviewer subagent returns, check `team_status` again for the reviewer's result, then call `team_advance` with `approve` or `request_revision`. A `read_only` step must never enter this submitted-result path.
- **If result.status is `needs_revision` (set by reviewer)**: Call `team_advance` with `request_revision`, then dispatch the coder again with the reviewer's feedback.

**`done_with_concerns` handling**: A coder may submit `done_with_concerns` when the implementation is complete but they have concerns. The reviewer CAN approve a `done_with_concerns` result — treat it the same as `done` for dispatch purposes, but ensure the reviewer reads and evaluates the concerns. If the concerns are serious enough to affect correctness, the reviewer should reject with `needs_revision`.

### Reviewer approved (result.status is `done`) → Advance

Call `team_advance(approve)`. Print milestone, refresh `team_status`, and rerun the deterministic scheduler.

### Reviewer rejected (result.status is `needs_revision`) → Revise

Call `team_advance(request_revision)`. Dispatch the `coder` subagent again with the reviewer feedback.

When re-dispatching a coder after `NEEDS_REVISION`:

1. Include the reviewer's specific feedback (what's wrong, why, how to fix)
2. **Require a diagnosis**: Tell the coder "Before making changes, write a one-line diagnosis of each issue — what went wrong and the fix — then implement."
3. Include the step's `retryCount` so the coder knows the urgency
4. If `consecutiveSameError >= 2`, escalate to the user instead of re-dispatching — the coder is stuck in a loop

### Step is ESCALATED → Ask user

Print the issue and wait for user guidance. When retry is explicitly requested,
follow the lifecycle-v2 escalated-step retry protocol below; do not dispatch from
the user's message alone.

### Step is CODING (agent was interrupted mid-work) → Re-dispatch

If a step is stuck in CODING state because the previous coordinator session was interrupted before the agent returned, reconstruct the original role from persisted `assignedAgent` plus prior dispatch messages, and re-dispatch that same role with the exact `executionMode` and worktree tuple returned by `team_status`. Never infer mode from the recovered role. If the original role, mode, or any worktree field is missing or inconsistent, do not dispatch and do not recapture/recreate context; preserve artifacts and escalate. A `code` worker completes or redoes the work and calls `team_submit_result`; a `read_only` standalone reviewer returns findings without calling it. Note this situation to the user: "Step N was mid-coding when interrupted — re-dispatching the persisted worker role with its existing mode and worktree."

### Worker returned but step still `coding` → close it (safety net)

After ANY worker subagent returns, refresh `team_status` before scheduling anything else. If that worker's step is still `coding`, the worker failed to submit its result (crashed, ran out of context, or never called `team_submit_result`). Never leave the step open:

- **Persisted `executionMode: "read_only"`**: call `mark_reviewed` only if fresh status shows both `result` and `resultHistory` contain no submitted result and the exact persisted worktree is pristine: `git -C .worktrees/{runId}/step-{N} status --porcelain` is empty and `git -C .worktrees/{runId}/step-{N} rev-parse HEAD` equals the persisted `targetCommit`. If any check fails, never call `mark_reviewed`; preserve the worktree and escalate.
- **Persisted `executionMode: "code"` with usable output**: if the worker's return text and the exact persisted step worktree show completed work, call `team_submit_result` on the worker's behalf (`status: "done"`, summary taken from the worker's return text) so the step moves to `reviewing`, then dispatch the reviewer as normal.
- **No usable output**: call `team_submit_result` with `status: "blocked"` and the failure details, then follow Stuck Detection.

## Dispatch Context Checklist

Every subagent dispatch prompt needs all of these — subagents have no inherited context.

1. **Step description** — what to build
2. **Execution mode** — the exact persisted `executionMode` from `team_status`; never infer mode from agent role
3. **Files to touch** — exact paths from the plan
4. **Acceptance criteria** — what "done" looks like
5. **Verification commands** — exact test/lint commands to run
6. **Relevant memory** — read `team_memory_read` for `decisions`, `context`, and `learnings` namespaces, paste relevant entries
7. **Run ID and step ID** — so the subagent can call `team_submit_result`
8. **Prior context** — any review feedback (for revisions) or user guidance
9. **Tool name mapping** — remind the subagent that `team_X` means `mcp_software-development-team_team_X`
10. **Persisted worktree lifecycle** — the actual `{targetBranch, targetCommit, path, branch}` values created at initial admission, plus the exact persisted execution mode and role/location rules. Verify that mode, path, branch, and captured target are present and consistent before dispatch; never recapture, recreate, or rewrite them during resume or retry.

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

## Deterministic Runnable-Set Scheduling

At every loop iteration and whenever a worker returns, refresh `team_status` and refill available capacity. `maxParallel` is the coordinator's or user's requested number of simultaneously spawned **workers**; only the coordinator is excluded. Count coder, reviewer, researcher, documentation, planner, and plan-critic workers. Parse that requested worker budget as a positive integer and clamp invalid, absent, or non-positive values to `1`. `team_status` reports the host's worker-slot capacity in its `hostCapacity` field. When a positive `hostCapacity` is reported, cap the budget at `hostCapacity - 1`; a reported four-slot host therefore permits at most three workers. If host capacity is absent or unknown, use the conservative one-worker limit. There is no separate server WIP cap.

Prioritize existing lifecycle work before new implementation work: first dispatch eligible reviewers and coder revisions, then use remaining capacity for new pending steps. For pending steps, examine dependency-complete candidates in plan order. A candidate is runnable only when it has no `fileConflicts` or other blocking indicator in the fresh status and its claimed files are disjoint from every active claim and every earlier selected same-batch claim. File comparison is exact planned file-string matching. Select and start candidates in that order until capacity is full.

Do not use pause, cancel, or cancel-successor semantics for normal scheduling. A rejected review or revision reduces capacity naturally; downstream work remains safe because unmet dependencies prevent dispatch. Refill a freed slot immediately after a worker finishes by taking a fresh status snapshot and rerunning this algorithm.

`start_coding` remains the authoritative claim operation: if it rejects any selected candidate, treat the entire selection as stale, refresh `team_status`, and reschedule rather than dispatching it. Never allow overlapping claimed files to run concurrently, including in separate worktrees.

## Stuck Detection

Escalate to the user when any of these are true for a step:

- `consecutiveSameError >= 2` — the coder is repeating the same failure; re-dispatching will not help
- `retryCount >= 3` — retry budget exhausted
- Agent reports BLOCKED
- File conflicts cannot be resolved by reordering steps

When stuck detection triggers, do NOT re-dispatch. Post the full error context to the terminal and wait for user guidance.

## File Conflict Handling

Conflicts serialize work; they do not create a paused state. Leave a conflicting pending step pending and omit it from the current runnable set. Once the active claim clears, refresh status and consider it again in plan order. If the conflict is persistent or cannot be sequenced safely, escalate with the exact overlapping planned file strings.

## Git Worktree Workflow

Every dispatched execution step uses a mandatory `.worktrees/{runId}/step-{N}` worktree and `team-{runId}-step-{N}` branch, including coder, reviewer, researcher, and documentation dispatches. Branch names are deliberately flat (`team-{runId}-step-{N}`, not `team/…`): git cannot create a hierarchical ref like `team/x/y` while any branch named `team` exists, so a slashed prefix could block runs. Planner and plan-critic remain pre-approval, primary-worktree, read-only agents. Worktrees never permit overlapping claimed files to run concurrently. StateMachine does not manage Git operations; the coordinator does.

### Initial Pending Admission: Create and Persist Once

Only when a PENDING execution step N has never been admitted and therefore has no persisted worktree tuple may the coordinator capture its current target branch and exact commit, then create from that captured base. Its `executionMode` must already exist in `team_status` and remains unchanged. A resumed, retried, reviewing, or interrupted step is not an initial admission and must reuse its tuple instead:

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
- **Location rule**: all repository reads, writes, tests, and Git commands run in this worktree; do not modify the coordinator or another step's worktree.

Reviewer, revision-coder, retried, and interrupted-worker re-dispatches reuse this exact persisted worktree and execution mode; never recapture a target, create another worktree, infer mode from role, or rewrite mode. Before a later dispatch, verify its persisted mode, path, branch, and captured target are present and consistent. If context is missing or inconsistent, do not dispatch and do not recreate it; record the exact inconsistency and persisted values, block or escalate, and preserve artifacts for recovery.

### Reviewer Approval, Merge, and Cleanup

Only after explicit reviewer approval, switch to the captured target branch and merge only there:

```bash
git switch "$targetBranch"
git merge team-{runId}-step-{N} --no-ff -m "Merge step {N}: {step description}"
```

On conflict, run `git merge --abort`, preserve worktree/branch artifacts, record exact error and conflicting files, and escalate. Never auto-resolve.

After successful merge, safely remove the persisted worktree and delete the persisted branch. An abandoned step is never merged; clean up only after abandonment is confirmed. Report cleanup failures with their exact path and branch and preserve artifacts.

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

If a step becomes ESCALATED or permanently BLOCKED, all steps that `dependsOn` it remain PENDING and must NOT be dispatched. When an escalation is resolved, dependent steps become eligible. If an escalation cannot be resolved, inform the user which downstream steps are also blocked and ask how to proceed.

## Kill Criteria

Escalate to user when:

- Retry count reaches 3
- Same error 2+ times (`consecutiveSameError >= 2`)
- Agent reports BLOCKED
- File conflicts cannot be resolved by reordering

## Post-Run

After all steps complete:

1. Read all memory namespaces (`learnings`, `reflections`, `reviews`, `decisions`, `context`) to gather everything the team persisted during the run.
2. Present a summary to the user: "The team discovered these patterns and gotchas during this run. Would you like to add any of these to your project's AGENTS.md?"
3. If the user approves entries, append them to the project's AGENTS.md file.

## Agent Message Relay

**Hard rule:** in every relayed `team_send_message` call, the `from` value MUST be a fixed roster role name — `planner`, `coder`, `reviewer`, `researcher`, or `documentation` — or `coordinator` for the coordinator's own messages — never a task/spawn label, spawn identifier, attempt-suffixed worker name, or filesystem path such as `coder_step_3_attempt_2` or `/root/workspace/...`. The dashboard attributes messages by roster name only. A resumed coordinator re-anchors this relay contract before its first scheduling pass.

The coordinator MUST relay messages on behalf of agents at every lifecycle point so the dashboard shows activity from all agents.

**When dispatching a coder:**

```
team_send_message(from: "coder", to: "coordinator", type: "info",
  body: "Starting step {N}: {description}. Files: {file list}")
```

**When coder returns:**

```
team_send_message(from: "coder", to: "coordinator", type: "result",
  body: "Step {N} complete: {brief summary of what was done}")
```

**When dispatching a reviewer:**

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

**When re-dispatching coder after revision:**

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
- Post BEFORE dispatching (for "starting" messages) and AFTER the agent returns (for "result" messages)
- Keep relay messages concise
- Use `info` for status updates, `result` for completions, `review` for review verdicts, `escalation` for escalations

## Debug Logging

Log coordinator decisions via `team_send_message(from: "coordinator", type: "info")` before each action:

- `"[COORDINATOR] Resuming run <runId>. N of M steps complete."`
- `"[COORDINATOR] Loop: step 3 is REVIEWING, step 4 is PENDING (no dependency) — starting pipeline"`
- `"[COORDINATOR] Dispatching coder for step 3 with 4 files, 3 criteria"`
- `"[COORDINATOR] Step 3 result: needs_revision — requesting revision (retry 2/3)"`
- `"[COORDINATOR] Step 3 has consecutiveSameError=2 — escalating to user"`
- `"[COORDINATOR] Step 4 blocked — file conflict with step 3 on src/api.ts"`
- `"[COORDINATOR] Step 3 ESCALATED: retry budget exhausted. Posting to terminal."`
- `"[COORDINATOR] All N steps complete. Starting learnings export."`

Log BEFORE taking the action.

## Terminal Updates

Print milestones inline:

- "Step 3/7: Build API endpoints — dispatching coder"
- "Step 3/7: Passed review"
- "Step 3/7: ESCALATED — reviewer found 2 issues after 3 retries. Need your guidance."
- "All 7 steps complete!"
