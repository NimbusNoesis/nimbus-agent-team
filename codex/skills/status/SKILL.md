---
name: status
description: Check a coding-team run's status and step progress. Use when the user asks "what's the team doing", "how's the run going", "show me progress", "check status", "which steps are done", or wants to investigate stuck, escalated, or failed steps. Optionally takes a run ID; defaults to the most recent run.
---

# Check Team Run Status

You are checking the status of a coding team run.

If the user named a run ID in the message that invoked this skill, use it. Otherwise default to the most recent run (see step 2).

## Tool Names

The team's MCP tools are namespaced. When this skill says `team_X`, call `mcp__software-development-team__team_X`. The mapping:

- `team_status` → `mcp__software-development-team__team_status`
- `team_dashboard_url` → `mcp__software-development-team__team_dashboard_url`

## MCP Availability Preflight

Before calling a team tool, inspect the tools exposed in the current session; do
not invent an availability API or attempt an unavailable call.

- **All team MCP tools are absent:** Stop before looking up status. Tell the user
  to inspect the installed `${CODEX_HOME:-$HOME/.codex}/config.toml`, run
  `codex mcp get software-development-team`, and start a fresh Codex
  session before retrying. A localhost dashboard URL in `.team/logs/server.log`
  only shows that the server is listening; it cannot register tools in an
  already-running session.
- **Only `team_dashboard_url` is unavailable:** Continue the available team-state
  status lookup, but say that no dashboard link is available and report this
  diagnostic to the user. Do not guess a URL from server logs: a usable URL comes
  only from the registered `team_dashboard_url` tool.

## Steps

1. If `team_dashboard_url` is available, call it and show the user the returned
   dashboard link. Otherwise continue the status lookup without a dashboard link
   as required by the MCP Availability Preflight diagnostic.

2. Call `team_status` with the run ID. If the user did not give one, look for the most recent run by listing the `.team/runs/` directory (e.g., `ls -t .team/runs/`), pick the first directory name (that's the run ID), and call `team_status` with it. If the `.team/runs/` directory doesn't exist or is empty, tell the user "No runs found. Start one with the begin skill (`$begin`)."

3. Display a formatted summary:

```
Run: <task name> (<run ID>)
Status: <overall run status>
Dashboard: <url, when `team_dashboard_url` is registered; otherwise unavailable (team_dashboard_url is not registered)>

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

5. If the run is complete, say so and remind the user they can browse memory with the memory skill.
