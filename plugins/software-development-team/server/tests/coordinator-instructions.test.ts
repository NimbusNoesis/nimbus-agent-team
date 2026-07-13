import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Keep this test independent of the directory Vitest was launched from.
const repositoryRoot = new URL('../../../../', import.meta.url);

const codexSkillFiles = ['begin', 'deep-plan', 'plan', 'resume', 'status', 'memory', 'research', 'review'].map(
  (name) => `codex/skills/${name}/SKILL.md`,
);
const codexAgentRoles = [
  'planner',
  'plan-critic',
  'recursive-planner',
  'coder',
  'reviewer',
  'researcher',
  'documentation',
] as const;
const codexAgentFiles = codexAgentRoles.map((role) => `codex/agents/${role}.toml`);
const readRepositoryFile = (file: string) => readFileSync(new URL(file, repositoryRoot), 'utf8');
const codexSkills = codexSkillFiles.map((file) => ({ file, content: readRepositoryFile(file) }));
const codexAgents = codexAgentFiles.map((file, index) => ({
  file,
  role: codexAgentRoles[index],
  content: readRepositoryFile(file),
}));

const instructionFiles = [
  'codex/skills/begin/SKILL.md',
  'codex/skills/resume/SKILL.md',
  'plugins/software-development-team/commands/begin.md',
  'plugins/software-development-team/commands/resume.md',
] as const;

const instructions = instructionFiles.map((file) => ({
  file,
  content: readFileSync(new URL(file, repositoryRoot), 'utf8').replace(/\*\*/g, ''),
}));

const roles = ['planner', 'plan-critic', 'coder', 'reviewer', 'researcher', 'documentation'] as const;
const agentFiles = roles.flatMap((role) => [
  { role, file: `codex/agents/${role}.toml` },
  { role, file: `plugins/software-development-team/agents/${role}.md` },
]);
const agents = agentFiles.map(({ role, file }) => ({
  role,
  file,
  content: readFileSync(new URL(file, repositoryRoot), 'utf8').replace(/\*\*/g, ''),
}));

const claudeDeepPlan = readRepositoryFile('plugins/software-development-team/commands/deep-plan.md');
const codexDeepPlan = readRepositoryFile('codex/skills/deep-plan/SKILL.md');
const deepPlanSurfaces = [
  { host: 'Claude', content: claudeDeepPlan },
  { host: 'Codex', content: codexDeepPlan },
] as const;
const claudeRecursivePlanner = readRepositoryFile('plugins/software-development-team/agents/recursive-planner.md');
const codexRecursivePlanner = readRepositoryFile('codex/agents/recursive-planner.toml');
const recursivePlannerSurfaces = [
  { host: 'Claude', content: claudeRecursivePlanner },
  { host: 'Codex', content: codexRecursivePlanner },
] as const;
const dashboardAgentConstants = readRepositoryFile(
  'plugins/software-development-team/server/src/dashboard/client/utils/constants.ts',
);
const normalPlanSurfaces = [
  readRepositoryFile('plugins/software-development-team/commands/plan.md'),
  readRepositoryFile('codex/skills/plan/SKILL.md'),
] as const;

