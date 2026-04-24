# Aura Companion

A self-learning web UI for Claude Code & Codex. Every session makes it smarter.

Built on [Vibe-Companion](https://github.com/nikolaiklein/Vibe-Companion) with an adaptive knowledge base, Carmack Council review system, and a feedback loop that accumulates project intelligence over time.

## What Makes It Different

Regular AI coding companions start from scratch every session. Aura Companion **remembers**:

- **Patterns** — approaches that work well in your codebase
- **Gotchas** — tricky edge cases and surprising behaviors
- **Decisions** — architectural choices and their rationale
- **Anti-patterns** — mistakes to never repeat

Three skill layers work together:

```
┌──────────────────────────────────────────────────────────────┐
│  Carmack Council          Architecture + Review + Testing    │
│  6 skills: plan, review, implement, spec, test, self-improve│
├──────────────────────────────────────────────────────────────┤
│  Self-Learning            Adaptive Knowledge Base            │
│  5 skills: prime, learn, self-reflect, evolve, review-with-kb│
├──────────────────────────────────────────────────────────────┤
│  Design & UX              18 skills from impeccable          │
│  frontend-design, animate, audit, harden, polish, ...        │
└──────────────────────────────────────────────────────────────┘
```

**29 skills total.** Design for beautiful UIs. Council for rigorous engineering. Self-learning to get smarter every day.

## Quick Start

```bash
# Clone
git clone https://github.com/antonioshaman/aura-companion.git
cd aura-companion

# Install & run
cd web && bun install && bun run dev
```

Open http://localhost:5174 in your browser.

**Requirements**: [Bun](https://bun.sh/) >= 1.0, Claude Code CLI or Codex CLI.

## How the Self-Learning Works

```
Session Start          During Work              Session End
     │                      │                        │
  /prime ──→ loads      /learn ──→ captures     /self-reflect ──→ extracts
  relevant   gotchas &   insights    on the      learnings from    the whole
  knowledge  patterns    instantly    fly         session           session
     │                      │                        │
     └──────────────────────┴────────────────────────┘
                            │
                    .agents/knowledge/
                    ├── patterns.jsonl
                    ├── gotchas.jsonl
                    ├── decisions.jsonl
                    ├── anti-patterns.jsonl
                    ├── codebase-facts.jsonl
                    └── api-behaviors.jsonl
```

Over time, `/evolve` promotes recurring patterns into `CLAUDE.md` rules and prunes stale entries. The system gets better the more you use it.

See [SELF-LEARNING.md](SELF-LEARNING.md) for the full guide.

## Architecture

```
Browser (React 19) ←→ WebSocket ←→ Hono Server (Bun) ←→ WebSocket (NDJSON) ←→ Claude Code CLI
     :5174              /ws/browser/:id        :3456        /ws/cli/:id         (--sdk-url)
```

- **Backend**: Hono on Bun (port 3456)
- **Frontend**: React 19 + Zustand + TailwindCSS (port 5174)
- **Monorepo**: `web/` (main app), `landing/`, `relay/`, `platform/`
- **Testing**: Vitest with axe accessibility scans
- **State**: Session persistence to `$TMPDIR/vibe-sessions/` — survives restarts

## All 29 Skills

### Self-Learning (5 skills)

| Skill | Description |
|-------|------------|
| `/prime` | Load relevant knowledge before starting work. Auto-filters by branch and modified files |
| `/learn` | Quick-capture a learning mid-session without breaking flow |
| `/self-reflect` | End-of-session reflection — extracts learnings, prunes stale entries |
| `/evolve` | Meta-skill: promotes patterns to CLAUDE.md, prunes stale, finds knowledge gaps |
| `/review-with-kb` | Code review cross-referenced with accumulated knowledge base |

### Carmack Council (6 skills)

Based on John Carmack's engineering philosophy. A council of domain experts reviews your work.

| Skill | Description |
|-------|------------|
| `/council-plan` | Architect features with 9 domain experts before writing code |
| `/council-review` | Deep multi-perspective code review with 10 experts (security, refactoring, UX, backend, database, deploy, LLM, UI, testing) |
| `/council-implement` | Execute council plans task-by-task with per-task expert guidance |
| `/spec-writer` | Generate structured specs with Job Stories + Gherkin acceptance criteria |
| `/test-architect` | Audit test quality, detect AI shortcut patterns, specify tests before implementation |
| `/self-improvement` | Continuous learning: logs errors, corrections, and feature requests |

**Council experts include:** Troy Hunt (security), Martin Fowler (refactoring), Kent Beck (testing), Brandur Leach (databases), Simon Willison (LLM pipelines), Karri Saarinen (UI), Vitaly Friedman (UX), and specialized Telegram, Backend, and Deploy experts.

### Design & UX (18 skills from [impeccable](https://github.com/pbakaus/impeccable))

| Skill | Description |
|-------|------------|
| `/frontend-design` | Production-grade UI with distinctive aesthetics |
| `/adapt` | Responsive design across screens and platforms |
| `/animate` | Purposeful animations and micro-interactions |
| `/audit` | Comprehensive quality audit (a11y, performance, theming) |
| `/bolder` | Amplify safe designs for visual impact |
| `/clarify` | Improve UX copy and error messages |
| `/colorize` | Add strategic color to monochromatic features |
| `/critique` | Design evaluation from UX perspective |
| `/delight` | Add moments of joy and personality |
| `/distill` | Strip designs to their essence |
| `/extract` | Consolidate reusable components and patterns |
| `/harden` | Better error handling, i18n, edge cases |
| `/normalize` | Align with design system consistency |
| `/onboard` | Improve onboarding flows and empty states |
| `/optimize` | Performance improvements (loading, rendering) |
| `/polish` | Final quality pass (alignment, spacing, details) |
| `/quieter` | Tone down overly bold designs |
| `/teach-impeccable` | One-time setup for persistent design guidelines |

## Recommended Workflow

### Feature Development

```
/council-plan          # Plan with domain experts
/prime                 # Load relevant knowledge
                       # ... implement ...
/learn <insight>       # Capture learnings as you go
/review-with-kb        # Knowledge-informed review
/council-review        # Deep expert review
/self-reflect          # Capture session learnings
```

### Bug Fix

```
/prime <area>          # What do we know about this area?
                       # ... fix ...
/learn <gotcha>        # Why did this break?
/self-reflect          # Store for next time
```

### Monthly Maintenance

```
/evolve all            # Promote patterns, prune stale, find gaps
/test-architect audit  # Check test quality
```

## Knowledge Base Format

Each knowledge entry is a JSONL line:

```json
{
  "id": "pat-001",
  "type": "pattern",
  "fact": "WebSocket bridge must handle both NDJSON and JSON-RPC protocols",
  "recommendation": "Always test protocol changes against both backends",
  "confidence": "high",
  "provenance": [{"source": "codebase", "reference": "web/server/ws-bridge.ts"}],
  "tags": ["websocket", "protocol"],
  "affectedFiles": ["web/server/ws-bridge.ts"],
  "createdAt": "2026-04-24T00:00:00Z"
}
```

## Development

```bash
# Dev server (backend + frontend)
make dev

# Type check
cd web && bun run typecheck

# Run tests
cd web && bun run test

# Build for production
cd web && bun run build && bun run start
```

## File Structure

```
.agents/
├── knowledge/              # Self-learning knowledge base (JSONL)
│   ├── patterns.jsonl
│   ├── gotchas.jsonl
│   ├── decisions.jsonl
│   ├── anti-patterns.jsonl
│   ├── codebase-facts.jsonl
│   └── api-behaviors.jsonl
└── skills/                 # 29 agent skills
    ├── prime/              # Self-learning: load knowledge
    ├── learn/              # Self-learning: capture insight
    ├── self-reflect/       # Self-learning: session reflection
    ├── evolve/             # Self-learning: meta-improvement
    ├── review-with-kb/     # Self-learning: KB-informed review
    ├── council-plan/       # Carmack: architecture planning
    ├── council-review/     # Carmack: expert code review
    ├── council-implement/  # Carmack: guided implementation
    ├── spec-writer/        # Carmack: structured specs
    ├── test-architect/     # Carmack: test quality
    ├── self-improvement/   # Carmack: continuous learning
    ├── frontend-design/    # Design: UI creation
    └── ...                 # 16 more design skills
web/
├── server/                 # Hono + Bun backend
└── src/                    # React 19 frontend
```

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Use commitizen format for commits
4. Run tests before pushing (`cd web && bun run typecheck && bun run test`)
5. Open a PR

The knowledge base (`.agents/knowledge/`) is project-specific — fork it and let it grow with your codebase.

## Attribution

- [Vibe-Companion](https://github.com/nikolaiklein/Vibe-Companion) by The Vibe Company (MIT License) — web UI foundation
- [impeccable](https://github.com/pbakaus/impeccable) by Paul Bakaus — 18 design skills
- [Carmack Council](https://github.com/antonioshaman/carmack-council) — 6 engineering review skills
- Self-learning inspired by [metaswarm](https://github.com/dsifry/metaswarm) and [ChristopherA's seed prompt](https://gist.github.com/ChristopherA/fd2985551e765a86f4fbb24080263a2f)

## License

MIT
