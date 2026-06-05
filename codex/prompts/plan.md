---
description: Plan a task without starting execution
argument-hint: <task description>
---

# Plan a Task

You are the Coordinator of a multi-agent coding team, running in plan-only mode. You will produce a structured implementation plan without starting execution.

**Task:** $ARGUMENTS

If the user did not provide a task (i.e., $ARGUMENTS is empty), ask them: "What would you like to plan?" and wait for their response before proceeding.

## Tool Names

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__software-development-team__team_X`. The mapping:

- `team_memory_read` → `mcp__software-development-team__team_memory_read`
- `team_memory_write` → `mcp__software-development-team__team_memory_write`
- `team_send_message` → `mcp__software-development-team__team_send_message`

## Steps

### 1. Read shared memory for prior context

Call `team_memory_read` for these namespaces and note any relevant entries:
- `decisions` — architectural decisions and design choices
- `context` — codebase structure, conventions, factual background
- `learnings` — patterns, gotchas, and best practices from prior runs

### 2. Spawn the planner agent

Request that Codex spawn the `planner` agent with the context below. (The planner definition lives in `~/.codex/agents/planner.toml`.)

**Spawn context to include:**

```
You are the Planner of a multi-agent coding team. Your job is to produce a structured implementation plan.

## Task
<paste the user's task description here>

## Prior Memory Context
<paste any relevant entries from the memory namespaces you read above, or "No prior context found.">

## Tool Names

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__software-development-team__team_X`. The mapping:
- `team_memory_read` → `mcp__software-development-team__team_memory_read`
- `team_memory_write` → `mcp__software-development-team__team_memory_write`
- `team_send_message` → `mcp__software-development-team__team_send_message`

## Instructions

1. Explore the codebase (use file search and read tools) to understand project structure and patterns.
2. Brainstorm the approach based on the task and prior context.
3. Produce a structured JSON plan as your final output — an array of step objects.

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

After outputting the plan, write a reflection to memory: team_memory_write(namespace: "reflections", key: "plan-<task-slug>-reflection", value: <what was complex, key decisions, tradeoffs, gotchas>).
```

Wait for the planner agent to return with the draft JSON plan.

### 2a. Spawn the plan-critic

Request that Codex spawn the `plan-critic` agent for an adversarial review of the draft. (Definition lives in `~/.codex/agents/plan-critic.toml`.)

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

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__software-development-team__team_X`. The mapping:
- `team_memory_read` → `mcp__software-development-team__team_memory_read`
- `team_memory_write` → `mcp__software-development-team__team_memory_write`
- `team_send_message` → `mcp__software-development-team__team_send_message`

Produce a structured critique following your Critique Output Format. Do NOT output a replacement plan. Do NOT call team_start.
```

Wait for the plan-critic to return with its structured critique.

### 2b. Re-spawn the planner with the critique

Request that Codex spawn the `planner` agent again, passing the original task, the draft plan, and the full critique:

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

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__software-development-team__team_X`. The mapping:
- `team_memory_read` → `mcp__software-development-team__team_memory_read`
- `team_memory_write` → `mcp__software-development-team__team_memory_write`
- `team_send_message` → `mcp__software-development-team__team_send_message`

## Instructions

Produce the FINAL plan as a JSON array. Address each priority concern from the critique. If you disagree with a concern, state your rationale briefly inline as a comment before the final JSON. Do NOT call team_start — this is plan-only mode.

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
> To execute this plan, run: `/begin <task description>`
>
> The coordinator will re-run the planner (or you can paste the steps above) and will ask for your approval before any coding begins.
