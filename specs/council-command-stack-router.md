# Spec: Auto-stack-detection router for council slash commands

## Problem

The user has six parallel skills on disk:
- `~/.claude/skills/council-plan` (Python/aiogram stack)
- `~/.claude/skills/council-plan-aura` (Bun/Aura stack)
- `~/.claude/skills/council-implement` + `-aura` pair
- `~/.claude/skills/council-review` + `-aura` pair

The user must remember which suffix matches the current workspace. Typing `/council-plan` in an Aura workspace seats Python experts (Brandur Leach on PostgreSQL when there is no Postgres, aiogram expert when there is no Python) and produces an unusable plan. Typing `/council-plan-aura` in a Python workspace inverts the same failure. A screenshot from a parallel agent session shows that agent ASKING the user which variant to use — exactly the manual-routing burden this spec eliminates.

## Goal

The three suffixless commands (`/council-plan`, `/council-implement`, `/council-review`) become routers that auto-detect the workspace stack and dispatch the correct council. The `-aura` commands continue to work for explicit override. Users in a known stack never see a "which variant?" prompt again; users in an unknown stack see a loud refusal naming the markers checked.

## Job Stories

**JS-1.** *When* a developer is in an Aura/Bun workspace (`web/package.json` with `name: "aura-companion"` OR `dependencies.hono` present OR `web/server/ws-bridge.ts` on disk), *I want* `/council-plan` to dispatch the Aura council seats (React/Web UI, Bun/Hono/TS Backend, FS-JSON Persistence, Realtime/NDJSON, Subprocess, a11y, Docker+GHA, plus the cross-stack seats), *so I can* type one command without remembering the suffix.

**JS-2.** *When* a developer is in a Python/aiogram workspace (`pyproject.toml` mentioning `aiogram` OR `requirements.txt` containing an `aiogram` line + a `bot/` directory), *I want* `/council-plan` to dispatch the Python council seats (Backend/Python Expert, Brandur Leach on PostgreSQL/Alembic, systemd/VPS Deploy, Telegram UX Expert, plus the cross-stack seats), *so I can* type one command without remembering the suffix.

**JS-3.** *When* a developer is in a workspace that matches neither stack profile, *I want* `/council-plan` to refuse and list which markers it checked + what it found, *so I can* either correct the workspace setup OR override with an explicit `-aura` invocation.

## Acceptance Criteria (Gherkin)

### Aura detection (JS-1)

- **AC-1.1** Given `web/package.json` exists at the workspace root AND its `name` field equals `"aura-companion"`, when the user invokes `/council-plan`, then the skill dispatches the Aura council variant.
- **AC-1.2** Given `web/package.json` exists at the workspace root AND its `dependencies` object contains a `"hono"` key, when the user invokes `/council-plan`, then the skill dispatches the Aura council variant.
- **AC-1.3** Given `web/server/ws-bridge.ts` exists on disk at the workspace root, when the user invokes `/council-plan`, then the skill dispatches the Aura council variant.
- **AC-1.4** Given any of the Aura markers above match AND a `pyproject.toml` is ALSO present at the workspace root, when the user invokes `/council-plan`, then the skill refuses with an ambiguity error naming both detected stacks rather than silently choosing one.

### Python detection (JS-2)

- **AC-2.1** Given `pyproject.toml` exists at the workspace root AND its content contains the literal substring `aiogram`, when the user invokes `/council-plan`, then the skill dispatches the Python council variant.
- **AC-2.2** Given a `bot/` directory exists at the workspace root AND a `requirements.txt` at the root contains a line matching `^aiogram\b`, when the user invokes `/council-plan`, then the skill dispatches the Python council variant.
- **AC-2.3** Given a Python marker matches AND NO Aura marker matches, when the user invokes `/council-plan`, then the skill dispatches the Python council without prompting the user.

### Unknown / refusal (JS-3)

