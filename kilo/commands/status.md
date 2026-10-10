---
description: Report the status of a coding-team run.
---

# Check Team Run Status (Kilo Code)

You are checking the status of a coding team run.

The run ID, if any, is whatever the user provided in the message that invoked this command.

## Tool Names

The team's MCP tools come from the `software-development-team` MCP server registered in `~/.config/kilo/kilo.jsonc`. Kilo Code surfaces MCP tools with a `<server>_` prefix. When this command says `team_X`, call `software-development-team_team_X`. The mapping:

- `team_status` → `software-development-team_team_status`
- `team_dashboard_url` → `software-development-team_team_dashboard_url`

If your Kilo Code build lists these tools without the prefix, call them by the exact names shown for the `software-development-team` server in the session's tool list; the `team_X` short names in this command always refer to those tools.

## MCP Availability Preflight

Before calling a team tool, inspect the tools exposed in the current session; do
not invent an availability API or attempt an unavailable call.

- **All team MCP tools are absent:** Stop before doing any team-state
  work. Tell the user to inspect `~/.config/kilo/kilo.jsonc` for the
  `software-development-team` entry, check Kilo Code Settings -> MCP for the server's
  status, and reload Kilo Code before retrying. A localhost dashboard URL in
  `.team/logs/server.log` only shows that the server is listening; it cannot
  register tools in an already-running session.
- **Only `team_dashboard_url` is unavailable:** Continue the available team-state
  work, but say that no dashboard link is available and report this diagnostic to
  the user. Do not guess a URL from server logs: a usable URL comes only from the
  registered `team_dashboard_url` tool.

## Steps

1. Call `team_dashboard_url` and show the user the dashboard link.

2. Call `team_status` with the provided run ID. If no run ID was given, look for the most recent run by listing the `.team/runs/` directory (e.g., `ls -t .team/runs/`), pick the first directory name (that's the run ID), and call `team_status` with it. If the `.team/runs/` directory doesn't exist or is empty, tell the user "No runs found. Start one with `/begin <task description>`."

3. Display a formatted summary:

```
Run: <task name> (<run ID>)
Status: <overall run status>
Dashboard: <url>

Steps (<N complete> / <total>):
  Step 1 [complete]   <step description>
  Step 2 [coding]     <step description>
  Step 3 [reviewing]  <step description>
  Step 4 [pending]    <step description>
  ...
```

4. Call out any issues prominently:
   - If any step is **escalated**: Print "ESCALATED: Step N — <reason>. Needs your attention."
   - If any step has `consecutiveSameError >= 2`: Print "STUCK: Step N is repeating the same error."
   - If any step has `fileConflicts`: Print "CONFLICT: Step N conflicts with step M on <files>."
   - If any step has `retryCount > 0`: Note "(retry <N>/3)" next to the step.

5. If the run is complete, say so and remind the user they can check memory with `/memory`.
