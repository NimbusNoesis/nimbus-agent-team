---
description: Check the current team run status and progress. Use when the user asks "what's the team doing", "how's the run going", "show me progress", "check status", "which steps are done", wants to see step-by-step progress of a coding team run, or is investigating stuck, escalated, or failed steps.
argument-hint: <run-id (optional)>
---

# Check Team Run Status

You are checking the status of a coding team run.

**Run ID argument:** $ARGUMENTS

## Tool Names

The team's MCP tools are namespaced. When this prompt says `team_X`, call `mcp__plugin_software-development-team_software-development-team__team_X`. The mapping:

- `team_status` → `mcp__plugin_software-development-team_software-development-team__team_status`
- `team_dashboard_url` → `mcp__plugin_software-development-team_software-development-team__team_dashboard_url`

## Steps

1. Call `team_dashboard_url` and show the user the dashboard link.

2. Call `team_status` with the provided run ID. If no run ID was given in $ARGUMENTS, look for the most recent run by listing the `.team/runs/` directory (e.g., `ls -t .team/runs/`), pick the first directory name (that's the run ID), and call `team_status` with it. If the `.team/runs/` directory doesn't exist or is empty, tell the user "No runs found. Start one with `/software-development-team:begin <task description>`."

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