const sectionBetween = (content: string, start: string, end?: string) => {
  const startIndex = content.indexOf(start);
  expect(startIndex, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = end ? content.indexOf(end, startIndex + start.length) : content.length;
  expect(endIndex, `missing section ${end}`).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
};

describe('coordinator instruction contract', () => {
  it('covers every Codex skill and native agent template', () => {
    expect(codexSkillFiles).toEqual([
      'codex/skills/begin/SKILL.md',
      'codex/skills/deep-plan/SKILL.md',
      'codex/skills/plan/SKILL.md',
      'codex/skills/resume/SKILL.md',
      'codex/skills/status/SKILL.md',
      'codex/skills/memory/SKILL.md',
      'codex/skills/research/SKILL.md',
      'codex/skills/review/SKILL.md',
    ]);
    expect(codexAgentFiles).toEqual([
      'codex/agents/planner.toml',
      'codex/agents/plan-critic.toml',
      'codex/agents/recursive-planner.toml',
      'codex/agents/coder.toml',
      'codex/agents/reviewer.toml',
      'codex/agents/researcher.toml',
      'codex/agents/documentation.toml',
    ]);
    for (const { file, content } of [...codexSkills, ...codexAgents]) {
      expect(content, `${file} must not be empty`).not.toHaveLength(0);
    }
  });

  it('uses Codex-sanitized MCP callable namespaces', () => {
    const expectedNamespace = 'mcp__software_development_team__';
    const invalidRawNamespace = 'mcp__software-development-team__';
    const mcpSkills = codexSkills.filter(({ file }) => !file.endsWith('/review/SKILL.md'));

    for (const { file, content } of [...mcpSkills, ...codexAgents]) {
      expect(content, `${file} must use the sanitized MCP namespace`).toContain(expectedNamespace);
    }
    for (const { file, content } of [...codexSkills, ...codexAgents]) {
      expect(content, `${file} must not use the raw hyphenated MCP namespace`).not.toContain(invalidRawNamespace);
    }
  });

  it('uses native-compatible literal task labels and an explicit role mapping', () => {
    const taskLabels = codexSkills.flatMap(({ file, content }) =>
      [...content.matchAll(/task_name\s*:\s*["'`]([^"'`]+)["'`]/g)].map((match) => ({ file, label: match[1] })),
    );

    expect(taskLabels.length).toBeGreaterThan(0);
    for (const { file, label } of taskLabels) {
      expect(label, `${file} contains an invalid native task_name`).toMatch(/^[a-z0-9_]+$/);
    }

    const begin = codexSkills.find(({ file }) => file.endsWith('/begin/SKILL.md'))!.content;
    const plan = codexSkills.find(({ file }) => file.endsWith('/plan/SKILL.md'))!.content;
    const deepPlan = codexSkills.find(({ file }) => file.endsWith('/deep-plan/SKILL.md'))!.content;
    const resume = codexSkills.find(({ file }) => file.endsWith('/resume/SKILL.md'))!.content;
    expect(begin).toMatch(/plan-critic[^\n]*task_name:\s*["'`]plan_critic_1["'`]/i);
    expect(plan).toMatch(/template filename remain[s]?\s*["'`]?plan-critic["'`]?[^\n]*plan_critic_<W>[^\n]*grammar-valid native task label/i);
    expect(plan).toMatch(/task_name:\s*["'`]planner_draft_1["'`][\s\S]*task_name:\s*["'`]plan_critic_1["'`][\s\S]*task_name:\s*["'`]planner_final_1["'`]/);
    for (const content of [begin, plan]) {
      expect(content).toMatch(/fresh positive integer[\s\S]*planner_draft_<W>[\s\S]*plan_critic_<W>[\s\S]*planner_final_<W>/i);
      expect(content).toMatch(/(?:pre-[^\n]*team_start|before any run exists)[^\n]*does not depend on a run ID/i);
      expect(content).toMatch(/later (?:plan(?: or begin)? )?invocation[^\n]*(?:new|allocate)/i);
    }
    expect(begin).toMatch(/task_name[^\n]*unique invocation label[^\n]*never loads or selects a template/i);
    expect(begin).toMatch(/<role>_step_<N>_attempt_<A>[\s\S]*parallel same-role workers[^\n]*colliding/i);
    expect(resume).toMatch(/coder_step_2_attempt_1[\s\S]*reviewer_step_2_attempt_1/);
    expect(resume).toMatch(/revision, recovery, interrupted re-dispatch, or repeated review[\s\S]*never reused/i);
    const deepPlanTemplateLabels = [
      'recursive_planner_<W>_round_1',
      'recursive_planner_<W>_round_2',
      'recursive_planner_<W>_round_3',
      'deep_plan_research_<W>_probe_1',
      'deep_plan_research_<W>_probe_2',
      'deep_plan_critic_<W>',
      'recursive_planner_<W>_synthesis',
    ];
    const deepPlanResolvedLabels = [
      'recursive_planner_1_round_1',
      'recursive_planner_1_round_2',
      'recursive_planner_1_round_3',
      'deep_plan_research_1_probe_1',
      'deep_plan_research_1_probe_2',
      'deep_plan_critic_1',
      'recursive_planner_1_synthesis',
    ];
    for (const label of [...deepPlanTemplateLabels, ...deepPlanResolvedLabels]) expect(deepPlan).toContain(label);
    expect(new Set(deepPlanResolvedLabels).size).toBe(7);
    for (const label of deepPlanResolvedLabels) expect(label).toMatch(/^[a-z0-9_]+$/);
    expect(deepPlan).toMatch(/Reserve\/check the complete set before the first spawn/i);
    expect(deepPlan).toMatch(/later deep-plan invocation[^\n]*MUST allocate another [`']?<W>[`']?/i);
    expect(deepPlan).toMatch(/Recover the original `<W>`[\s\S]*not-yet-created reserved labels/i);
    expect(deepPlan).toMatch(/task labels never select role templates/i);
    const planCriticTemplate = codexAgents.find(({ role }) => role === 'plan-critic')!.content;
    expect(planCriticTemplate).toMatch(
      /Role\/template identity is [`']plan-critic[`']; native spawn_agent dispatch MUST use the current planning workflow's unique grammar-safe [`']plan_critic_<W>[`'] invocation label/,
    );
    expect(planCriticTemplate).not.toMatch(/MUST use task_name:\s*["'`]plan_critic["'`]/);

    const spawningSkills = codexSkills.filter(({ content }) => /spawn_agent/.test(content));
    for (const { file, content } of spawningSkills) {
      expect(content, `${file} must not substitute a role directly into task_name`).not.toMatch(
        /task_name\s*:\s*(?:["'`]?<(?:name|role)>["'`]?|\$\{?(?:name|role)\}?|(?:name|role)\b)/i,
      );
    }
  });

  it('makes planner and critic templates compatible with pre-run overrides', () => {
    const planner = codexAgents.find(({ role }) => role === 'planner')!.content;
    const critic = codexAgents.find(({ role }) => role === 'plan-critic')!.content;
    for (const [role, content] of [['planner', planner], ['plan-critic', critic]] as const) {
      expect(content, role).toMatch(/For a pre-run spawn, no run ID exists/is);
      expect(content, role).toMatch(/spawn prompt MUST explicitly supply a no-run reflection key override/is);
      expect(content, role).toMatch(/use that exact key and never fabricate a run ID/is);
    }
    expect(planner).toMatch(/prerun-<task-slug>-(?:draft|final)-plan-reflection/);
    expect(critic).toMatch(/prerun-<task-slug>-plan-critique-reflection/);
  });

  it('defines equivalent host-native recursive-planner protocols and read-only boundaries', () => {
    expect(claudeRecursivePlanner).toMatch(/^---\nname: recursive-planner\n/);
    const claudeFrontmatter = sectionBetween(claudeRecursivePlanner, '---\n', '\n---');
    expect(claudeFrontmatter).toContain('tools: Glob, Grep, Read');
    expect(claudeFrontmatter).toContain(
      'mcp__plugin_software-development-team_software-development-team__team_memory_read',
    );
    expect(claudeFrontmatter).toContain(
      'mcp__plugin_software-development-team_software-development-team__team_memory_write',
    );
    const claudeTools = claudeFrontmatter.split('\n').find((line) => line.startsWith('tools:'))!;
    expect(claudeTools).not.toMatch(/Agent|Bash|team_start|team_submit_result|team_send_message/);

    expect(codexRecursivePlanner).toMatch(/^name = "recursive-planner"/);
    expect(codexRecursivePlanner).toContain('sandbox_mode = "read-only"');
    expect(codexRecursivePlanner).toContain('mcp__software_development_team__team_memory_read');
    expect(codexRecursivePlanner).not.toContain('mcp__software-development-team__');

    const envelopeOrder = [
      '"protocolVersion"',
      '"round"',
      '"readiness"',
      '"materialDelta"',
      '"request"',
      '"dossierSignature"',
      '"compactState"',
      '"dossier"',
      '"appendix"',
    ];
    const dossierFields = [
      'requirementsAndAssumptions',
      'goalsAndNonGoals',
      'currentState',
      'architectureAndDataFlow',
      'implementation',
      'risksAndSecurity',
      'testing',
      'rolloutAndRollback',
      'observability',
      'documentation',
      'acceptanceCriteria',
      'openQuestions',
    ];
    const compactFields = [
      'canonicalBrief',
      'decisionLedger',
      'evidenceLedger',
      'openQuestions',
      'counters',
      'seenRequestSignatures',
      'previousDossierSignature',
    ];
    for (const { host, content } of recursivePlannerSurfaces) {
      const envelope = sectionBetween(content, '## Exact Response Envelope', '## compactState Contract');
      let previousIndex = -1;
      for (const field of envelopeOrder) {
        const index = envelope.indexOf(field);
        expect(index, `${host} response field ${field} missing or out of order`).toBeGreaterThan(previousIndex);
        previousIndex = index;
      }
      for (const field of dossierFields) expect(content, `${host} dossier field ${field}`).toContain(field);
      for (const field of compactFields) expect(content, `${host} compact field ${field}`).toContain(field);
      expect(content).toMatch(/request.*null or exactly[\s\S]*kind.*question.*research/is);
      expect(content).toMatch(/Question and research requests are mutually exclusive/i);
      expect(content).toMatch(/caller owns normalization|caller owns normalization, authoritative signature/i);
      expect(content).toMatch(/exact, collision-safe no-run reflection key/i);
      expect(content).toMatch(/pre-run, pre-approval, read-only specialist/i);
      expect(content).toMatch(/never recurse or dispatch another agent yourself/i);
      expect(content).toMatch(/do not edit files, stage, commit, create branches\/worktrees, install dependencies/i);
      expect(content).toMatch(/do not have, request, or call `team_start`, `team_advance`, `team_submit_result`, `team_send_message`/i);
      expect(content).toMatch(/appendix.*nonempty JSON array[\s\S]*positive integers[\s\S]*no self-dependency[\s\S]*cycle/is);
    }
  });

  it('exposes valid host-native deep-plan entry points and keeps their MCP namespaces separate', () => {
    expect(claudeDeepPlan).toMatch(/^---\ndescription: [^\n]+\nargument-hint: <task description \| resume WORKFLOW_ID>\n---/);
    expect(claudeDeepPlan).toContain('$ARGUMENTS');
    expect(claudeDeepPlan).toContain('software-development-team:recursive-planner');
    expect(claudeDeepPlan).toContain('software-development-team:researcher');
    expect(claudeDeepPlan).toContain('software-development-team:plan-critic');
    expect(claudeDeepPlan).toContain(
      'mcp__plugin_software-development-team_software-development-team__team_memory_read',
    );

    expect(codexDeepPlan).toMatch(/^---\nname: deep-plan\ndescription: [^\n]+\n---/);
    for (const role of ['recursive-planner', 'researcher', 'plan-critic']) {
      expect(codexDeepPlan).toContain(`${role}.toml`);
    }
    expect(codexDeepPlan).toContain('mcp__software_development_team__team_memory_read');
    expect(codexDeepPlan).not.toContain('mcp__software-development-team__');

    for (const { host, content } of deepPlanSurfaces) {
      expect(content, `${host} empty-task bootstrap`).toMatch(/What would you like to deep-plan\?/);
      expect(content, `${host} bootstrap budget`).toMatch(/bootstrap[\s\S]*before allocating[\s\S]*does not consume the five-question budget/is);
      expect(content).toContain('team_start({ steps: appendix })');
      expect(content).toMatch(/MUST NOT call `team_start`/);
    }
  });

  it('bounds deep-plan state, checkpoints every pause, and reconstructs user decisions on resume', () => {
    const checkpointFields = [
      'workflowDiscriminator',
      'phase',
      'canonicalBrief',
      'latestDossier',
      'latestAppendix',
      'decisionLedger',
      'evidenceLedger',
      'openQuestions',
      'refinementRoundsUsed',
      'materialQuestionsUsed',
      'researchProbesUsed',
      'criticPassesUsed',
      'synthesisPassesUsed',
      'seenRequestSignatures',
      'previousDossierSignature',
      'pendingRequest',
      'validationDefects',
      'criticFindings',
    ];
    const reflectionKeys = [
      'prerun-deep-plan-<D>-round-1-reflection',
      'prerun-deep-plan-<D>-round-2-reflection',
      'prerun-deep-plan-<D>-round-3-reflection',
      'prerun-deep-plan-<D>-probe-1-reflection',
      'prerun-deep-plan-<D>-probe-2-reflection',
      'prerun-deep-plan-<D>-critic-reflection',
      'prerun-deep-plan-<D>-synthesis-reflection',
    ];
    for (const { host, content } of deepPlanSurfaces) {
      expect(content, `${host} round cap`).toMatch(/at most \*\*three refinement responses\*\*/i);
      expect(content, `${host} question cap`).toMatch(/at most \*\*five material user questions\*\*/i);
      expect(content, `${host} research cap`).toMatch(/at most \*\*two deduplicated research probes\*\*/i);
      expect(content, `${host} critic cap`).toMatch(/exactly \*\*one mandatory plan-critic pass\*\*/i);
      expect(content, `${host} synthesis cap`).toMatch(/exactly \*\*one mandatory recursive-planner synthesis pass\*\*/i);
      expect(content).toContain('deep-plan-<D>-checkpoint');
      for (const field of checkpointFields) expect(content, `${host} checkpoint field ${field}`).toContain(field);
      for (const key of reflectionKeys) expect(content, `${host} reflection key ${key}`).toContain(key);
      expect(content).toMatch(/Before yielding for a user answer, write the complete checkpoint/i);
      expect(content).toMatch(/resume <D>[\s\S]*reconstruct only from the checkpoint plus the new user input/is);
      expect(content).toMatch(/append the exact question, answer, timestamp\/provenance[\s\S]*clear `pendingRequest`/is);
      expect(content).toMatch(/user `skip`[\s\S]*explicit assumption and open question/is);
      expect(content).toMatch(/user `cancel`[\s\S]*Do not (?:dispatch|spawn) critic or synthesis/is);
      expect(content).not.toMatch(/automatic timeout|wait (?:for )?\d+ (?:seconds|minutes)/i);
    }
  });

  it('routes every operative non-cancel refinement exit through one critic and one synthesis pass', () => {
    const exitTerms = [
      'ready',
      'no material delta',
      'repeated dossier signature',
      'exhausted refinement rounds',
      'bounded_incomplete',
      'repeated signature',
      'out of budget',
    ];
    for (const { host, content } of deepPlanSurfaces) {
      const refinement = sectionBetween(content, '### Phase 1 — Bounded Refinement', '### Phase 1R');
      for (const term of exitTerms) expect(refinement.toLowerCase(), `${host} exit ${term}`).toContain(term);
      expect(refinement).toMatch(/Every non-cancel exit from refinement MUST continue to Phase 2/i);
      expect(refinement).toMatch(/Readiness is never permission to skip critique or synthesis/i);
      const criticIndex = content.indexOf('### Phase 2 — Mandatory Plan-Critic');
      const synthesisIndex = content.indexOf('### Phase 3 — Mandatory Synthesis');
      const renderIndex = content.indexOf('### Phase 4 — Render and Stop');
      expect(criticIndex).toBeGreaterThan(content.indexOf('### Phase 1 — Bounded Refinement'));
      expect(synthesisIndex).toBeGreaterThan(criticIndex);
      expect(renderIndex).toBeGreaterThan(synthesisIndex);
      expect(sectionBetween(content, '### Phase 2 — Mandatory Plan-Critic', '### Phase 3')).toMatch(/exactly once/i);
      expect(sectionBetween(content, '### Phase 3 — Mandatory Synthesis', '### Phase 4')).toMatch(/exactly once/i);
    }
  });

  it('provides exhaustive no-run researcher and critic overrides with exact reflection keys', () => {
    for (const { host, content } of deepPlanSurfaces) {
      const research = sectionBetween(content, '### Phase 1R — Standalone Research Override', '### Phase 2');
      expect(research, `${host} research no lifecycle`).toMatch(/no run ID, step ID, worktree, branch, lifecycle, or file claim exists/i);
      expect(research).toMatch(/remain read-only[\s\S]*do not edit, stage, commit, install/i);
      expect(research).toMatch(/do not call `team_submit_result`, `team_send_message`, `team_start`, `team_advance`/i);
      expect(research).toContain('prerun-deep-plan-<D>-probe-<N>-reflection');
      expect(research).toMatch(/valid JSON evidence capsule with exactly `query`, `summary`, `findings`, `sources`, and `caveats`/i);
      expect(research).toMatch(/malformed or failed probe consumes the probe/i);

      const critic = sectionBetween(content, '### Phase 2 — Mandatory Plan-Critic', '### Phase 3');
      expect(critic).toMatch(/no run exists; do not require or fabricate run\/step\/worktree context/i);
      expect(critic).toMatch(/primary workspace is read-only/i);
      expect(critic).toMatch(/do not call workflow\/result\/message tools or `team_start`/i);
      expect(critic).toContain('prerun-deep-plan-<D>-critic-reflection');
      expect(critic).toMatch(/seven structured sections/i);
      expect(critic).toMatch(/Malformed critic output consumes the one critic pass/i);
    }
  });

  it('defines semantic signatures, bounded malformed-output handling, and a graph-valid appendix', () => {
    const signatureTerms = [
      'Unicode NFKC',
      'collapse internal whitespace',
      'Case-fold natural-language',
      'Preserve case for repository paths, commands, identifiers, URLs, hashes',
      'Recursively sort object keys',
      'Sort only explicitly unordered collections',
      'Preserve architecturally meaningful order',
      'SHA-256',
    ];
    const appendixTerms = [
      'positive integers and unique',
      'exact repository-relative strings',
      'executable verification command',
      'dependencies are unique IDs present in the same appendix',
      'no step depends on itself',
      'dependency graph is acyclic',
      'repeated across steps are serialized by a dependency path',
    ];
    for (const { host, content } of deepPlanSurfaces) {
      for (const term of signatureTerms) expect(content, `${host} signature ${term}`).toContain(term);
      for (const term of appendixTerms) expect(content, `${host} appendix ${term}`).toContain(term);
      expect(content).toMatch(/(?:never trust|Ignore) self-reported[\s\S]*(?:readiness|material delta|signatures)/i);
      expect(content).toMatch(/Malformed output consumes the active round/i);
      expect(content).toMatch(/There is no uncounted correction dispatch/i);
      expect(content).toMatch(/Malformed critic output consumes the one critic pass/i);
      expect(content).toMatch(/malformed synthesis[\s\S]*do not create a hidden synthesis retry/is);
      expect(content).toMatch(/If no validated fallback exists, stop `bounded_incomplete`/i);
    }
  });

  it('keeps recursive-planner outside execution scheduling, worktrees, and the dashboard roster', () => {
    expect(dashboardAgentConstants).toMatch(
      /AGENTS\s*=\s*\['coordinator', 'planner', 'coder', 'reviewer', 'researcher', 'documentation'\]/,
    );
    expect(dashboardAgentConstants).not.toContain('recursive-planner');
    for (const { file, content } of instructions) {
      expect(content, `${file} must not admit recursive-planner to execution`).not.toContain('recursive-planner');
      expect(content, `${file} must not put deep-plan in run lifecycle`).not.toContain('deep-plan');
    }
    for (const { file, content } of agents) {
      expect(content, `${file} execution role must not delegate to recursive-planner`).not.toContain('recursive-planner');
    }
  });

  it('disambiguates lightweight plan from exhaustive recursive deep-plan on both hosts', () => {
    const terms = [
      'lightweight',
      'deep-plan',
      'exhaustive',
      'ambiguous',
      'cross-cutting',
      'high-risk',
      'recursive refinement',
      'does not run recursive refinement rounds',
    ];
    for (const content of normalPlanSurfaces) {
      for (const term of terms) expect(content).toContain(term);
      expect(content).toMatch(/pre-run and read-only[\s\S]*neither starts implementation/i);
    }
  });

  it('gives the team standalone reviewer an isolated worktree and complete dispatch context', () => {
    const begin = codexSkills.find(({ file }) => file.endsWith('/begin/SKILL.md'))!.content;
    const standalone = begin.slice(begin.indexOf('## Standalone Review Task'), begin.indexOf('## Cost Awareness'));
    expect(standalone).toMatch(/team_start[\s\S]*capture the current target branch and exact commit/is);
    expect(standalone).toMatch(/persist\W+\{targetBranch, targetCommit, path, branch\}[^\n]*before\W+admission/i);
    expect(standalone).toMatch(/## Run context[\s\S]*Run ID prefix[\s\S]*## Full step context/is);
    expect(standalone).toMatch(/Task goal[\s\S]*Step description[\s\S]*Exact files[\s\S]*Acceptance criteria[\s\S]*Dependencies/is);
    expect(standalone).toMatch(/decisions, context, and learnings[\s\S]*Prior context and user guidance/is);
    expect(standalone).toMatch(/Persisted worktree lifecycle context[\s\S]*Worktree path[\s\S]*Branch name[\s\S]*Captured target/is);
    expect(standalone).toMatch(/perform every repository read, verification command, and Git inspection inside this worktree/is);
    expect(standalone).toMatch(/do NOT call `team_submit_result`/);
  });

  it('requires complete recovered context for every resume dispatch', () => {
    const resume = codexSkills.find(({ file }) => file.endsWith('/resume/SKILL.md'))!.content;
    const checklist = resume.slice(resume.indexOf('## Spawn Context Checklist'), resume.indexOf('## Pipeline Parallelism'));
    const requiredContext = [
      'Task goal',
      'Step description',
      'Files to touch',
      'Acceptance criteria',
      'Full dependencies',
      'Verification commands',
      'Relevant memory',
      'Run ID and step ID',
      'Actual reflection prefix',
      'Prior context',
      'Tool name mapping',
      'Persisted worktree lifecycle',
    ];
    for (const field of requiredContext) expect(checklist).toContain(`**${field}**`);
    expect(resume).toMatch(/interrupted-worker re-dispatches reuse this exact persisted context/is);
    expect(resume).toMatch(/missing or inconsistent[\s\S]*do not dispatch and do not recreate/is);
    expect(checklist).toMatch(/review feedback, previous worker result\/error, user guidance, retry\/escalation history, and relevant team messages/is);
  });

  it.each(instructions)('$file defines the bounded deterministic scheduler', ({ content }) => {
    expect(content).toMatch(/maxParallel/i);
    expect(content).toMatch(/simultaneously spawned \*\*workers\*\*|simultaneously spawned workers/i);
    expect(content).toMatch(/count.*workers/is);
    expect(content).toMatch(/only the coordinator is excluded/i);
    for (const role of ['planner', 'plan-critic', 'coder', 'reviewer', 'researcher', 'documentation']) {
      expect(content).toMatch(new RegExp(`count[\\s\\S]*${role}`, 'i'));
    }
    expect(content).toMatch(/four.*permit[s]?.*three/i);
    expect(content).toMatch(/(?:absent|unknown).*?(?:conservative )?one-worker|maxParallel = 1/is);

    expect(content).toMatch(/(?:Prioritize|First reserve).*lifecycle.*(?:before|then).*pending.*plan order/is);
    expect(content).toMatch(/(?:dependencies?|dependency-complete).*?(?:fileConflicts|blocking).*?(?:exact.*(?:file|string)|claimed files).*?(?:disjoint|overlap)/is);
    expect(content).toMatch(/exact (?:planned |declared )?file-string matching|exact string matching/i);
    expect(content).toMatch(/(?:active claims?|active or same-batch).*?(?:overlap|disjoint)|(?:overlap|disjoint).*?(?:active claims?|active or same-batch)/is);

    expect(content).toMatch(/start_coding.*authoritative|authoritative.*start_coding/is);
    expect(content).toMatch(/reject(?:s|ed)?.*?(?:refresh.*(?:team_status|status).*reschedul|reschedul.*refresh)/is);
    expect(content).toMatch(/spawn.*fail.*?(?:result\.)?status\s*[:=]\s*[ `"']?blocked|(?:result\.)?status\s*[:=]\s*[ `"']?blocked.*?spawn.*fail/is);
    expect(content).toMatch(/refill.*capacity.*?(?:worker returns|worker finishes|lifecycle)/is);
    expect(content).toMatch(/no (?:separate )?server WIP cap|do not impose a server WIP cap/i);
    expect(content).toMatch(/do not (?:use )?pause, cancel|do not pause or cancel/i);
    expect(content).toMatch(/worktrees?.*never permit overlapping|overlapping.*even when using worktrees|never use (?:them|worktrees) to run overlapping/i);
  });

  it.each(instructions)('$file rejects superseded scheduling semantics', ({ content }) => {
    expect(content).not.toMatch(/first actionable step/i);
    expect(content).not.toMatch(/When a step enters REVIEWING, check if the NEXT step/i);
    expect(content).not.toMatch(/pause step N\+1|pause the conflicting step/i);
    expect(content).not.toMatch(/no hard cap on concurrent steps|no fixed cap; bounded by dependencies/i);
    // Reject only wording that authorizes overlap; compliant prohibitions such as
    // "worktrees never permit overlapping" must remain valid.
    expect(content).not.toMatch(/worktrees?\s+(?:permit|allow|authorize)\s+(?:overlap|overlapping)/i);
  });

  it.each(instructions)('$file defines a run-scoped, coordinator-owned worktree lifecycle', ({ content }) => {
    expect(content).toMatch(/mandatory.*\.worktrees\/\{runId\}\/step-\{N\}/is);
    expect(content).toMatch(/team-\{runId\}-step-\{N\}/i);
    expect(content).toMatch(/targetBranch.*git branch --show-current/is);
    expect(content).toMatch(/targetCommit.*git rev-parse HEAD/is);
    expect(content).toMatch(/capture.*target.*commit.*create/is);
    expect(content).toMatch(/Initial Pending Admission.*Create and Persist Once/is);
    expect(content).toMatch(/set_worktree[\s\S]*\{\s*targetBranch, targetCommit, path, branch\s*\}[\s\S]*before.*start_coding/is);
    expect(content).toMatch(/server persists|durable step state/is);
    expect(content).toMatch(/(?:never recapture.*create another worktree|only capture and creation)/is);
    expect(content).toMatch(/reviewer.*revision.*interrupted[\s\S]*reuse.*persisted|(?:reviewer|revision-coder|interrupted-worker).*reuse.*persisted/is);
    expect(content).toMatch(/(?:missing|inconsistent).*?(?:do not dispatch|do not recreate).*?(?:block|escalate)/is);
    expect(content).toMatch(/coder.*reviewer.*researcher.*documentation/is);
    expect(content).toMatch(/planner.*plan-critic.*pre-approval.*primary[- ]worktree.*read-only/is);
    expect(content).toMatch(/StateMachine.*(?:does not manage|tracks workflow state only).*Git/is);
  });

  it.each(instructions)('$file protects the captured merge target and cleanup lifecycle', ({ content }) => {
    expect(content).toMatch(/(?:merge only after|only after).*reviewer.*approval.*(?:switch|captured target branch).*merg(?:e|es)(?: only| there| nowhere else)/is);
    expect(content).toMatch(/git switch "\$targetBranch"/);
    expect(content).toMatch(/git merge team-\{runId\}-step-\{N\} --no-ff/);
    expect(content).toMatch(/(?:conflict|merge conflict).*git merge --abort.*preserve.*escalate/is);
    expect(content).toMatch(/never auto-resolve/i);
    expect(content).toMatch(/git worktree remove \.worktrees\/\{runId\}\/step-\{N\}[\s\S]*git branch -d team-\{runId\}-step-\{N\}/i);
    expect(content).toMatch(/(?:abandoned|unmerged)[\s\S]*git worktree remove[\s\S]*git branch -D team-\{runId\}-step-\{N\}/i);
    expect(content).toMatch(/(?:cleanup|either cleanup command).*fail.*preserve.*(?:path|branch).*error/is);
  });

  it.each(instructions)('$file rejects obsolete worktree and merge behavior', ({ content }) => {
    expect(content).not.toMatch(/optional (?:per-step )?(?:git )?worktree/i);
    expect(content).not.toMatch(/\.worktrees\/step-\{N\}/i);
    // Branch names must stay flat: git cannot create `team/x/y` while a branch named
    // `team` exists, so the old hierarchical convention could block runs.
    expect(content).not.toMatch(/team\/\{runId\}\/step-\{N\}/i);
    expect(content).not.toMatch(/team\/\$\{?runId\}?/i);
    expect(content).not.toMatch(/merge (?:into|to) (?:the )?(?:current|whatever) branch/i);
    // Do not reject the required "Never auto-resolve" prohibition above; only reject permissive automation.
    expect(content).not.toMatch(/(?:will|must|should|may|can)\s+(?:automatically|auto-)\s*resolve/i);
  });

  it.each(agents.filter(({ role }) => role === 'planner' || role === 'plan-critic'))(
    '$file keeps $role pre-approval and read-only in the primary workspace',
    ({ content }) => {
      expect(content).toMatch(/pre-approval.*read-only.*primary workspace/is);
      expect(content).toMatch(/do not create, request, or require.*worktree/is);
      expect(content).toMatch(/do not modify.*stage.*commit.*branches\/worktrees/is);
    },
  );

  it.each(agents.filter(({ role }) => role === 'coder' || role === 'documentation'))(
    '$file requires $role to mutate, verify, and commit only in supplied worktree context',
    ({ content }) => {
      expect(content).toMatch(/(?:mutating role|documentation writes)/i);
      expect(content).toMatch(/(?:supplied )?run-scoped worktree.*mandatory/is);
      expect(content).toMatch(/all repository file reads.*(?:edits|documentation writes).*verification.*git commits.*worktree/is);
      expect(content).toMatch(/never.*primary workspace.*never infer, create, or fall back/i);
      expect(content).toMatch(/missing.*context.*submit [`']?blocked/is);
      expect(content).toMatch(/verification commands/i);
      expect(content).toMatch(/commit all changes.*worktree branch/i);
    },
  );

  it.each(agents.filter(({ role }) => role === 'reviewer' || role === 'researcher'))(
    '$file keeps $role read-only in supplied worktree context and blocks missing context',
    ({ content }) => {
      expect(content).toMatch(/suppl(?:ies|ied).*worktree.*read-only.*never edit, stage, commit/is);
      expect(content).toMatch(/(?:lacks|lacks a|lacks a supplied|missing).*worktree path.*(?:submit [`']?(?:blocked|needs_revision)|stop)/is);
      expect(content).toMatch(/do not infer.*(?:fall back|primary checkout)/is);
    },
  );

  it.each(agents.filter(({ role }) => role === 'reviewer'))('$file requires reviewer commit inspection', ({ content }) => {
    expect(content).toMatch(/(?:check|checking).*coder commits.*branch/i);
  });
});
