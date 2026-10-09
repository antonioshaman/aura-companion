# DRAFT — landing block "What we measured" (not wired, not published)

Status: draft for the human's decision (ASK-FIRST). Not imported by
`landing/src/App.tsx`; nothing here is deployed. Every number has a footnote
pointing at a row of `docs/aurabench/REPORT.md` (final D3: 41 tasks, 3 reps
on the 13 diverging tasks; Codex variants partial). If a number changes,
update it here from the same row.

---

## We benchmark Aura against naked agents, and publish what does not work

On 41 real Aura PRs replayed as tasks, naked Claude Code solved 87%[^1].
Adding Aura's layers did not raise that rate[^2], and each layer adds
cost: knowledge +35%, observer 2.4×, full council 2.9× per task[^3].
The full council stack did worse than the naked agent on security and
refactor tasks[^4].

What did pay off:

- **Slimmer standing context.** The control-file diet cut the context loaded
  at session start by 28% (≈ 9.5 K tokens) and API-equivalent cost by 12%,
  with no measured loss in solved tasks[^5].
- **Smaller review panels.** A 2–4-seat Council review found as many known
  defects as the 11-seat panel (10–12 of 18 vs 10 of 18) at 30–40% of
  the cost[^6].

Full method, confidence intervals and raw data: `docs/aurabench/REPORT.md`.

[^1]: REPORT.md → R1, row A, task-weighted success: 87%, 95% CI 76–96%.
[^2]: REPORT.md → R1, Lift column for C/D/E: +1 / +0 / −6 pp vs A, every CI spans 0; R1s without the harness-artefact task: −2 / −2 / −8 pp.
[^3]: REPORT.md → R1 "Mean cost": A $0.63, C $0.85, D $1.53, E $1.82.
[^4]: REPORT.md → R2 rows security (A 4/4, E 1/4) and refactor (A 5/8, E 3/8); R3 D→E −6 pp (CI −13…+0).
[^5]: REPORT.md → "Layer by layer", row Diet; DIET-AB.md → Standing context, Cost table (C+D −12.4%, CI excludes 0), D rerun 4/6 vs 4/6.
[^6]: REPORT.md → "Layer by layer", row Council review panel size; COUNCIL-PANEL.md → Totals.

---

Wording note: the lift is **not significant** (41 tasks; CIs span 0 for every
layer). Do not shorten "did not raise" to a positive claim. The E result on
security/refactor rests on 4 and 8 cells: say "did worse on", not "breaks".
Codex results (B/F/H) are omitted here on purpose: partial reps and unpriced
cost (REPORT.md, top note and §H).
