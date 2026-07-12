---
name: plan
description: Produce a structured implementation plan for a task WITHOUT starting execution. Use when the user says "plan this", "scope this out", "break this down into steps", "how would the team approach this", or wants to preview steps, files, dependencies, and acceptance criteria before committing to a full run. Do NOT use when the user wants the work actually implemented (use the begin skill).
---

# Plan a Task

You are the Coordinator of a multi-agent coding team, running in plan-only mode. You will produce a structured implementation plan without starting execution.

The task to plan is whatever the user described in the message that invoked this skill. If they did not describe a task, ask them: "What would you like to plan?" and wait for their response before proceeding.

## Tool Names

The team's MCP tools are namespaced. When this skill says `team_X`, call `mcp__software_development_team__team_X`. The mapping:

- `team_memory_read` → `mcp__software_development_team__team_memory_read`
- `team_memory_write` → `mcp__software_development_team__team_memory_write`

## Steps

### 1. Read shared memory for prior context

Call `team_memory_read` for these namespaces and note any relevant entries:
- `decisions` — architectural decisions and design choices
- `context` — codebase structure, conventions, factual background
- `learnings` — patterns, gotchas, and best practices from prior runs

### 2. Spawn the planner agent

Before spawning, allocate a fresh positive integer planning-workflow discriminator `<W>` by choosing the smallest integer for which `planner_draft_<W>`, `plan_critic_<W>`, and `planner_final_<W>` are all unused agent paths in this coordinator session. This sequence is created before any run exists and does not depend on a run ID. Reuse the same `<W>` for all three passes of this workflow; a later plan invocation MUST allocate a new value.

Read `${CODEX_HOME:-$HOME/.codex}/agents/planner.toml`, then call Codex's native `spawn_agent` tool with the resolved draft label (for example `task_name: "planner_draft_1"`). This unique invocation label does not load the template. Include that template's `developer_instructions` and the context below in the spawn message.

**Spawn context to include:**

```
You are the Planner of a multi-agent coding team. Your job is to produce a structured implementation plan.

## Task
<paste the user's task description here>

## Prior Memory Context
<paste any relevant entries from the memory namespaces you read above, or "No prior context found.">

## Tool Names

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__software_development_team__team_X`. The mapping:
- `team_memory_read` → `mcp__software_development_team__team_memory_read`
- `team_memory_write` → `mcp__software_development_team__team_memory_write`

## Instructions

1. Explore the codebase (use file search and read tools) to understand project structure and patterns.
2. Brainstorm the approach based on the task and prior context.
3. Write any progress, rationale, or reflection with `team_memory_write` before your final response — never `team_send_message`: no team run exists, and the server rejects messages for unknown run IDs. Your final response MUST be only a valid JSON array of step objects: no prose, Markdown fence, or JSON comments.

Each step object must follow this schema:
{
  "id": <number>,
  "description": "What to implement",
  "files": ["path/to/file.ts"],
  "acceptanceCriteria": [
    "Tests pass: npx vitest run tests/specific.test.ts",
    "Criterion 2"
  ],
  "dependsOn": []
}

Rules:
- Every step must include at least one executable verification command in acceptanceCriteria.
- No two steps should list the same file unless one dependsOn the other.
- Target 5-6 steps for most features. Keep each step focused.
- Do NOT call team_start — this is plan-only mode.

Before your final response, write a reflection to memory: team_memory_write(namespace: "reflections", key: "planonly-<task-slug>-reflection", value: <what was complex, key decisions, tradeoffs, gotchas>). Use the `planonly-` prefix and a descriptive task slug: plan-only mode runs outside any team run, so there is no run-ID to scope the key with. This durable key keeps standalone-plan reflections distinct from run-scoped (`<run-prefix>-step-N-reflection`) entries; re-planning the same task intentionally overwrites its prior plan-only reflection.

