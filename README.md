# Coding Team

A multi-agent **coding team** you can run from either [Claude Code](https://claude.ai/claude-code)
or the [OpenAI Codex CLI](https://developers.openai.com/codex/cli). A coordinator
dispatches planner, plan-critic, coder, reviewer, researcher, and documentation
agents that work autonomously through a structured plan — with shared memory, a
message bus, quality-gated review loops, and a real-time web dashboard.

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
│       ├── commands/begin.md         Coordinator entry point (/begin)
│       ├── skills/                   Slash-command skills (status, memory, resume, plan, research, review)
│       ├── hooks/                    SessionStart pre-warm hook
│       └── server/                   Host-agnostic MCP server (SQLite + bus + memory + dashboard)
└── codex/                            The OpenAI Codex CLI distribution
    ├── agents/                       Agent definitions (.toml)
    ├── skills/                       Skills (begin, status, memory, resume, plan, research, review)
    ├── install.sh                    Wires the above into ~/.codex
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
```

See [`plugins/software-development-team/README.md`](plugins/software-development-team/README.md)
for the full feature list, architecture, and MCP tool reference.

## Run it in OpenAI Codex CLI

From a checkout of this repo:

```bash
sh codex/install.sh
codex
> /begin Implement a REST API for user management with CRUD endpoints
```

See [`codex/README.md`](codex/README.md) for install details, the slash-command
list, and how the Codex port maps to the Claude Code plugin.

## How it works

```
                     User
                      |
                  /begin
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
