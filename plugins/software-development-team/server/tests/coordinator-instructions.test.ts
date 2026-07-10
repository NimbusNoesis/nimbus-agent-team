import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Keep this test independent of the directory Vitest was launched from.
const repositoryRoot = new URL('../../../../', import.meta.url);

const instructionFiles = [
  'codex/skills/begin/SKILL.md',
  'codex/skills/resume/SKILL.md',
  'plugins/software-development-team/commands/begin.md',
  'plugins/software-development-team/skills/resume.md',
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

describe('coordinator instruction contract', () => {
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
    expect(content).toMatch(/team\/\{runId\}\/step-\{N\}/i);
    expect(content).toMatch(/targetBranch.*git branch --show-current/is);
    expect(content).toMatch(/targetCommit.*git rev-parse HEAD/is);
    expect(content).toMatch(/capture.*target.*commit.*create/is);
    expect(content).toMatch(/Initial Pending Admission.*Create and Persist Once/is);
    expect(content).toMatch(/persist.*\{targetBranch, targetCommit, path, branch\}.*before.*start_coding/is);
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
    expect(content).toMatch(/git merge team\/\{runId\}\/step-\{N\} --no-ff/);
    expect(content).toMatch(/(?:conflict|merge conflict).*git merge --abort.*preserve.*escalate/is);
    expect(content).toMatch(/never auto-resolve/i);
    expect(content).toMatch(/git worktree remove \.worktrees\/\{runId\}\/step-\{N\}[\s\S]*git branch -d team\/\{runId\}\/step-\{N\}/i);
    expect(content).toMatch(/(?:abandoned|unmerged)[\s\S]*git worktree remove[\s\S]*git branch -D team\/\{runId\}\/step-\{N\}/i);
    expect(content).toMatch(/(?:cleanup|either cleanup command).*fail.*preserve.*(?:path|branch).*error/is);
  });

  it.each(instructions)('$file rejects obsolete worktree and merge behavior', ({ content }) => {
    expect(content).not.toMatch(/optional (?:per-step )?(?:git )?worktree/i);
    expect(content).not.toMatch(/\.worktrees\/step-\{N\}/i);
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