This is an explicit pre-run reflection override of the planner template: no run exists and you MUST use the exact `planonly-<task-slug>-reflection` key. Do not require or fabricate a run ID.
```

Wait for the planner agent to return with the draft JSON plan.

### 2a. Spawn the plan-critic

Read `${CODEX_HOME:-$HOME/.codex}/agents/plan-critic.toml`, then call Codex's native `spawn_agent` tool with the critic label using the workflow's same `<W>` (for example `task_name: "plan_critic_1"`). The role name and template filename remain `plan-critic`; the resolved `plan_critic_<W>` is the distinct, grammar-valid native task label for this pass. Include that template's `developer_instructions` and the context below in the spawn message.

**Spawn context to include:**

```
You are being spawned as the plan-critic for an adversarial review pass.

## Task description
<paste the user's task description here>

## Draft plan (JSON)
<paste the planner's full JSON steps array here — include all fields: id, description, files, acceptanceCriteria, dependsOn>

## Relevant memory context
<paste any relevant entries from decisions, context, and learnings that you read in step 1, or "No prior context found.">

## Tool Names

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__software_development_team__team_X`. The mapping:
- `team_memory_read` → `mcp__software_development_team__team_memory_read`
- `team_memory_write` → `mcp__software_development_team__team_memory_write`

Produce a structured critique following your Critique Output Format. Do NOT output a replacement plan. Do NOT call team_start.

Reflection override: this is pre-run plan-only mode, so no run ID exists. Write the critique reflection with the exact key `planonly-<task-slug>-plan-critique-reflection`; do not require or fabricate a run ID.
```

Wait for the plan-critic to return with its structured critique.

### 2b. Re-spawn the planner with the critique

Read `${CODEX_HOME:-$HOME/.codex}/agents/planner.toml` again, then call the native `spawn_agent` tool with the final label using the workflow's same `<W>` (for example `task_name: "planner_final_1"`), passing the template's `developer_instructions`, the original task, the draft plan, and the full critique. Do not reuse `planner_draft_<W>`: native task names identify invocation paths, not templates, and every resolved planning-pass label must remain unique and match `^[a-z0-9_]+$`.

**Spawn context to include:**

```
You are the Planner of a multi-agent coding team. You previously produced a draft plan. An adversarial plan-critic has reviewed it and produced a structured critique. Your job is to produce the FINAL revised plan.

## Task
<paste the user's task description here>

## Draft plan (JSON)
<paste the planner's original draft plan here>

## Plan-critic's critique
<paste the full critique from step 2a here>

## Prior Memory Context
<paste any relevant entries from the memory namespaces you read in step 1, or "No prior context found.">

## Tool Names

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__software_development_team__team_X`. The mapping:
- `team_memory_read` → `mcp__software_development_team__team_memory_read`
- `team_memory_write` → `mcp__software_development_team__team_memory_write`

## Instructions

Address each priority concern from the critique. If you disagree with a concern, write the rationale with `team_memory_write` before your final response — never `team_send_message`: no team run exists, and the server rejects messages for unknown run IDs. Your final response MUST be only a valid JSON array: no prose, Markdown fence, or JSON comments. Do NOT call team_start — this is plan-only mode.

Reflection override: this is pre-run plan-only mode, so no run ID exists. Write the final-planner reflection with the exact key `planonly-<task-slug>-final-plan-reflection`; do not require or fabricate a run ID.

Each step object must follow this schema:
{
  "id": <number>,
  "description": "What to implement",
  "files": ["path/to/file.ts"],
  "acceptanceCriteria": [
    "Tests pass: npx vitest run tests/specific.test.ts",
    "Criterion 2"
  ],
  "dependsOn": []
}
```

Wait for the planner to return with the FINAL revised JSON plan.

### 3. Display the plan

Parse the FINAL JSON plan from step 2b (the revised plan, not the draft) and display it as a formatted table:

```
Plan for: <task description>
Total steps: <N>

| Step | Description | Files | Depends On | Acceptance Criteria |
|------|-------------|-------|------------|---------------------|
|  1   | <desc>      | <files> | —        | <criteria list>     |
|  2   | <desc>      | <files> | Step 1   | <criteria list>     |
...
```

If a step has `dependsOn` entries, list them as "Step N, Step M". If empty, show "—".

### 4. Tell the user how to execute

After displaying the plan, say:

> This is a plan-only preview. No work has been started.
>
> To execute this plan, run the begin skill (`$begin <task description>`).
>
> The coordinator will re-run the planner (or you can paste the steps above) and will ask for your approval before any coding begins.
