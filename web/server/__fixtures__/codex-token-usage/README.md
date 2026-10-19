# Codex token-usage replay fixtures (W6, EC-6)

Inbound CLI frames (`dir=in`, `ch=cli`) of real Codex app-server turns,
captured read-only from `~/.companion/recordings/` for session
`17fbf63f-0bea-490e-a0fb-62f6107b39ae` (gpt-6.1-sol, 2026-10-14/15).
Only `turn/started`, `thread/tokenUsage/updated` and `turn/completed` frames
are kept; `turn.items` is emptied (it carried model output text). The
token counters are verbatim.

| File | Source recording | Shape it pins |
|---|---|---|
| `17fbf63f-9d4486.jsonl` | `..._2026-10-15T14-11-46.580Z_9d4486.jsonl` | every frame arrives twice (dup `total`), resume replay of the previous turn's usage before `turn/started` |
| `17fbf63f-cfdb84.jsonl` | `..._2026-10-14T09-20-59.584Z_cfdb84.jsonl` | two model requests in one turn, each notification duplicated |
| `17fbf63f-d3d489.jsonl` | `..._2026-10-14T02-32-12.631Z_d3d489.jsonl` | a duplicate usage frame that lands AFTER `turn/completed` |

Expected per-turn numbers were derived independently of the adapter as the
delta of the cumulative `tokenUsage.total` between the previous turn's last
notification and the completing turn's last notification (equal to the
de-duplicated sum of `tokenUsage.last`):

| Turn | input (incl. cached) | cachedInput | output |
|---|---|---|---|
| `…af1b0f1a` (9d4486) | 36267 | 33280 | 91 |
| `…a0a6f7` (cfdb84) | 151391 | 76544 | 77 |
| `…9d9725` (d3d489) | 142813 | 72448 | 203 |
