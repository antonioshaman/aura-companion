# Saarinen — Visual UI Quality Review

Lens: calm interface discipline, visual hierarchy, component cohesion, opinionated polish. Scope: `README.md`, `docs/index.mdx`, `docs/guides/council-mode.mdx`.

The PR is a net improvement on rhythm — badge row halved, three ASCII grids removed, the 7-row state-pill table is now an ordered list. The compression is real, not cosmetic. What remains is residual ASCII clutter in three places, a Card hierarchy that still reads as two equal pillars rather than one featured + a tier, two stacked rules + heavy table-heavy zones that compete on the same page, and screenshot width inconsistency between README and the docs site. Type rhythm in the guide is good but suffers a double-H1 risk shared with the index.

---

## P1 findings

### 1. Two HRs framing a single section consume the calmness budget for no semantic gain

- File: `README.md:13`, `README.md` (closing rule after Council-Mode hero screenshot, implicit between `## Quick Start` and `## Self-Learning`)
- Severity: P1
- Principle: §A interface calmness (subtract until the eye can scan)
- Finding: The hero ↔ body transition uses an `---` rule, but the rest of the README has no consistent rule strategy — sections run together without rules below, while the top of the file commits to one. The single rule reads as a hanging boundary the rest of the document doesn't repay. Either commit to rules between every top-level `##` section, or remove the top one entirely and let the badges-then-H2 cadence carry the transition.
- Consequence: The eye expects more rules and doesn't get them; the surface feels half-systematised. Saarinen anti-pattern: decoration without semantic role.
- Fix: Remove the lone `---` at line 13 — the badge row already terminates the masthead visually; the `## What this is` H2 is the next pivot. Single change, no follow-on.

### 2. Card hierarchy reads as featured-plus-grid in markup but as two equal pillars on screen

- File: `docs/index.mdx:30-61`
- Severity: P1
- Principle: §A visual hierarchy discipline (the heaviest element IS the most important next action)
- Finding: The Council Mode Card is correctly promoted to `<CardGroup cols={1}>` above `## More features` + `<CardGroup cols={2}>`. But the H2 label "Featured" against "More features" is symmetric vocabulary — both read as section labels, not as a hierarchy step. On a Mintlify render the second CardGroup's first row sits visually adjacent to the featured card and the eye reads three cards in a column rather than one-featured-then-grid. The lever that's missing is verbal weight on "Featured" (e.g. "Start here" or no H2 at all, letting the cols=1 card carry on its own) and a slightly larger gap between the featured block and the grid.
- Consequence: Featured Card loses its featured-ness within one scroll. Saarinen anti-pattern: hierarchy mute — user does the design's work re-deciding what to click first.
- Fix: Either drop the "Featured" H2 (let the single-card row stand alone above the grid, with a visible white-space gap) OR rename to a directive label like "Start here" so the verbal weight matches the visual weight. Do not leave "Featured" vs "More features" as siblings.

### 3. Screenshot width inconsistency between README and docs index

- File: `README.md:2` (hero), `README.md:29` (council-mode-overview); `docs/index.mdx:10` (hero); `docs/guides/council-mode.mdx:10` (council-mode-overview)
- Severity: P1
- Principle: §B opinionated product polish (the system applies one decision everywhere)
- Finding: All four screenshot embeds use `width="100%"` — internally consistent, which is correct. But the README hero AND the second README screenshot both render full-width back-to-back with only one short paragraph between them; on a typical GitHub viewport that produces two huge images dominating the masthead before the reader hits Quick Start. The docs site (`docs/index.mdx`) is restrained (one hero, then Cards). The README is loud where docs is quiet — same content, two different polish stances.
- Consequence: README masthead reads as marketing-page; docs reads as docs. Cohesion broken across the two reader entry points. Saarinen anti-pattern: opinion applied inconsistently — the user sees two products.
- Fix: In `README.md`, demote the second screenshot (`council-mode-overview.png` at line 29) to `width="80%"` and center it, OR move it below "How to enable it" to break the back-to-back full-width stack. The hero stays 100%; the supporting shot doesn't compete with it.

---

## P2 findings

### 4. ASCII data-flow diagram in README "Architecture" section is residual monospace clutter

- File: `README.md:63-66`
- Severity: P2
- Principle: §A interface calmness; §A component cohesion
- Finding: The PR removed the Council Mode ASCII data-flow and the "What Makes It Different" ASCII grid — but the main Architecture ASCII diagram survived. It sits between the "How to enable it" screenshot and the Quick Start fence run, in a stretch of the README that's already image-heavy and code-fence-heavy. The diagram is informational but visually noisy in a section that's supposed to recede to chrome.
- Consequence: Calmness budget overdrawn in the README's middle third — image, monospace block, image, code fence, code fence. Saarinen anti-pattern: surface buzzes; eye has nowhere to rest.
- Fix: Replace the ASCII block with a one-line prose summary ("Browser ↔ Hono on Bun ↔ Claude Code/Codex CLI via WebSocket NDJSON, ports 5174/3456"). The diagram exists canonically in CLAUDE.md; README doesn't need to restate it pictorially. If the diagram must stay, demote to a Mermaid block on the docs site only — README gets prose.

