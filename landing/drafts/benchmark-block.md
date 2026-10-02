# DRAFT — landing block "What we measured" (not wired, not published)

Status: draft for the human's decision (ASK-FIRST). Not imported by
`landing/src/App.tsx`; nothing here is deployed. Every number has a footnote
pointing at a row of `docs/aurabench/REPORT.md` (interim, 17 tasks × 1 rep).
If the final D3 run changes a number, update it here from the same row.

---

## We benchmark Aura against naked agents, and publish what does not work

On 17 real Aura PRs replayed as tasks, naked Claude Code solved 94%[^1].
Adding Aura's layers did not raise that rate[^2], and each layer adds
cost: knowledge +41%, observer 2.5×, full council 3.0× per task[^3].

What did pay off:

- **Slimmer standing context.** The control-file diet cut the context loaded
  at session start by 28% (≈ 9.5 K tokens) and API-equivalent cost by 12%,
  with no measured loss in solved tasks[^4].
- **Smaller review panels.** A 2–4-seat Council review found as many known
  defects as the 11-seat panel (10–12 of 18 vs 10 of 18) at 30–40% of
  the cost[^5].

Full method, confidence intervals and raw data: `docs/aurabench/REPORT.md`.

[^1]: REPORT.md → R1, row A: 16/17 (94%), 95% CI 82–100%.
[^2]: REPORT.md → R1, Lift column for C/D/E (+0 / +0 / −12 pp vs A, CIs span 0); R1s without the harness-artefact task.
[^3]: REPORT.md → R1 "Mean cost": A $0.68, C $0.96, D $1.72, E $2.02.
[^4]: REPORT.md → "Layer by layer", row Diet; DIET-AB.md → Standing context, Cost table (C+D −12.4%, CI excludes 0), D rerun 4/6 vs 4/6.
[^5]: REPORT.md → "Layer by layer", row Council review panel size; COUNCIL-PANEL.md → Totals.

---

Wording note: the lift is **not significant** (17 tasks, 1 rep). Do not
shorten "did not raise" to a positive claim. If stage 2 / BENCH-H later shows
a significant lift on some class, add it as its own sentence with its row.
