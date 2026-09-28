# Judge calibration

Human ground-truth labels the harness scores judges against — the anchor that
keeps "LLM-as-judge" honest rather than self-congratulatory.

## `human-labels.jsonl` — human TRUE/FALSE/missed verdicts

Written by `eval:label-ingest` (`label-ingest-runner.ts`), which parses a sheet a
human ticked offline (rendered by `eval:label-sheet`) back into `EvalLabelRecord`s.
Append-only JSONL, last-write-wins by record `id` (see `parseLabelLog`), so
re-ingesting an edited sheet is idempotent. `labeled_at` is the **server clock**,
never the human's prose.

Each record joins to an observer finding by `finding_id` (`efnd_<hex>`):

- `verdict: "true_positive" | "false_positive"` — carries a `finding_id` matching
  the emitted finding's `id`.
- `verdict: "expected_blocker_missed"` — has **no** `finding_id` (it names a
  blocker the observer never surfaced); it feeds the recall denominator only.

The file is created on first ingest (the runner `mkdir`s its parent); this README
keeps the convention path stable in version control before then.

## Filling the queue from recordings (`eval:label-export`)

`eval:label-sheet` needs each workspace's `.council/reviews/`, which is
overwritten per checkpoint. `eval:label-export` instead recovers every observer
review from protocol recordings (default `~/.companion/recordings/`, read-only;
point `--recordings` at a copy), keeps the last write per checkpoint, drops
findings already present in any `--labels` log (this file by `finding_id`, or a
hand-kept log by `checkpoint_id` + `severity` + `evidence_path`), and triages
the rest (`label-triage.ts`) into two sheets that `eval:label-ingest` reads back:

- **Decisions → human** (`--out`). Product / policy choices (data retention,
  who may self-serve, trade-offs) framed as "now → option A (keep) / option B
  (adopt the observer's recommendation) → what is right". Tick `A`, `B` or
  `SKIP`; A ingests as `false_positive`, B as `true_positive`.
- **Code claims → orchestrator** (`--out-orchestrator`, default
  `<out>.orchestrator.md`). Each claim shows the code at the checkpoint (last
  commit at-or-before the review on HEAD, else on any branch — never a later
  commit, which may hold the fix) and the code now, both from the recording's
  `cwd`. Use `--workspace-map /root/aura-companion=<clone>` to read a clone
  instead of a production checkout. Ingest with
  `--labeler orchestrator-<session>`.
- **INFO / no assertion** is dropped (counted).

Precision is always printed with its label source (`human` / `orchestrator` /
`unknown`, from `labeled_by` or `labeler`); orchestrator labels never count as
human confirmation.

It ends with the sufficiency verdict (also printed by `eval:scorecard`): below
100 labeled STOPs, "Observer is useful" is **unproven** and the
"STOP precision > 90%" gate is **not evaluated**.
