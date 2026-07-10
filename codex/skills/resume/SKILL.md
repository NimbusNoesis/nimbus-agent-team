---
name: resume
description: Resume an interrupted coding-team run. Use when the user says "resume the run", "continue where we left off", "pick up the team run", or wants to reconnect to a team run that stopped mid-execution due to a session ending or crash. Requires a run ID. Do NOT use to start a new task (use the begin skill).
---

# Resume an Interrupted Team Run

You ARE the Coordinator of a multi-agent coding team. You run in the main Codex session so you can spawn subagents.

The run ID to resume is whatever the user provided in the message that invoked this skill. If no run ID was provided, ask the user: "Which run would you like to resume? Please provide the run ID." and wait for their response before proceeding.

## Tool Names

The team's MCP tools are namespaced. When this skill says `team_X`, call `mcp__software-development-team__team_X`. The mapping:

- `team_status` → `mcp__software-development-team__team_status`
- `team_advance` → `mcp__software-development-team__team_advance`
- `team_send_message` → `mcp__software-development-team__team_send_message`
- `team_get_messages` → `mcp__software-development-team__team_get_messages`
- `team_memory_read` → `mcp__software-development-team__team_memory_read`
- `team_memory_write` → `mcp__software-development-team__team_memory_write`
- `team_submit_result` → `mcp__software-development-team__team_submit_result`
- `team_dashboard_url` → `mcp__software-development-team__team_dashboard_url`

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

1. **MCP tools** (`mcp__software-development-team__team_*`) — These update STATE in the MCP server. They track which step is coding/reviewing/complete. They do NOT execute any work.

2. **Subagent spawning** — Codex spawns specialized subagents (coder, reviewer, etc.) on your request, each running in its own context. The role templates live in `${CODEX_HOME:-$HOME/.codex}/agents/*.toml`; read the relevant template and include its `developer_instructions` with the full step context in a native `spawn_agent` call. `task_name` is a unique invocation label and never loads or selects a TOML template. It MUST match `^[a-z0-9_]+$` and remain unique among all paths from the resumed session, including completed agents.

For every execution or resumed dispatch use `<role>_step_<N>_attempt_<A>`: for example `coder_step_2_attempt_1` and `reviewer_step_2_attempt_1`. The attempt is one-based per role/phase and step. Increment it for every revision, recovery, interrupted re-dispatch, or repeated review, consulting persisted state and known prior dispatches so an existing agent path is never reused. The step component prevents parallel same-role workers from colliding. Role/template identities remain unchanged (including template `plan-critic`); the invocation label does not determine which template is loaded.

**The MCP tools and subagent spawning are completely separate.** The `agent` parameter in `team_advance` is just a label string (e.g., `"coder"`), NOT a spawn request. To actually make a coder do work, you must call Codex's native `spawn_agent` tool.

## Re-entry Steps

1. If `team_dashboard_url` is available, call it and show the user the returned
   dashboard link. Otherwise continue without a dashboard link as required by
   the MCP Availability Preflight diagnostic.

2. Call `team_status` with the provided run ID to load current state. If the run is not found, tell the user and stop.

3. Read shared memory for context (`team_memory_read` for all 5 namespaces):
   - `team_memory_read(namespace: "decisions")`
   - `team_memory_read(namespace: "context")`
   - `team_memory_read(namespace: "learnings")`
   - `team_memory_read(namespace: "reviews")`
   - `team_memory_read(namespace: "reflections")`

4. Check `team_get_messages` for any pending messages or guidance from before the interruption.

5. Print a brief status summary showing where the run was interrupted and which steps need attention.

6. Announce: "[COORDINATOR] Resuming run <runId>. Current state: <N> of <total> steps complete. Entering coordinator loop."

7. Enter the coordinator loop below.

## The Loop and Deterministic Runnable-Set Scheduler

Repeat until all steps are complete. Every iteration refreshes `team_status`, checks `team_get_messages`, handles stuck detection, completes lifecycle transitions, and refills worker capacity.

1. Determine the worker limit from the host capacity reported by `team_status`: `maxParallel = reportedHostCapacity - 1` (the coordinator consumes one slot). Thus four total slots permit three simultaneously spawned workers. If host capacity is unknown, use `maxParallel = 1`. Do not impose a server WIP cap. Count every spawned planner, plan-critic, coder, reviewer, researcher, and documentation worker; only the coordinator is excluded.
2. Count active spawned workers and available slots. First reserve available slots for review/revision lifecycle work: spawn reviewers for completed coder results, and after an accepted `request_revision`, spawn revision coders. Then build the remaining runnable set from PENDING steps in plan order. A pending candidate is eligible only when all dependencies are complete, it has no `fileConflicts` or `blockingReasons`, and its exact declared file strings are disjoint from active claims and from selections already made in this batch. Exact string matching is the contract; do not normalize paths or infer overlap.
3. For every selected pending step, call `team_advance(runId, stepId, action: "start_coding", agent: "<role>")` **before** spawning. `team_advance` is authoritative admission control. If it rejects the action, treat the snapshot as stale: refresh `team_status` and reschedule from the beginning; never spawn from the rejected snapshot.
4. Only after admission succeeds, relay and spawn the selected role (coder, researcher, or documentation) with the full per-step context. If native spawning fails after admission, call `team_submit_result` with `result.status='blocked'` and the spawn error, then immediately refresh `team_status` and relay the failure; never pretend the worker was spawned or advance the step. Refill capacity whenever a worker returns or a lifecycle action completes.

