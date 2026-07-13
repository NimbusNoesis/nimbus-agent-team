---
name: deep-plan
description: Develop an exhaustive software-development plan through bounded recursive refinement WITHOUT starting execution. Use for ambiguous, cross-cutting, architecture-heavy, security-sensitive, migration-sensitive, iterative, or high-risk work that needs requirements discovery, focused research, adversarial critique, and a resumable planning dossier. Use the lightweight plan skill for ordinary previews and begin only when implementation is requested.
---

# Deep Plan a Task

You are the main-session controller for a standalone deep-planning workflow. You coordinate bounded, visible refinement; subagents perform one pass each and never own recursion.

The task is whatever the user described when invoking this skill. A resume request has the form `resume <D>` and may include the answer to the pending question.

This workflow is pre-run and read-only. It produces a rich planning dossier plus a validated JSON array that could later be passed as `team_start({ steps: appendix })`. It MUST NOT call `team_start`, modify repository files, create a run, create a worktree, or begin implementation.

## Tool Names and Availability

The team's MCP tools are namespaced. When this skill says `team_X`, call `mcp__software_development_team__team_X`.

- `team_memory_read` -> `mcp__software_development_team__team_memory_read`
- `team_memory_write` -> `mcp__software_development_team__team_memory_write`

Before starting, inspect the tools exposed in the current session. If either memory tool is absent, stop and tell the user to inspect `${CODEX_HOME:-$HOME/.codex}/config.toml`, run `codex mcp get software-development-team`, and start a fresh Codex session. Resumable checkpoints and exact reflection identities cannot be guaranteed without both tools. Never call workflow, result, message, or dashboard tools in this skill.

## Hard Limits

Maintain explicit counters and never create a hidden retry loop:

- at most **three refinement responses** from the recursive-planner template;
- at most **five material user questions**, asked one at a time;
- at most **two deduplicated research probes** using the researcher template;
- exactly **one mandatory plan-critic pass** after every non-cancel refinement exit;
- exactly **one mandatory recursive-planner synthesis pass** after the critic;
- malformed refinement output consumes its current refinement round;
- malformed research or critic output consumes that fixed dispatch;
- malformed synthesis is never redispatched.

The independent five-question limit is a ceiling, not permission to exceed the three refinement-response limit. A normal workflow may therefore ask fewer than five questions.

## Canonical Workflow State

Persist the checkpoint in the `context` namespace at `deep-plan-<D>-checkpoint`. The controller writes this planning context on behalf of the recursive planner that produced it.

The checkpoint is one JSON object containing only:

```json
{
  "protocolVersion": "1.0",
  "workflowDiscriminator": "<D>",
  "phase": "refinement",
  "canonicalBrief": "...",
  "latestDossier": null,
  "latestAppendix": null,
  "decisionLedger": [],
  "evidenceLedger": [],
  "openQuestions": [],
  "counters": {
    "refinementRoundsUsed": 0,
    "materialQuestionsUsed": 0,
    "researchProbesUsed": 0,
    "criticPassesUsed": 0,
    "synthesisPassesUsed": 0
  },
  "seenRequestSignatures": [],
  "previousDossierSignature": null,
  "pendingRequest": null,
  "validationDefects": [],
  "criticFindings": null
}
```

Never checkpoint raw transcripts, chain-of-thought, superseded drafts, duplicated memory, or full research dumps. `evidenceLedger` contains compact decision-relevant capsules with source references. `decisionLedger` contains user answers, explicit assumptions, and provenance. `openQuestions` records impact and blocking status.

Before yielding for a user answer, write the complete checkpoint. After an answer, `skip`, or `resume <D>`, reconstruct only from the checkpoint plus the new user input; do not rely on a prior subagent transcript. Overwrite the same checkpoint after each state transition. Mark it `phase: "complete"` only after successful final rendering, or `phase: "cancelled"` on cancellation.

## Workflow, Native Labels, and Reflection Identity

Before the first spawn, inspect every live and previously created native agent path in this coordinator session. Allocate the smallest positive integer `<W>` for which this complete seven-label set is unused:

