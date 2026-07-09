---
name: review
description: Review uncommitted changes or specific files for correctness, security, quality, and test coverage. Use when the user says "review my changes", "review this code", "check my diff", "audit these files", or "code review". Runs a standalone reviewer outside any team run; optionally takes file paths, otherwise reviews the current git diff.
---

# Review Code Changes

You are running a standalone code review outside of any team run.

If the user named specific file paths in the message that invoked this skill, use those as the review targets. Otherwise review the current uncommitted changes.

## Steps

### 1. Determine which files to review

**If file paths were provided**:
- Use those specific file paths as the review targets.
- Run `git diff HEAD -- <files>` and `git diff --cached -- <files>` to get the diff for those files.

**If no file paths were provided**:
- Run `git diff` to see unstaged changes.
- Run `git diff --cached` to see staged changes.
- Collect the list of all changed files from the diff output.
- If neither command returns output, tell the user: "No uncommitted changes found. Provide specific file paths to review files regardless of git status."

### 2. Collect diff output

Run the appropriate git diff commands and capture the full output. This will be included in the reviewer's spawn context.

If the diff is very large (>500 lines), summarize which files changed and note that the reviewer will read the files directly.

### 3. Spawn the reviewer agent

Read `${CODEX_HOME:-$HOME/.codex}/agents/reviewer.toml`, then call Codex's native `spawn_agent` tool with `task_name: "reviewer"`. Include that template's `developer_instructions` and the context below in the spawn message.

**Spawn context to include:**

```
You are a code reviewer. Your job is to review the following code changes and return a thorough review as text.

## Files to Review
<list the files being reviewed>

## Diff Output
<paste the git diff output here, or "Diff too large — read files directly.">

## Instructions

Review the changes for:
1. **Correctness** — Does the code do what it appears to intend? Are there logic errors or edge cases not handled?
2. **Security** — Any injection risks, unsafe operations, exposed secrets, or improper input handling?
3. **Code quality** — Is the code readable, well-structured, and consistent with project conventions?
4. **Error handling** — Are failure cases handled appropriately?
5. **Test coverage** — Do the changes have appropriate tests? Are existing tests still passing?

Run verification commands to check for regressions:
- If there is a `package.json` with test scripts, run the test suite (e.g., `npx vitest run` or `npm test`)
- Run type checking if applicable (e.g., `npx tsc --noEmit`)
- Run the linter if configured (e.g., `npx eslint <files>`)

**Important**: This is a standalone review — there is no active team run. Do NOT call any team MCP tools (no team_submit_result, no team_memory_write, no team_send_message). Return your review findings as structured text.

Structure your response as:
1. Overall verdict (Approved / Needs Changes / Blocking Issues)
2. Issues Found (if any) — for each issue: what's wrong, why it matters, how to fix it (include file and line reference)
3. Positive observations (what was done well)
4. Verification results (test output, type check output)
5. Suggestions (optional, non-blocking improvements)
```

Wait for the reviewer agent to return with its findings.

### 4. Display the review to the user

Present the reviewer's findings directly to the user.
