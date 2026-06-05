---
name: research
description: Research a technical topic, library, API, or codebase pattern and synthesize findings. Use when the user says "research this", "look into", "investigate", "find out how X works", or "what are the best practices for". Runs a standalone researcher outside any team run; findings are not persisted to team memory.
---

# Research a Topic

You are running a standalone research task outside of any team run.

The research query is whatever the user described in the message that invoked this skill. If they did not provide a query, ask them: "What would you like to research?" and wait for their response before proceeding.

## Tool Names

The team's MCP tools are namespaced. When this skill says `team_X`, call `mcp__software-development-team__team_X`. The mapping:

- `team_memory_read` → `mcp__software-development-team__team_memory_read`

## Steps

### 1. Check existing memory for prior research

Call `team_memory_read` for these namespaces to avoid duplicating work:
- `learnings` — prior research findings, patterns, and best practices
- `context` — factual background and prior codebase discoveries

Note any relevant entries that relate to the query.

### 2. Spawn the researcher agent

Request that Codex spawn the `researcher` agent with the context below. (The researcher definition lives in `~/.codex/agents/researcher.toml`.)

**Spawn context to include:**

```
You are a researcher. Your job is to answer the following research query thoroughly and return your findings as text.

## Research Query
<paste the user's research query here>

## Existing Knowledge
<paste any relevant memory entries found above, or "No prior context found.">

## Instructions

Use web search, web fetch, and file read/search tools to research the query. Consult multiple sources where appropriate.

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

> **Note**: These findings were NOT persisted to team memory because there is no active run. To persist research findings for use by the coding team, start a run with the begin skill and include a research step in your plan.