- `recursive_planner_<W>_round_1`
- `recursive_planner_<W>_round_2`
- `recursive_planner_<W>_round_3`
- `deep_plan_research_<W>_probe_1`
- `deep_plan_research_<W>_probe_2`
- `deep_plan_critic_<W>`
- `recursive_planner_<W>_synthesis`

Reserve/check the complete set before the first spawn. Every resolved label must match `^[a-z0-9_]+$`, labels are pairwise unique, and task labels never select role templates. A later deep-plan invocation in the same session MUST allocate another `<W>` and must not reuse any path. Literal examples are `recursive_planner_1_round_1`, `recursive_planner_1_round_2`, `recursive_planner_1_round_3`, `deep_plan_research_1_probe_1`, `deep_plan_research_1_probe_2`, `deep_plan_critic_1`, and `recursive_planner_1_synthesis`.

Set `<D>` to a grammar-safe value such as `codex-<W>-<task-slug>`, containing only lowercase ASCII letters, digits, and hyphens. Call `team_memory_read` by exact key and verify the checkpoint and this complete reflection-key set are unused:

- `prerun-deep-plan-<D>-round-1-reflection`
- `prerun-deep-plan-<D>-round-2-reflection`
- `prerun-deep-plan-<D>-round-3-reflection`
- `prerun-deep-plan-<D>-probe-1-reflection`
- `prerun-deep-plan-<D>-probe-2-reflection`
- `prerun-deep-plan-<D>-critic-reflection`
- `prerun-deep-plan-<D>-synthesis-reflection`

If any memory key exists, advance `<W>` and recompute the whole label/key set before dispatch. Never fabricate a run ID or use a run-scoped reflection key.

## Native Spawn Rule

Before EVERY spawn, read the applicable installed template completely:

- `${CODEX_HOME:-$HOME/.codex}/agents/recursive-planner.toml`
- `${CODEX_HOME:-$HOME/.codex}/agents/researcher.toml`
- `${CODEX_HOME:-$HOME/.codex}/agents/plan-critic.toml`

Include that template's `developer_instructions` plus the complete phase context below in the native `spawn_agent` request. The resolved `task_name` is only the unique invocation label; it never loads or selects the TOML role. Do not dispatch if a required template is missing or unreadable.

## Authoritative Signature Algorithm

The controller, not a subagent, computes request and dossier signatures:

1. Remove volatile values: counters, timestamps, generated/candidate signatures, workflow IDs, and formatting-only metadata.
2. Normalize strings to Unicode NFKC, trim them, and collapse internal whitespace.
3. Case-fold natural-language comparison fields. Preserve case for repository paths, commands, identifiers, URLs, hashes, and other case-sensitive tokens.
4. Recursively sort object keys.
5. Sort only explicitly unordered collections such as sets of tags or unordered evidence references. Preserve architecturally meaningful order in implementation steps, appendix steps, data flows, migrations, rollout/rollback sequences, and dependency lists.
6. Serialize as compact UTF-8 JSON and compute SHA-256. Use an available local, non-mutating SHA-256 facility. If none is available, record a validation defect and use the full canonical JSON as the comparison key; never invent a digest.

Ignore self-reported `dossierSignature`, `request.signature`, readiness, and material delta until the controller independently validates them. A repeated authoritative request or dossier signature is a convergence stop for refinement, not a reason to vary wording.

## Recursive-Planner Response Validation

Each recursive-planner response MUST be one JSON object with exactly these top-level fields in this order:

`protocolVersion`, `round`, `readiness`, `materialDelta`, `request`, `dossierSignature`, `compactState`, `dossier`, `appendix`.

Validate all of the following before accepting it:

