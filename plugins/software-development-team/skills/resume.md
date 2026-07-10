---
description: Resume an interrupted team run. Use when the user says "resume the run", "continue where we left off", "pick up the team run", "restart the interrupted run", or wants to reconnect to a coding team run that was interrupted mid-execution due to a session ending or crash.
argument-hint: <run-id>
---

# Resume an Interrupted Team Run

You ARE the Coordinator of a multi-agent coding team. You run in the main session so you can dispatch subagents.

**Run ID to resume:** $ARGUMENTS

If no run ID was provided (i.e., $ARGUMENTS is empty), ask the user: "Which run would you like to resume? Please provide the run ID." and wait for their response before proceeding.

## Tool Names

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__plugin_software-development-team_software-development-team__team_X`. The mapping:

- `team_status` → `mcp__plugin_software-development-team_software-development-team__team_status`
- `team_advance` → `mcp__plugin_software-development-team_software-development-team__team_advance`
- `team_send_message` → `mcp__plugin_software-development-team_software-development-team__team_send_message`
- `team_get_messages` → `mcp__plugin_software-development-team_software-development-team__team_get_messages`
- `team_memory_read` → `mcp__plugin_software-development-team_software-development-team__team_memory_read`
- `team_memory_write` → `mcp__plugin_software-development-team_software-development-team__team_memory_write`
- `team_dashboard_url` → `mcp__plugin_software-development-team_software-development-team__team_dashboard_url`

## Two Separate Systems

You have TWO different tool systems. Do not confuse them:

1. **MCP tools** (`mcp__plugin_software-development-team_software-development-team__team_*`) — These update STATE in the MCP server. They track which step is coding/reviewing/complete. They do NOT execute any work.

2. **Agent tool** — This is a Claude Code built-in tool that DISPATCHES a subagent to do actual work. The subagent runs in its own context, does the work, and returns.

**The MCP tools and the Agent tool are completely separate.** The `agent` parameter in `team_advance` is just a label string (e.g., `"coder"`), NOT a dispatch prompt. To actually make a coder do work, you must use the `Agent` tool.

## Re-entry Steps

1. Call `team_dashboard_url` and show the user the dashboard link.

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
mcp__plugin_software-development-team_software-development-team__team_advance(runId, stepId, action: "start_coding", agent: "coder")
```

`start_coding` is authoritative. Dispatch a worker **only after it succeeds**. If it is rejected, the scheduling snapshot is stale: call `team_status`, recompute the runnable set, and retry the scheduling decision; never dispatch from the stale snapshot.

**Then**, dispatch the appropriate agent using the **Agent tool** (this is the built-in Claude Code tool, NOT an MCP tool). The agent you dispatch depends on the step type:

- **coder** — implements code changes (most steps)
- **researcher** — investigates unknowns, APIs, or patterns before coding
- **documentation** — writes or updates documentation

```
Agent(
  description: "Implement step N: <brief>",
  prompt: "<full dispatch context per checklist>"
)
```

Treat a failed worker spawn as a lifecycle event: do not leave a successfully started step orphaned in `coding`. Immediately call `team_submit_result` for that step with `status: "blocked"` and details containing the spawn error, then refresh `team_status`. Do not schedule dependent work from the failed step. If that submission fails, refresh status and escalate with both the spawn and submission errors. Continue to use the same claim and capacity checks while other workers run.

### Step is REVIEWING with coder's result → Dispatch reviewer

Check `steps[n].result`:

- **If result.status is `done` or `done_with_concerns`**: The coder finished. Dispatch the reviewer using the **Agent tool**. The reviewer will call `team_submit_result` with its verdict. After the reviewer Agent returns, check `team_status` again for the reviewer's result, then call `team_advance` with `approve` or `request_revision`.
- **If result.status is `needs_revision` (set by reviewer)**: Call `team_advance` with `request_revision`, then dispatch the coder again with the reviewer's feedback.

**`done_with_concerns` handling**: A coder may submit `done_with_concerns` when the implementation is complete but they have concerns. The reviewer CAN approve a `done_with_concerns` result — treat it the same as `done` for dispatch purposes, but ensure the reviewer reads and evaluates the concerns. If the concerns are serious enough to affect correctness, the reviewer should reject with `needs_revision`.

### Reviewer approved (result.status is `done`) → Advance

Call `team_advance(approve)`. Print milestone, refresh `team_status`, and rerun the deterministic scheduler.

### Reviewer rejected (result.status is `needs_revision`) → Revise

Call `team_advance(request_revision)`. Dispatch coder again with reviewer feedback via Agent tool.

When re-dispatching a coder after `NEEDS_REVISION`:

1. Include the reviewer's specific feedback (what's wrong, why, how to fix)
2. **Require a diagnosis**: Tell the coder "Before making changes, write a one-line diagnosis of each issue — what went wrong and the fix — then implement."
3. Include the step's `retryCount` so the coder knows the urgency
4. If `consecutiveSameError >= 2`, escalate to the user instead of re-dispatching — the coder is stuck in a loop

### Step is ESCALATED → Ask user

