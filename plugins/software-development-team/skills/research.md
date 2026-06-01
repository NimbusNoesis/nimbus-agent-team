---
description: Research a topic, API, or codebase pattern
when_to_use: When the user says "research this", "look into", "investigate", "find out how X works", "what are the best practices for", or wants a dedicated researcher agent to search the web, read documentation, and synthesize findings on a technical topic, library, API, or codebase pattern.
argument-hint: <research query>
---

# Research a Topic

You are running a standalone research task outside of any team run.

**Research query:** $ARGUMENTS

If the user did not provide a query (i.e., $ARGUMENTS is empty), ask them: "What would you like to research?" and wait for their response before proceeding.

## Tool Names

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__plugin_software-development-team_software-development-team__team_X`. The mapping:

- `team_memory_read` → `mcp__plugin_software-development-team_software-development-team__team_memory_read`

## Steps

### 1. Check existing memory for prior research

Call `team_memory_read` for these namespaces to avoid duplicating work:
- `learnings` — prior research findings, patterns, and best practices
- `context` — factual background and prior codebase discoveries

Note any relevant entries that relate to the query.

### 2. Dispatch the researcher agent

Use the **Agent tool** (the built-in Claude Code tool) to dispatch the researcher:

```
Agent(
  description: "Research: <research query>",
  subagent_type: "software-development-team:researcher",
  prompt: "<see dispatch prompt below>"
)
```

**Dispatch prompt to include:**

```
You are a researcher. Your job is to answer the following research query thoroughly and return your findings as text.

## Research Query
<paste the user's research query here>

## Existing Knowledge
<paste any relevant memory entries found above, or "No prior context found.">

## Instructions

Use WebSearch, WebFetch, Read, Grep, and Glob to research the query. Consult multiple sources where appropriate.

Focus on findings that are:
- Actionable (concrete recommendations, code patterns, API usage)
- Accurate (cite sources where possible)
- Concise (synthesize rather than dump raw text)

**Important**: This is a standalone research session — there is no active team run. Do NOT call any team MCP tools (no team_submit_result, no team_memory_write, no team_send_message). Simply return your findings as structured text.

Structure your response as:
1. Summary (2-3 sentences)
2. Key Findings (bulleted)
3. Code Examples or Patterns (if applicable)
4. Sources / References
5. Caveats or open questions (if any)
```

Wait for the researcher agent to return with its findings.

### 3. Display findings to the user

Present the researcher's findings directly to the user.

Then add this note:

> **Note**: These findings were NOT persisted to team memory because there is no active run. To persist research findings for use by the coding team, start a run with `/software-development-team:begin` and include a research step in your plan.
