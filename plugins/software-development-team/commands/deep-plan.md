---
description: Develop an exhaustive software-development plan through bounded recursive refinement. Use for ambiguous, cross-cutting, architecture-heavy, security-sensitive, migration-sensitive, iterative, or high-risk work that needs requirements discovery, focused research, adversarial critique, and a resumable planning dossier before implementation.
argument-hint: <task description | resume WORKFLOW_ID>
---

# Deep Plan a Task

You are the main-session controller for a standalone deep-planning workflow. You coordinate bounded, visible refinement; subagents perform one pass each and never own recursion.

**Invocation:** $ARGUMENTS

This workflow is pre-run and read-only. It produces a rich planning dossier plus a validated JSON array that could later be passed as `team_start({ steps: appendix })`. It MUST NOT call `team_start`, modify repository files, create a run, create a worktree, or begin implementation.

## Tool Names

The team's MCP tools are namespaced. When this command says `team_X`, call `mcp__plugin_software-development-team_software-development-team__team_X`.

- `team_memory_read` -> `mcp__plugin_software-development-team_software-development-team__team_memory_read`
- `team_memory_write` -> `mcp__plugin_software-development-team_software-development-team__team_memory_write`

The only allowed MCP operations are these memory reads and checkpoint/reflection writes. Never call workflow, result, message, or dashboard tools.

## Hard Limits

Maintain explicit counters and never create a hidden retry loop:

- at most **three refinement responses** from `software-development-team:recursive-planner`;
- at most **five material user questions**, asked one at a time;
- at most **two deduplicated research probes** using `software-development-team:researcher`;
- exactly **one mandatory plan-critic pass** after every non-cancel refinement exit;
- exactly **one mandatory recursive-planner synthesis pass** after the critic;
- malformed refinement output consumes its current refinement round;
- malformed research or critic output consumes that fixed dispatch;
- malformed synthesis is never redispatched.

The independent five-question limit is a ceiling, not permission to exceed the three refinement-response limit. A normal workflow may therefore ask fewer than five questions.

## Canonical Workflow State

Use a grammar-safe workflow discriminator `<D>` containing only lowercase ASCII letters, digits, and hyphens. Persist the checkpoint in the `context` namespace at `deep-plan-<D>-checkpoint`. The controller writes this planning context on behalf of the recursive planner that produced it.

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

## Workflow and Reflection Identity

For a new workflow, create a collision-resistant `<D>` such as `<utc-date>-<task-slug>-<short-hex>`. Before dispatching, call `team_memory_read` by exact key and verify that the checkpoint and this complete reflection-key set are unused:

- `prerun-deep-plan-<D>-round-1-reflection`
- `prerun-deep-plan-<D>-round-2-reflection`
- `prerun-deep-plan-<D>-round-3-reflection`
- `prerun-deep-plan-<D>-probe-1-reflection`
- `prerun-deep-plan-<D>-probe-2-reflection`
- `prerun-deep-plan-<D>-critic-reflection`
- `prerun-deep-plan-<D>-synthesis-reflection`

If any key exists, choose another discriminator before the first dispatch. Never fabricate a run ID or use a run-scoped reflection key.

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

If `$ARGUMENTS` is empty, ask exactly: "What would you like to deep-plan?" and wait. This bootstrap happens before allocating `<D>` or initializing counters and does not consume the five-question budget.

If the invocation is `resume <D>`, read `deep-plan-<D>-checkpoint` from `context`. If it is missing, malformed, complete, or cancelled, report that exact condition and stop. Otherwise reconstruct from it. Treat any additional user text as the response to `pendingRequest`; reject a response when no request is pending. If the response is `cancel`, take the cancellation branch below. If it is `skip`, record the pending question as an explicit assumption and open question, then clear `pendingRequest`. Otherwise append the exact question, answer, timestamp/provenance, and affected decision to `decisionLedger`, clear `pendingRequest`, checkpoint, and continue. Never treat an unrelated new request as an answer.

For a new task, allocate `<D>`, initialize the checkpoint, and read relevant `decisions`, `context`, and `learnings` memory. Compact only decision-relevant prior knowledge into the canonical brief or evidence ledger.

### Phase 1 — Bounded Refinement

Before each pass, increment `refinementRoundsUsed`, persist the checkpoint, then dispatch:

```text
Agent(
  description: "Deep-plan refinement round N",
  subagent_type: "software-development-team:recursive-planner",
  prompt: <complete canonical dispatch context>
)
```

The prompt MUST include mode `refinement`, round, canonical brief, latest validated dossier/appendix, full decision and evidence ledgers, open questions, authoritative counters and remaining budgets, seen request signatures, previous authoritative dossier signature, and exact key `prerun-deep-plan-<D>-round-<N>-reflection`. Explicitly say no run/step/worktree exists, no transcript is required, and final output is the exact JSON envelope.

After validation and authoritative signature calculation:

- user `cancel`: if the user sends `cancel` while answering a pending question, mark cancelled and return the latest partial dossier, appendix if valid, and `<D>`. Do not dispatch critic or synthesis.
- user `skip`: record the skipped request as an explicit assumption and open question, clear `pendingRequest`, and continue if a refinement round remains.
- question request: reject a repeated signature. If unique and within the five-question cap, increment `materialQuestionsUsed`, set `pendingRequest`, checkpoint, ask only that question, show `<D>`, and wait. If repeated or out of budget, exit refinement as bounded-incomplete.
- research request: reject a repeated signature. If unique and within the two-probe cap, increment `researchProbesUsed`, persist the signature, run the standalone research override below, compact its result into `evidenceLedger`, clear the request, and continue if a round remains. If repeated or out of budget, exit refinement as bounded-incomplete.
- ready: accept only if the controller confirms a valid appendix, no blocking critical unknown, and either a material first artifact or a non-repeated authoritative dossier signature. Then exit refinement.
- no material delta, repeated dossier signature, exhausted refinement rounds, or `bounded_incomplete`: exit refinement with the reason recorded.

Every non-cancel exit from refinement MUST continue to Phase 2. Readiness is never permission to skip critique or synthesis.

### Phase 1R — Standalone Research Override

Dispatch with explicit type `software-development-team:researcher`. The prompt overrides the researcher's run-oriented defaults:

- this is pre-run standalone evidence collection; no run ID, step ID, worktree, branch, lifecycle, or file claim exists;
- remain read-only in the primary workspace and on the web; do not edit, stage, commit, install, or mutate external state;
- do not call `team_submit_result`, `team_send_message`, `team_start`, `team_advance`, or write `context`, `decisions`, `learnings`, or `reviews`;
- the only permitted team write is one `reflections` entry using the exact key `prerun-deep-plan-<D>-probe-<N>-reflection`; do not fabricate an ID or another key;
- return only one valid JSON evidence capsule with exactly `query`, `summary`, `findings`, `sources`, and `caveats`; emit no Markdown wrapper or lifecycle result.

Pass the atomic research query, rationale, request signature, canonical brief, and relevant compact evidence. A malformed or failed probe consumes the probe and becomes a validation defect; never redispatch the same probe.

### Phase 2 — Mandatory Plan-Critic

Increment `criticPassesUsed` to one, checkpoint, and dispatch exactly once:

```text
Agent(
  description: "Critique deep-plan dossier and appendix",
  subagent_type: "software-development-team:plan-critic",
  prompt: <standalone critic context>
)
```

The prompt MUST include the canonical brief, latest validated dossier and appendix, compact evidence/decisions/open questions, refinement exit reason, and these overrides:

- no run exists; do not require or fabricate run/step/worktree context;
- primary workspace is read-only; do not mutate repository or external state;
- do not call workflow/result/message tools or `team_start`;
- write only the required reflection using exact key `prerun-deep-plan-<D>-critic-reflection`;
- return the critic's seven structured sections, reviewing both dossier completeness and appendix executability; do not output a replacement plan.

Malformed critic output consumes the one critic pass. Record a validation defect and proceed to synthesis with the defect as critic feedback; never rerun the critic.

### Phase 3 — Mandatory Synthesis

Increment `synthesisPassesUsed` to one, checkpoint, and dispatch `software-development-team:recursive-planner` exactly once in mode `synthesis`. Pass the complete canonical state, latest validated dossier/appendix, the critic output or critic validation defect, all remaining unknowns, and exact key `prerun-deep-plan-<D>-synthesis-reflection`.

Require `request: null`; synthesis cannot ask a question or request research. Validate the exact envelope, authoritative signature, dossier, and appendix. If valid, adopt it. If malformed, record the defect and fall back to the latest previously validated dossier and appendix; do not create a hidden synthesis retry. If no validated fallback exists, stop `bounded_incomplete`, report the validation defects with `<D>`, and do not fabricate or display an executable appendix.

### Phase 4 — Render and Stop

Render the final dossier as readable Markdown with all required sections, followed by the appendix in a JSON code block. State:

- readiness (`ready` or `bounded_incomplete`) and unresolved blocking questions;
- workflow discriminator `<D>`;
- that no implementation, team run, or repository mutation occurred;
- that the appendix may be supplied later as `team_start.steps` through the normal begin/approval workflow.

Persist `phase: "complete"` and the final validated artifacts. Do not start execution or silently hand work to another agent.

## Failure and Safety Rules

- If required memory tools are unavailable, stop before dispatch: resumable checkpoints and exact reflection identities cannot be guaranteed.
- Never exceed a counter after malformed output, interruption, resume, skip, or repeated request.
- Never treat a subagent's candidate signature or readiness as authoritative.
- Never discard a critical unknown merely to report ready.
- Never include secrets or raw sensitive memory in a checkpoint or agent prompt.
- Never let `resume`, `skip`, or cancel create a second active workflow or reuse another workflow's reflection keys.