Print the issue. Wait for user guidance. When received, `team_advance(resolve_escalation)` and re-dispatch coder.

### Step is CODING (agent was interrupted mid-work) → Re-dispatch

If a step is stuck in CODING state because the previous coordinator session was interrupted before the agent returned, re-dispatch the coder agent with the same step context. The coder will check what was done and complete or redo the work, then call `team_submit_result`. Note this situation to the user: "Step N was mid-coding when interrupted — re-dispatching coder."

## Dispatch Context Checklist

Every Agent dispatch prompt needs all of these — subagents have no inherited context.

1. **Step description** — what to build
2. **Files to touch** — exact paths from the plan
3. **Acceptance criteria** — what "done" looks like
4. **Verification commands** — exact test/lint commands to run
5. **Relevant memory** — read `team_memory_read` for `decisions`, `context`, and `learnings` namespaces, paste relevant entries
6. **Run ID and step ID** — so the subagent can call `team_submit_result`
7. **Prior context** — any review feedback (for revisions) or user guidance
8. **Tool name mapping** — remind the subagent that `team_X` means `mcp__plugin_software-development-team_software-development-team__team_X`

## Deterministic Runnable-Set Scheduling

At every loop iteration and whenever a worker returns, refresh `team_status` and refill available capacity. `maxParallel` is the coordinator's or user's requested number of simultaneously spawned **workers**; only the coordinator is excluded. Count coder, reviewer, researcher, documentation, planner, and plan-critic workers. Parse that requested worker budget as a positive integer and clamp invalid, absent, or non-positive values to `1`. Then, when a positive host capacity is reported, cap it at `reportedHostCapacity - 1`; a reported four-slot host therefore permits at most three workers. If host capacity is absent or unknown, use the conservative one-worker limit. There is no separate server WIP cap.

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

Every dispatched execution step uses a mandatory `.worktrees/{runId}/step-{N}` worktree and `team/{runId}/step-{N}` branch, including coder, reviewer, researcher, and documentation dispatches. Planner and plan-critic remain pre-approval, primary-worktree, read-only agents. Worktrees never permit overlapping claimed files to run concurrently. StateMachine does not manage Git operations; the coordinator does.

### Initial Pending Admission: Create and Persist Once

Only when a PENDING execution step N is first selected for admission, capture the coordinator current target branch and exact commit, then create from that captured base:

```bash
targetBranch=$(git branch --show-current)
targetCommit=$(git rev-parse HEAD)
git worktree add -b team/{runId}/step-{N} .worktrees/{runId}/step-{N} "$targetCommit"
```

Persist `{targetBranch, targetCommit, path, branch}` as the step worktree lifecycle context before `start_coding`; path is `.worktrees/{runId}/step-{N}` and branch is `team/{runId}/step-{N}`. Never recapture or recreate it for that step. If initial capture or creation fails, do not call `start_coding` and do not dispatch. Record the exact error plus intended path/branch in team state/messages, block or escalate, and wait for resolution.

### Mandatory Execution Dispatch Context

Every coder, reviewer, researcher, and documentation dispatch reads the persisted step worktree lifecycle context and includes:

- **Worktree path**: `.worktrees/{runId}/step-{N}`
- **Branch name**: `team/{runId}/step-{N}`
- **Captured target**: `{targetBranch}` at `{targetCommit}`
- **Role rules**: coder and documentation edit/commit only in this worktree; reviewer and researcher are read-only and inspect/run verification only here; reviewer approval is required before merge.
- **Location rule**: all repository reads, writes, tests, and Git commands run in this worktree; do not modify the coordinator or another step's worktree.

Reviewer, revision-coder, and interrupted-worker re-dispatches reuse this exact persisted context; never recapture a target or create another worktree. Before a later dispatch, verify its persisted path and branch are present and consistent. If context is missing or inconsistent, do not dispatch and do not recreate it; record the exact inconsistency and persisted values, block or escalate, and preserve artifacts for recovery.

### Reviewer Approval, Merge, and Cleanup

Only after explicit reviewer approval, switch to the captured target branch and merge only there:

```bash
git switch "$targetBranch"
git merge team/{runId}/step-{N} --no-ff -m "Merge step {N}: {step description}"
```

On conflict, run `git merge --abort`, preserve worktree/branch artifacts, record exact error and conflicting files, and escalate. Never auto-resolve.

After successful merge, safely remove the persisted worktree and delete the persisted branch. An abandoned step is never merged; clean up only after abandonment is confirmed. Report cleanup failures with their exact path and branch and preserve artifacts.

```bash
git worktree remove .worktrees/{runId}/step-{N}
git branch -d team/{runId}/step-{N}
```

For a confirmed-abandoned, unmerged step, remove the worktree first, then force-delete its branch:

```bash
git worktree remove .worktrees/{runId}/step-{N}
git branch -D team/{runId}/step-{N}
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
2. Present a summary to the user: "The team discovered these patterns and gotchas during this run. Would you like to add any of these to your project's CLAUDE.md?"
3. If the user approves entries, append them to the project's CLAUDE.md file.

## Agent Message Relay

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