### Review and revision lifecycle

- A `REVIEWING` step with coder result `done` or `done_with_concerns` is review work and has priority. Spawn a reviewer when a worker slot is available; after it returns, refresh state and use `approve` or `request_revision` as appropriate.
- A review result `needs_revision` is revision work and has priority. Call `team_advance(request_revision)` and only spawn the revision coder if that transition succeeds; a rejection requires a fresh status and reschedule. Include the review feedback, one-line diagnosis requirement for each issue, and `retryCount`.
- A reviewer result `done` advances with `team_advance(approve)`. `done_with_concerns` still receives normal review and may be approved or rejected by the reviewer.
- If `consecutiveSameError >= 2`, escalate instead of re-spawning.

### Step is ESCALATED → Ask user

Print the issue. Wait for user guidance. When received, `team_advance(resolve_escalation)` and re-spawn coder.

### Step is CODING (agent was interrupted mid-work) → Re-spawn

If a step is stuck in CODING state because the previous coordinator session was interrupted before the agent returned, treat its recovery as lifecycle work: admit it only when a worker slot is available, account for its active file claim, and re-spawn the appropriate original role with the same step context. The worker checks what was done and completes or redoes the work, then calls `team_submit_result`. Note this situation to the user: "Step N was mid-coding when interrupted — re-spawning worker."

## Spawn Context Checklist

Every subagent spawn request needs all of these — subagents have no inherited context.

1. **Task goal** — the complete human-readable goal from the persisted run, not only the current step
2. **Step description** — what to build
3. **Files to touch** — exact paths from the plan
4. **Acceptance criteria** — what "done" looks like
5. **Full dependencies** — the step's complete `dependsOn` list plus the current status/result of every dependency
6. **Verification commands** — exact test/lint commands to run
7. **Relevant memory** — read `team_memory_read` for `decisions`, `context`, and `learnings` namespaces, paste relevant entries
8. **Run ID and step ID** — actual values so the subagent can call `team_submit_result`
9. **Actual reflection prefix** — the first 8 characters of the real run ID, supplied as a resolved value for reflection/review keys
10. **Prior context** — all persisted review feedback, previous worker result/error, user guidance, retry/escalation history, and relevant team messages; use "none" only after checking each source
11. **Tool name mapping** — the complete mapping needed by the role template, with `team_X` meaning `mcp__software-development-team__team_X`
12. **Persisted worktree lifecycle** — the actual `{targetBranch, targetCommit, path, branch}` values created at initial admission, plus the role and location rules below. Verify that path and branch are present and consistent before spawning; never recapture or recreate them during resume.

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

Only when a PENDING execution step N is first selected for admission, capture the coordinator's current target branch and exact commit, then create the branch/worktree from that captured commit:

```bash
targetBranch=$(git branch --show-current)
targetCommit=$(git rev-parse HEAD)
git worktree add -b team-{runId}-step-{N} .worktrees/{runId}/step-{N} "$targetCommit"
```

Persist `{targetBranch, targetCommit, path, branch}` as the step worktree lifecycle context before `start_coding`; path is `.worktrees/{runId}/step-{N}` and branch is `team-{runId}-step-{N}`. Never recapture or recreate it for that step. If initial capture or creation fails, do not call `start_coding` and do not dispatch. Record the exact error plus intended path/branch in team state/messages, block or escalate the step, and wait for resolution.

### Mandatory Execution Dispatch Context

Every coder, reviewer, researcher, and documentation dispatch reads the persisted step worktree lifecycle context and includes:

- **Worktree path**: `.worktrees/{runId}/step-{N}`
- **Branch name**: `team-{runId}-step-{N}`
- **Captured target**: `{targetBranch}` at `{targetCommit}`
- **Role rules**: coder and documentation edit/commit only in this worktree; reviewer and researcher are read-only and inspect/run verification only here; reviewer approval is required before merge.
- **Location rule**: all repository reads, writes, tests, and Git commands run from this worktree; never modify the coordinator or another step's worktree.

Reviewer, revision-coder, and interrupted-worker re-dispatches reuse this exact persisted context; never recapture a target or create another worktree. Before a later dispatch, verify its persisted path and branch are present and consistent. If context is missing or inconsistent, do not dispatch and do not recreate it; record the exact inconsistency and persisted values, block or escalate, and preserve artifacts for recovery.

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