### 5. README Quick Start has three code fences in a row with thin prose between

- File: `README.md:33-49`
- Severity: P2
- Principle: §A interface calmness (bound rate of visual change); §A visual hierarchy discipline (size + weight + color as separate levers)
- Finding: Three code blocks land within 17 lines — `git clone…`, then one URL line, then `Requirements:` one-liner, then `bun install -g aura-companion`, then `bunx aura-companion`. Each fence is its own visual island; three islands in a row read as "code wall" not as "three options the user picks one of." The "Or install…" / "Or run without…" prose hint is a single comment line inside the third fence, which buries the optionality inside monospace rather than calling it out.
- Consequence: User reads top-to-bottom and runs all three. The "or" branching is structurally invisible. Saarinen anti-pattern: hierarchy inverted by weight — the optional paths read identical to the canonical one.
- Fix: Collapse the second + third fences into one fence with both commands inside, and lift the "Or install the published package globally" / "Or run without installing" into prose ABOVE the fence, not as code comments INSIDE it. Two fences total in Quick Start, prose clearly marking the second as optional.

### 6. Council Mode guide's pairing table is dense relative to the surrounding rhythm

- File: `docs/guides/council-mode.mdx:48-51`
- Severity: P2
- Principle: §A interface calmness; §A visual hierarchy discipline
- Finding: The state-pill table was successfully converted to an ordered list (lines 60-69), which improves the rhythm. But the pairing table at 48-51 has THREE columns and one of them is a long-prose cell (the `When to pick` column for `claude+codex` runs to ~5 lines). Wide table with prose-heavy cells re-introduces the same density the state-pill conversion fixed. Asymmetric — one row is short, one is essay.
- Consequence: The guide's first table reads as "wall of text in a 3-col grid"; the user's eye lands on the wide cell and re-reads. Inconsistent with the calm ordered-list treatment two H2s later.
- Fix: Same treatment as the state pills — promote the two pairings to H3s (`### claude+claude (default)` / `### claude+codex (experimental)`) with a one-line summary and a "When to pick" paragraph each. Loses 1 table, gains 2 scannable subsections matching the rest of the guide.

### 7. Council Mode guide ends with two stacked tables and an artefacts code-fence in close succession

- File: `docs/guides/council-mode.mdx:72-78` (shortcuts table), `:128-141` (workspace artefacts tree), `:146-155` (troubleshooting table)
- Severity: P2
- Principle: §A interface calmness (bound rate of visual change); §B opinionated product polish
- Finding: The guide's second half compounds visual chrome — Keyboard shortcuts table → Worked example numbered list → Finding lifecycle list → Workspace artefacts ASCII tree → Troubleshooting 7-row table. The troubleshooting table itself is necessary and well-structured, but the artefacts ASCII tree at 130-139 is the same visual species as the ASCII blocks the PR removed from README. Tree-diagram-as-code-fence is the only monospace block in the guide; it stands out as an exception in a guide that's otherwise prose-and-list.
- Consequence: Guide reads quiet in the first half, busy in the second. Saarinen anti-pattern: opinion applied inconsistently across one document.
- Fix: Replace the workspace artefacts code-fence tree with a 4-row Markdown table (`Path | Written by | Purpose`) OR a 4-item definition list (`prompts/observer-system.md — …`). Either matches the prose-first stance of the rest of the guide and removes the lone monospace block.

---

## P3 findings

### 8. Double-H1 risk: page front-matter `title` plus inline H1 on the same page

