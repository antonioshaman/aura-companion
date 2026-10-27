# Spec: UI/UX & usability enrichment of Aura's agent setup

**Date:** 2026-10-27
**Status:** Draft

## Objective

Make every Aura Companion install produce better UI/UX out of the box. Research the best open usability tooling and knowledge on GitHub. Fold it into the agent setup that touches UI: skills, Council experts and automated checks. Then ship all of it to every user, not only this server.

## Context

- UI/UX skills already in the repo: `.agents/skills/` (audit, polish, critique, normalize, adapt, clarify, harden, onboard, frontend-design, distill, delight, …).
- UI/UX skills that exist only locally on this server: `ui-ux-pro-max` and `taste-skill`.
- UI/UX Council experts: `saarinen` (visual craft), `friedman` (UX discipline) and `watson` (accessibility). They live in `~/.claude/skills/_council-experts/` and are not part of the repo.
- **Gap:** the npm package ships only `bin/`, `server/` and `dist/`. Repo skills and experts never reach an npm/Docker user.
- `packs/checks` (aura-check) is the proven way to change agent behaviour (prose lessons did not change it; checks did). It has no UI/UX rules today.
- Aura must work identically for Claude Code and Codex sessions (CLAUDE.md).

## Scope

### In scope
- A vetted research catalog of GitHub usability tooling and knowledge.
- Shipping every UI/UX skill listed above, plus the whole Council experts catalog (with its selection engine and verification canaries), with every install method.
- Enriching those skills and the three experts' knowledge with attributed, paraphrased material.
- New UI/UX rules in aura-check.
- A real rendered-UI accessibility scan as part of UI reviews.
- Coverage for web/SPA, Telegram Mini Apps and native mobile (iOS/Android guidelines).

### Out of scope
- Adding new Council experts.
- Redesigning Aura's own UI. That is a separate spec that will consume this one.

### Non-goals
- Copying third-party prompts or skills verbatim.
- Maximising the number of sources. Quality and licence-safety win over coverage.

## Stories

### Story 1: Vetted source catalog

**When** I decide what to fold into our agents, **I want to** have a catalog of the strongest GitHub usability resources with evidence about each, **so I can** pick sources on merit and licence rather than popularity.

Given the research is complete
When the catalog is reviewed
Then it lists at least 30 resources across at least 8 categories: heuristics and evaluation methods; accessibility standards and testing; automated UI checking; design systems and tokens; UX writing; visual regression; platform guidelines (web, Telegram Mini App, iOS, Android); LLM-agent UI/UX skill packs

Given any catalog entry
When it is read
Then it states the source link, licence, last-activity date, what we take from it and which agent setting receives it

Given a resource whose licence forbids redistribution or is unknown
When it is catalogued
Then it is marked "reference only" and none of its content appears in shipped files

Given a resource with no activity for more than 18 months
When it is catalogued
Then it is excluded, unless it is a canonical standard such as WCAG or Nielsen's heuristics, which is labelled as such

### Story 2: Every install gets the UI/UX toolkit

**When** someone installs Aura by any supported method, **I want to** have the full UI/UX skill set and expert knowledge available in their sessions, **so I can** get the same design quality as this server without manual copying.

Given a fresh install via npm, Docker or git clone
When the user starts a Claude Code session in any project
Then every UI/UX skill from Scope is invocable

Given the same fresh install
When the user starts a Codex session
Then the same skills are available, or the UI clearly labels any skill that requires Claude Code

Given a user who already has a personal skill with the same name
When Aura is installed or upgraded
Then the user's skill is left untouched and remains the one used

Given a third-party skill whose licence cannot be verified
When the package is built
Then that skill is excluded and the build reports why

Given a user who does not want the toolkit
When they turn it off in settings
Then new sessions start without it

### Story 3: Enriched UI/UX knowledge

**When** an agent plans, builds or reviews a UI, **I want to** apply current, sourced usability knowledge for the target platform, **so I can** catch problems that generic taste misses.

Given the enrichment is complete
When the three experts' knowledge and the shipped UI/UX skills are compared with today's versions
Then each has new, attributed guidance and every pre-existing section is unchanged

Given any new guideline
When it is read
Then it names its source and contains no verbatim passage longer than two sentences

Given a UI task for a Telegram Mini App or a native mobile screen
When the agent applies the enriched guidance
Then it uses platform-specific rules rather than web-only rules

Given two sources that contradict each other
When the guidance is written
Then the contradiction is stated with the chosen default and the reason for it

### Story 4: Usability problems caught automatically

**When** a UI change is committed or reviewed, **I want to** have machine-detectable usability problems flagged without relying on agent memory, **so I can** stop the same mistakes from recurring.

Given the new aura-check rules
When they run on a repository
Then at least 5 UI/UX rules are active, each with a source, a severity and a fix hint

Given Aura's own repository at the current main
When the new rules run
Then every finding is either a true problem or recorded in a documented baseline, and none is a false positive

Given a Council review of a change that touches UI
When the review runs
Then it includes results from an accessibility scan of the rendered UI and cites specific failures

Given a review environment where no browser can be launched
When the review runs
Then it states that the scan was skipped and why, and never reports a pass

## Boundaries

### ✅ Always
- Record the licence and source link for every external item before using it.
- Paraphrase and attribute. Keep a third-party notices file for anything shipped.
- Run typecheck and the full test suites, plus the aura-check tests, after each change.
- Verify both Claude Code and Codex sessions for anything shipped.

### ⚠️ Ask first
- Adding any runtime dependency, or growing the packed npm package beyond 15 MB.
- Changing how skills are installed into a user's home directory.
- Removing or rewriting any existing skill or expert section.
- Including a resource with a copyleft licence such as GPL or CC BY-SA.

### 🚫 Never
- Ship content whose licence forbids redistribution or is unknown.
- Overwrite or delete a user's own skills or settings.
- Let a skipped or failed accessibility scan read as a pass.
- Delete or weaken existing tests or checks to get new ones passing.

## Success Metrics

- **Before/after audit:** the same fixed sample of 3 UIs (Aura web UI, the auraco.space landing, one Telegram Mini App) is audited before and after. The enriched setup finds at least 30% more human-confirmed usability issues, and its false-positive rate does not grow.
- **Install coverage:** in a clean environment, 100% of the listed UI/UX skills are invocable after npm and Docker installs.
- **Source coverage:** at least 30 catalog entries, with zero shipped items lacking a verified licence.

## Assumptions

- (confirmed) All listed UI/UX skills are in scope and must ship to every user.
- (confirmed) "Docker install" means a new Aura server image that is built and smoke-tested in CI (no such image exists today).
- (confirmed) The 15 MB package limit applies to the packed npm tarball.
- (confirmed) Automated checks are in scope, and target platforms are web, Telegram Mini App and native mobile.
- (unconfirmed) The licences of the `ui-ux-pro-max` and `taste-skill` upstreams permit redistribution. The first research task verifies them; if not, they are replaced by attributed paraphrase.
- (confirmed) The whole Council experts catalog ships, not only the UI/UX experts (decision B).

---

*After implementing, compare results against each acceptance criterion above and list any unmet requirements.*