- `protocolVersion` is `"1.0"`, `round` matches the dispatched round, and there are no extra fields.
- `readiness` is `ready`, `needs_input`, or `bounded_incomplete`.
- `request` is null or exactly one `{kind,text,rationale,signature}` object; `kind` is `question` or `research`. Question and research are mutually exclusive.
- `ready` and `bounded_incomplete` have null request; `needs_input` has one request; synthesis cannot return `needs_input`.
- `compactState` contains the canonical brief, decision/evidence ledgers, open questions, counters, seen request signatures, and previous dossier signature. Treat controller counters as authoritative.
- every required dossier section exists: requirements/assumptions, goals/non-goals, current state, architecture/data flow, implementation, risks/security, testing, rollout/rollback, observability, documentation, acceptance criteria, and open questions.
- the appendix passes the graph and verification checks below.

Malformed output consumes the active round. Preserve the latest previously validated dossier and appendix, append a precise validation defect, and continue only if a refinement round remains. There is no uncounted correction dispatch.

## Appendix Validation

`appendix` is the nonempty JSON array supplied to the `steps` argument of a possible later `team_start({ steps: appendix })`; it is not a wrapper object and this workflow never starts that run.

Validate that:

- every step has exactly `id`, `description`, `files`, `acceptanceCriteria`, and `dependsOn`;
- IDs are positive integers and unique;
- descriptions are nonempty;
- files are nonempty, unique, exact repository-relative strings without absolute paths, globs, or directory-only claims;
- acceptance criteria are nonempty and every step has at least one unambiguous executable verification command;
- dependencies are unique IDs present in the same appendix;
- no step depends on itself and the dependency graph is acyclic;
- exact file strings repeated across steps are serialized by a dependency path between every owner;
- topological order and data/architecture prerequisites agree.

If validation fails, the response is malformed for control-flow purposes even when the dossier prose is useful.

## State Machine

### Phase 0 — Bootstrap or Resume

If the user supplied no task, ask exactly: "What would you like to deep-plan?" and wait. This bootstrap happens before allocating `<W>`/`<D>` or initializing counters and does not consume the five-question budget.

If the request is `resume <D>`, read `deep-plan-<D>-checkpoint` from `context`. If it is missing, malformed, complete, or cancelled, report that exact condition and stop. Otherwise reconstruct from it. Treat any additional user text as the answer to `pendingRequest`; reject an answer when no request is pending.

For a new task, allocate `<W>` and `<D>`, initialize the checkpoint, and read relevant `decisions`, `context`, and `learnings` memory. Compact only decision-relevant prior knowledge into the canonical brief or evidence ledger.

### Phase 1 — Bounded Refinement

Before each pass, increment `refinementRoundsUsed`, persist the checkpoint, read `recursive-planner.toml`, and spawn with the resolved label for round N (for example `task_name: "recursive_planner_1_round_1"`).

The spawn message MUST include mode `refinement`, round, canonical brief, latest validated dossier/appendix, full decision and evidence ledgers, open questions, authoritative counters and remaining budgets, seen request signatures, previous authoritative dossier signature, exact reflection key `prerun-deep-plan-<D>-round-<N>-reflection`, the template's complete developer instructions, and the full standalone constraints. Explicitly say no run/step/worktree exists, no transcript is required, and final output is the exact JSON envelope.

After validation and authoritative signature calculation:

- `cancel`: if the user sends `cancel` while answering a pending question, mark cancelled and return the latest partial dossier, appendix if valid, and `<D>`. Do not spawn critic or synthesis.
- `skip`: record the skipped request as an explicit assumption and open question, clear `pendingRequest`, and continue if a refinement round remains.
- question request: reject a repeated signature. If unique and within the five-question cap, increment `materialQuestionsUsed`, set `pendingRequest`, checkpoint, ask only that question, show `<D>`, and wait. If repeated or out of budget, exit refinement as bounded-incomplete.
- research request: reject a repeated signature. If unique and within the two-probe cap, increment `researchProbesUsed`, persist the signature, run the standalone research override below, compact its result into `evidenceLedger`, clear the request, and continue if a round remains. If repeated or out of budget, exit refinement as bounded-incomplete.
- ready: accept only if the controller confirms a valid appendix, no blocking critical unknown, and either a material first artifact or a non-repeated authoritative dossier signature. Then exit refinement.
- no material delta, repeated dossier signature, exhausted refinement rounds, or `bounded_incomplete`: exit refinement with the reason recorded.