- **AC-3.1** Given the workspace matches neither the Aura nor the Python markers, when the user invokes `/council-plan`, then the skill refuses with a message that (a) names each marker it checked, (b) names what it found at the workspace root, and (c) suggests explicit `/council-plan-aura` or `/council-plan` (Python variant) as overrides.
- **AC-3.2** Given the refusal message is shown, when the user reads it, then they can determine within 10 seconds why detection failed (no nested logs, no stack-trace UI, no internal field names — plain English citing real paths).
- **AC-3.3** Given the refusal is emitted, when the skill exits, then it does NOT silently fall back to one of the two known councils.

### Backwards compatibility (cross-cutting)

- **AC-4.1** Given the user types `/council-plan-aura` explicitly, when the skill loads, then it executes the Aura variant directly without re-running the router (the suffixed command remains a first-class entry point).
- **AC-4.2** Given the user types `/council-plan` (Python suffixless variant before this change), when the skill loads after this change, then auto-detection runs and dispatches the correct variant.
- **AC-4.3** Same backwards-compat pairs for `council-implement` ↔ `council-implement-aura` and `council-review` ↔ `council-review-aura`.

### Output consistency

- **AC-5.1** Given any of the three router commands dispatches a variant, when the variant runs, then it produces the same output artifacts (PLAN file, implementation log, FINAL-REVIEW.md) at the same paths as the suffixed variant would have — no router-introduced wrapper directories.

## Boundaries

### ✅ Always

- Detect stack via canonical workspace markers (Aura: `web/package.json` + `name === "aura-companion"`, OR `dependencies.hono`, OR `web/server/ws-bridge.ts`; Python: `pyproject.toml` containing `aiogram`, OR `requirements.txt` with `aiogram` line + `bot/` dir).
- Refuse loudly on ambiguous workspace (multiple stacks detected) — never guess.
- Emit refusal text naming every marker checked + what was found.
- Treat detection as workspace-cwd-relative — the cwd the skill was invoked from is the workspace root.

### ⚠️ Ask first

- If detection succeeds but the workspace has a `.council-stack-override` marker file with a different value, surface the conflict and ask which to honor (allow explicit user override of auto-detection without inventing a stack).
- Adding new stacks beyond Aura + Python — open a separate spec.

### 🚫 Never

- Silently default to a stack when detection is ambiguous or missing — refusal is the only acceptable failure mode.
- Rewrite, rename, or delete the `-aura` SKILL.md files on disk — the router approach preserves them as first-class commands.
- Cache detection result across invocations — re-run detection every call so workspace changes are picked up immediately.
- Use `gh repo view` or network calls for detection — stack-marker checks are filesystem-only.

## Affected files

Three SKILL.md files gain a Phase 0 stack-detection step:
- `~/.claude/skills/council-plan/SKILL.md`
- `~/.claude/skills/council-implement/SKILL.md`
- `~/.claude/skills/council-review/SKILL.md`

The three `-aura` SKILL.md files stay unchanged — they remain explicit entry points. Detection logic in each router runs BEFORE that skill's existing Phase 1 (Context Gathering).

## Assumptions (unconfirmed)

- The two stacks (Aura/Bun, Python/aiogram) are the only stacks in scope today. Other stacks (e.g., a future Go/Rust workspace) would require new variants + new detection rules in a follow-up spec.
- The user invoking `/council-plan` is always running Claude Code in the workspace cwd that contains the stack markers. Cross-workspace invocations (e.g., running from `/root/` against a sub-repo) are out of scope.
- The refusal text format follows existing Aura "feedback_consumer_path_drift_before_silent_claim" discipline: name what was checked + what was found, then suggest an explicit override path.

## Success metrics

- User reports zero "council seated wrong experts" failures across 4+ planning sessions after this lands.
- The parallel-session screenshot the user shared today — where another agent asked "which command?" — no longer reproduces after that agent is upgraded.

## Self-verification footer

After implementing, compare results against each acceptance criterion above and list any unmet requirements. Specifically verify: (a) the Aura/Python detection markers ALL fire on real workspaces (not just contrived test dirs); (b) the refusal path produces text a non-expert reader understands; (c) `/council-plan-aura` still works directly without going through the router; (d) all three router commands behave identically — same detection, same refusal, same dispatch shape.
