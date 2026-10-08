# Observer-reply replay fixtures (P3/B1, EC-6)

Browser-out `assistant` / `result` frames of one real observer turn per
provider, captured from `~/.companion/recordings` (read-only) by
`scripts/aura-diet/extract-observer-reply-fixtures.py`. Redaction: workspace
root → `/workspace`, thinking signatures blanked.

| File | Provider | Source turn | Content |
|---|---|---|---|
| `claude-legacy-turn.jsonl` | claude (opus-4-8) | `council-plan` re-wake, 2026-09-20 | verbatim: observer `Write`s the review file, replies with prose |
| `claude-reply-turn.jsonl` | claude | same turn | review `Write` removed; final text = the 6 findings that turn really wrote |
| `codex-legacy-turn.jsonl` | codex (gpt-5.5) | `diet-A2` review, 2026-09-28 | verbatim: observer `Edit`-adds the review file, replies with prose |
| `codex-reply-turn.jsonl` | codex | same turn | review `Edit` + its `tool_result` removed; final text = the turn's STOP finding |

The `*-reply-turn` files are the B1 contract (bare findings array as the final
message). No production observer ran the B1 prompt before these fixtures were
cut, so the frame SHAPES are captured and only the final text is substituted.
The codex recorded `Edit` carries no file content; its finding is reconstructed
from the labelled corpus (`diet-A2-103`, a known false-positive STOP — the text
does not need to be true, only realistic).

## Group-less review files (AuraBench BENCH-H)

| File | Source | Content |
|---|---|---|
| `codex-groupless-review-schema.md` | `/root/om_event_bot/.council/reviews/spawn-codex-observer.md`, 2026-09-30 | verbatim: codex observer wrote a full-schema review under the GROUP-LESS name, self-reporting `observer_model: "gpt-5-codex"` |
| `codex-groupless-review-native.md` | `/root/aura-companion/.council/reviews/spawn-codex-observer.md`, 2026-09-08 | verbatim: codex-native shape (no `schema_version` / model / `reviewed_at`) under the group-less name |

Both name `spawn-codex-observer.md` with no `grp_…` segment, the shape seen in
4/16 bench pairs. Used by `observer-reply.test.ts` to pin host adoption.