- File: `docs/index.mdx:1-6`, `docs/guides/council-mode.mdx:1-6`
- Severity: P3
- Principle: §A visual hierarchy discipline (size signals scope; conflating levers makes the eye nowhere-to-land)
- Finding: Both MDX files set `title: Aura Companion` / `title: Council Mode` in front-matter AND open with `# Aura Companion` / `# Council Mode` as Markdown H1. Mintlify typically renders front-matter `title` as the page H1 — the inline `#` then becomes a second H1 (or an HTML `<h1>` after the auto-rendered one). The visual effect is two giant titles stacked; the rhythm of the page is broken before any content lands. (a11y auditor will flag the WCAG side; my lens is the visual rhythm: two big titles in a row makes the page's actual lead paragraph land below the fold.)
- Consequence: First-impression hierarchy broken; the user scrolls past the title block to find content. Saarinen anti-pattern: heaviest element duplicated, neither carries.
- Fix: Remove the inline `# Aura Companion` (line 6) from `docs/index.mdx` and `# Council Mode` (line 6) from `docs/guides/council-mode.mdx`. Front-matter `title` is canonical for Mintlify; inline H1 is a duplicate. Verify on the rendered docs site after change.

### 9. Hero screenshot alt text repeats across README + docs index, but width treatment doesn't

- File: `README.md:2`, `docs/index.mdx:10`
- Severity: P3
- Principle: §B opinionated product polish (one decision applied everywhere)
- Finding: Identical alt text ("Aura Companion main workspace with Council Mode toggle on the New Session dialog"), identical `width="100%"`. That's good cohesion on the alt-text side. But the README uses `<p align="center"><img …/></p>` while `docs/index.mdx` uses bare `<img …/>`. The HTML wrapping is asymmetric — README centers, docs left-aligns by default. Same image, different render position.
- Consequence: Reader who lands on README then clicks through to docs sees the same screenshot in a different layout slot. Minor, but cumulative polish degrades.
- Fix: Either drop the `<p align="center">` wrapper in README (let it left-align, matching docs default) OR add equivalent center treatment in `docs/index.mdx` if Mintlify supports it. One stance, applied to both.

### 10. Council Mode guide's badge / chip / banner reference style is inconsistent

- File: `docs/guides/council-mode.mdx` throughout — `BlockerBanner` (line 8, 21, 39, 75, 116, 119), `DegradedBanner` (116), `ObserverPanel` (60, 65, 116, 118), `FindingsLog` (93, 101-104), `ProviderBadges` (in README only)
- Severity: P3
- Principle: §A component cohesion (one vocabulary, applied consistently)
- Finding: Component names alternate between bold (`**BlockerBanner**` at line 39), backticks (`BlockerBanner` at line 21), and unstyled prose ("Observer panel" lowercase at line 120, "BlockerBanner" inline at 75). Same component, three typographic treatments in one document. Saarinen's component-cohesion lens applies to the documentation surface too — these names ARE the product's vocabulary; rendering them three ways suggests the writer treated them as prose, not as system tokens.
- Consequence: Reader can't tell at a glance whether `BlockerBanner` is a code symbol they'd grep for or a marketing-style proper noun. Cohesion of the doc surface breaks.
- Fix: Pick one — recommended: backticks for component class names (`` `BlockerBanner` ``, `` `ObserverPanel` ``), bold for emphasis only (e.g. **orchestrator** / **observer** roles), plain prose for descriptive references ("the observer panel"). Apply uniformly across the guide. Same rule across `README.md` and `docs/index.mdx`.

### 11. State-pill ordered list is good but loses the visual "pill" cue the table had

- File: `docs/guides/council-mode.mdx:60-69`
- Severity: P3
- Principle: §A visual hierarchy discipline (separate levers for separate semantics)
- Finding: The 7-state pill conversion from table to ordered list improves rhythm — but every state name is now wrapped in backticks (`degraded`, `blocker-found`, etc.), which renders as monospace inline code. Backticks here imply "this is a string literal you'd find in the codebase," but these are UI states the user sees as pills. The semantic is "label on a UI element," which would be better served by bold or a custom CSS class — not by monospace.
- Consequence: User who reads "the status pill says `degraded`" expects to see lowercase ASCII `degraded` in their UI, not the actual styled pill. Lever conflation: monospace is doing semantic work it shouldn't.
- Fix: Drop backticks on the state names; use bold instead (`**degraded**`). Reserve backticks for keyboard chords (`Cmd/Ctrl+Shift+O`), filenames (`observer-system.md`), and code symbols (`evidence_path`). The 5–6 places in the document where backticks are now wrapping UI labels become bold.

---

## Summary

Visual rhythm DID improve, not just change. Three monospace ASCII grids gone, one heavy table converted to ordered list, badge row halved, Council Mode promoted. The PR earns its rhythm claim.

What's still left on the table:
- One residual ASCII clutter point in README (P2) and one in the guide (P2).
- Card hierarchy "featured" reads as a sibling label, not a hierarchy step (P1).
- Screenshot width consistency across reader entry points needs one more pass (P1).
- Quick Start code-fence density (P2) is fixable in a single edit.
- Component-name typographic treatment across the guide is the cumulative-polish issue Saarinen names specifically — fixable in one find-replace sweep (P3).
- Front-matter + inline H1 doubling (P3) is a Mintlify-rendering rhythm break worth verifying on the live site.

Nothing here is a ship-blocker. P1s are the gaps between "PR successfully compressed" and "the document reads as one coherent voice across all three reader entry points." Closeable in a single follow-up commit.
