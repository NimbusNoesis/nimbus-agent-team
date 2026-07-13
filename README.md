# Coding Team

A multi-agent **coding team** you can run from either [Claude Code](https://claude.ai/claude-code)
or the [OpenAI Codex CLI](https://developers.openai.com/codex/cli). A coordinator
dispatches planner, plan-critic, coder, reviewer, researcher, and documentation
agents that work autonomously through a structured plan — with shared memory, a
message bus, quality-gated review loops, and a real-time web dashboard.

For difficult work that is not ready to execute, both hosts also ship a standalone
`recursive-planner` and `deep-plan` entry point. It builds an exhaustive,
resumable planning dossier through bounded refinement without starting a team run
or modifying the repository.

Both hosts run the **same** MCP server ([`plugins/software-development-team/server`](plugins/software-development-team/server));
only the host-specific glue differs. They can be installed side by side.

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json              Claude Code marketplace manifest ("Erik Agents")
├── plugins/
│   └── software-development-team/    The Claude Code plugin
│       ├── agents/                   Agent definitions (.md + YAML frontmatter)
│       ├── commands/                 Slash commands (begin, deep-plan, status, memory, resume, plan, research, review)
│       ├── hooks/                    SessionStart pre-warm hook
│       └── server/                   Host-agnostic MCP server (SQLite + bus + memory + dashboard)
└── codex/                            The OpenAI Codex CLI distribution
    ├── agents/                       Role templates used in spawn prompts (.toml)
    ├── skills/                       Skills (begin, deep-plan, status, memory, resume, plan, research, review)
    ├── install.sh                    Wires the above into ~/.codex
    ├── test-install.sh               Codex installer/configuration smoke test
    └── config.snippet.toml           MCP server config block
```

The `codex/` distribution is **additive** — it reuses `plugins/software-development-team/server`
unchanged and does not modify or disable the Claude Code plugin.

## Run it in Claude Code

Install via the marketplace (the plugin is self-building — the MCP server compiles
itself on first launch, no manual build step):

```bash
claude
> /begin Implement a REST API for user management with CRUD endpoints
> /deep-plan Design a zero-downtime multi-tenant data migration
```

See [`plugins/software-development-team/README.md`](plugins/software-development-team/README.md)
for the full feature list, architecture, and MCP tool reference.

## Run it in OpenAI Codex CLI

From a checkout of this repo:

```bash
sh codex/install.sh
codex
> $begin Implement a REST API for user management with CRUD endpoints
> $deep-plan Design a zero-downtime multi-tenant data migration
```

See [`codex/README.md`](codex/README.md) for install details, the skill list,
and how the Codex port maps to the Claude Code plugin.

To validate the Codex distribution without changing your normal configuration:

```bash
sh codex/test-install.sh
```

## Deep planning without execution

Use `/deep-plan <task>` in Claude Code or `$deep-plan <task>` in Codex for an
ambiguous, cross-cutting, architecture-heavy, security-sensitive, migration-sensitive,
or otherwise high-risk task. The main session transparently controls at most three
`recursive-planner` refinement passes, five one-at-a-time material questions, and two
deduplicated research probes. Every non-cancel path then receives exactly one
plan-critic pass and one non-interactive synthesis pass.

The controller stores only compact canonical state, so a paused workflow can be
continued with `resume <workflow-id>`. Reply `skip` to retain a question as an
explicit assumption/open question, or `cancel` to return the latest partial dossier
without critique or synthesis. The final artifact contains requirements and
assumptions, architecture/data flow, file-level implementation steps, dependencies,
security and risk analysis, testing, rollout/rollback, observability, documentation,
acceptance criteria, and open questions. It ends with a validated JSON steps array
that can later become the `steps` argument to `team_start`; deep planning itself
never calls `team_start`, creates a worktree, or starts implementation.

`recursive-planner` is a one-pass, pre-run read-only helper. It is deliberately not
an execution worker or dashboard status card; recursion, checkpoints, questions,
research, critique, and convergence remain owned by the main-session controller.

## How it works

```
                     User
                      |
                  $begin
                      |
                 Coordinator
        /      |       |        |        \
   Planner  Coder  Reviewer  Researcher  Documentation
   (+ Plan-Critic adversarial review of the plan)
        \      |       |        |        /
              MCP Server (SQLite + bus + memory)
                      |
                  Dashboard (WebSocket)
```

- **Coordinator** — runs in the main session; assesses scope, manages the plan,
  dispatches agents, handles escalations.
- **Planner / Plan-Critic** — produce a structured step plan and adversarially
  review it before execution.
- **Recursive Planner** — performs one read-only deep-plan refinement or synthesis
  pass; the main session owns bounded recursion and user interaction.
- **Coder / Reviewer** — implement each step and gate it through review (up to 3
  revision retries) before approval.
- **Researcher / Documentation** — investigate unknowns and maintain docs.
- **MCP Server** — tracks run state, the message bus, and shared memory across five
  namespaces; serves the live dashboard. Backed by in-memory SQLite (sql.js).

Run state and memory persist to a `.team/` directory in your project (gitignored).

## Development

The shared server is the only compiled component:

```bash
cd plugins/software-development-team/server
npm install
npx tsc --noEmit     # type check
npx tsup             # build (ESM output to dist/)
npx vitest run       # run tests
```

When changing coordinator logic or an agent's instructions, update **both** the
`plugins/software-development-team/` source and its `codex/` counterpart so the two
hosts stay in sync (the `server/` is shared, so server changes apply to both
automatically).

## License

MIT