Every non-cancel exit from refinement MUST continue to Phase 2. Readiness is never permission to skip critique or synthesis.

### Phase 1R — Standalone Research Override

Read `researcher.toml`, then spawn with the resolved probe label (for example `task_name: "deep_plan_research_1_probe_1"`). The spawn message includes the complete template instructions but explicitly overrides its run-oriented defaults:

- this is pre-run standalone evidence collection; no run ID, step ID, worktree, branch, lifecycle, or file claim exists;
- remain read-only in the primary workspace and on the web; do not edit, stage, commit, install, or mutate external state;
- do not call `team_submit_result`, `team_send_message`, `team_start`, `team_advance`, or write `context`, `decisions`, `learnings`, or `reviews`;
- the only permitted team write is one `reflections` entry using exact key `prerun-deep-plan-<D>-probe-<N>-reflection`; do not fabricate an ID or another key;
- return exactly one compact evidence capsule with `query`, `summary`, `findings`, `sources`, and `caveats`; do not submit a lifecycle result.

Pass the atomic research query, rationale, request signature, canonical brief, and relevant compact evidence. A malformed or failed probe consumes the probe and becomes a validation defect; never redispatch the same probe.

### Phase 2 — Mandatory Plan-Critic

Increment `criticPassesUsed` to one, checkpoint, read `plan-critic.toml`, and spawn exactly once with the resolved critic label (for example `task_name: "deep_plan_critic_1"`). Include the template's complete instructions, canonical brief, latest validated dossier and appendix, compact evidence/decisions/open questions, refinement exit reason, and these explicit overrides:

- no run exists; do not require or fabricate run/step/worktree context;
- primary workspace is read-only; do not mutate repository or external state;
- do not call workflow/result/message tools or `team_start`;
- write only the required reflection using exact key `prerun-deep-plan-<D>-critic-reflection`;
- return the critic's seven structured sections, reviewing both dossier completeness and appendix executability; do not output a replacement plan.

Malformed critic output consumes the one critic pass. Record a validation defect and proceed to synthesis with the defect as critic feedback; never rerun the critic.

### Phase 3 — Mandatory Synthesis

Increment `synthesisPassesUsed` to one, checkpoint, reread `recursive-planner.toml`, and spawn exactly once with the resolved synthesis label (for example `task_name: "recursive_planner_1_synthesis"`) in mode `synthesis`. Include the complete template instructions and pass the complete canonical state, latest validated dossier/appendix, critic output or critic validation defect, all remaining unknowns, and exact key `prerun-deep-plan-<D>-synthesis-reflection`.

Require `request: null`; synthesis cannot ask a question or request research. Validate the exact envelope, authoritative signature, dossier, and appendix. If valid, adopt it. If malformed, record the defect and fall back to the latest previously validated dossier and appendix; do not create a hidden synthesis retry. If no validated fallback exists, stop `bounded_incomplete`, report the validation defects with `<D>`, and do not fabricate or display an executable appendix.

### Phase 4 — Render and Stop

Render the final dossier as readable Markdown with all required sections, followed by the appendix in a JSON code block. State:

- readiness (`ready` or `bounded_incomplete`) and unresolved blocking questions;
- workflow discriminator `<D>`;
- that no implementation, team run, or repository mutation occurred;
- that the appendix may be supplied later as `team_start.steps` through the normal begin/approval workflow.

Persist `phase: "complete"` and the final validated artifacts. Do not start execution or silently hand work to another agent.

## Failure and Safety Rules

- Never exceed a counter after malformed output, interruption, resume, skip, or repeated request.
- Never treat a subagent's candidate signature or readiness as authoritative.
- Never discard a critical unknown merely to report ready.
- Never include secrets or raw sensitive memory in a checkpoint or spawn message.
- Never let `resume`, `skip`, or cancel create a second active workflow or reuse another workflow's reflection keys.
- If native spawning fails, record the failure as a consumed phase/round where applicable; do not reuse the failed invocation label or invent a hidden replacement.
