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
4. Check for **file conflicts**: if any step has `fileConflicts`, pause the conflicting step.
5. Take the appropriate action for the first actionable step:

### Step is PENDING → Start it

Do BOTH of these in the same response:

**First**, call the MCP tool to update state:

```
mcp__plugin_software-development-team_software-development-team__team_advance(runId, stepId, action: "start_coding", agent: "coder")
```

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

Wait for the Agent to return before continuing the loop.

### Step is REVIEWING with coder's result → Dispatch reviewer

Check `steps[n].result`:

- **If result.status is `done` or `done_with_concerns`**: The coder finished. Dispatch the reviewer using the **Agent tool**. The reviewer will call `team_submit_result` with its verdict. After the reviewer Agent returns, check `team_status` again for the reviewer's result, then call `team_advance` with `approve` or `request_revision`.
- **If result.status is `needs_revision` (set by reviewer)**: Call `team_advance` with `request_revision`, then dispatch the coder again with the reviewer's feedback.

**`done_with_concerns` handling**: A coder may submit `done_with_concerns` when the implementation is complete but they have concerns. The reviewer CAN approve a `done_with_concerns` result — treat it the same as `done` for dispatch purposes, but ensure the reviewer reads and evaluates the concerns. If the concerns are serious enough to affect correctness, the reviewer should reject with `needs_revision`.

### Reviewer approved (result.status is `done`) → Advance

Call `team_advance(approve)`. Print milestone. Move to next step.

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

## Pipeline Parallelism

When a step enters REVIEWING, check if the NEXT step:

- Has no dependency on the current step (`dependsOn` does not include current step ID)
- Is still PENDING
- Has no file conflicts with the current step (check `fileConflicts` in `team_status`)

If all three are true, dispatch the coder for the next step in parallel.

**Safety rules:**

- If step N's review returns `needs_revision`, pause step N+1 until N is resolved.
- At most 8 steps active simultaneously (the server enforces this WIP limit).
- Never let two steps edit the same file concurrently.

## Stuck Detection

Escalate to the user when any of these are true for a step:

- `consecutiveSameError >= 2` — the coder is repeating the same failure; re-dispatching will not help
- `retryCount >= 3` — retry budget exhausted
- Agent reports BLOCKED
- File conflicts cannot be resolved by reordering steps

When stuck detection triggers, do NOT re-dispatch. Post the full error context to the terminal and wait for user guidance.

## File Conflict Handling

Before starting any step, check `fileConflicts` in `team_status`. If a step conflicts with another currently CODING or REVIEWING step:

1. **Pause** the conflicting step — do not dispatch it yet.
2. Wait for the blocking step to complete review and be approved.
3. Then dispatch the paused step.

If conflicts cannot be resolved by sequencing, escalate to the user with a clear description of the conflict. Log: `"[COORDINATOR] Step 4 blocked — file conflict with step 3 on src/api.ts"`

## Git Worktree Workflow

Use git worktrees when the user requests worktree isolation, or when pipeline parallelism is active with overlapping files.

### Worktree Creation

Before dispatching a coder for step N, create the worktree:

```bash
git worktree add .worktrees/step-{N} -b team/{runId}/step-{N}
```

### Dispatching the Coder with Worktree Context

Include in the coder's dispatch prompt:

- **Worktree path**: `.worktrees/step-{N}`
- **Branch name**: `team/{runId}/step-{N}`
- **Instruction**: Work entirely within the worktree directory — all reads and writes must use the worktree path
- **Instruction**: Commit all changes before calling `team_submit_result`

### Merge-Back After Approval

After the reviewer approves a step, merge the worktree branch back:

```bash
git merge team/{runId}/step-{N} --no-ff -m "Merge step {N}: {step description}"
```

**If the merge has conflicts**: Do NOT auto-resolve. Escalate to the user with the list of conflicting files. Wait for guidance.

### Cleanup After Successful Merge

```bash
git worktree remove .worktrees/step-{N}
git branch -d team/{runId}/step-{N}
```

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
