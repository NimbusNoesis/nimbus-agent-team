# Browse Team Memory (Cursor)

You are browsing or searching the coding team's shared memory.

The search query, if any, is whatever the user provided in the message that invoked this command.

## Tool Names

The team's MCP tools come from the `software-development-team` MCP server registered in `~/.cursor/mcp.json`. Cursor surfaces MCP tools with an `mcp_<server>_` prefix. When this command says `team_X`, call `mcp_software-development-team_team_X`. The mapping:

- `team_memory_read` → `mcp_software-development-team_team_memory_read`

## Steps

### If a search query was provided

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
