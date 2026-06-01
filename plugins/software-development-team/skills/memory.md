---
description: Browse and search team memory across all namespaces
when_to_use: When the user asks "what did the team learn", "show me team memory", "what decisions were made", "search memory for X", or wants to see decisions, context, learnings, reviews, or reflections stored by the coding team across runs.
argument-hint: <search query (optional)>
---

# Browse Team Memory

You are browsing or searching the coding team's shared memory.

**Search query:** $ARGUMENTS

## Tool Names

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__plugin_software-development-team_software-development-team__team_X`. The mapping:

- `team_memory_read` → `mcp__plugin_software-development-team_software-development-team__team_memory_read`

## Steps

### If a search query was provided in $ARGUMENTS

Call `team_memory_read` with ONLY the `search` parameter (do NOT pass `namespace` — the handler ignores `search` when `namespace` is set):

- `team_memory_read(search: "<query>")`

This returns matching entries across all namespaces. Group the results by their `namespace` field for display. If no results are returned, say "No memory entries found matching '<query>'."

### If no query was provided

Call `team_memory_read` for each namespace (no search parameter):

- `team_memory_read(namespace: "decisions")`
- `team_memory_read(namespace: "context")`
- `team_memory_read(namespace: "learnings")`
- `team_memory_read(namespace: "reviews")`
- `team_memory_read(namespace: "reflections")`

Display all entries grouped by namespace:

```
## decisions
  <key>: <value>
  ...

## context
  <key>: <value>
  ...

## learnings
  <key>: <value>
  ...

## reviews
  <key>: <value>
  ...

## reflections
  <key>: <value>
  ...
```

If a namespace is empty, show "  (empty)". If all namespaces are empty, say "No memory entries found. Run a coding task first to populate memory."

## Memory Namespace Reference

| Namespace     | Writers              | Purpose                                                              |
| ------------- | -------------------- | -------------------------------------------------------------------- |
| `decisions`   | Planner              | Architectural decisions and design choices                           |
| `context`     | Planner, Researcher  | Codebase structure, conventions, factual background                  |
| `learnings`   | Coder, Researcher, Coordinator | Patterns, gotchas, best practices from implementation or research    |
| `reviews`     | Reviewer             | Review calibration notes and recurring quality patterns              |
| `reflections` | All agents           | Post-step introspection (what was tricky, gotchas for future steps)  |
