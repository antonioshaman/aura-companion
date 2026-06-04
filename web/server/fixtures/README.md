# Server-side test fixtures

## `anthropic-models-response.json`

Synthetic-but-realistic capture of an Anthropic `GET /v1/models` response,
used by `anthropic-models-cache.test.ts` (EC-6 replay-based regression).

### What lives here

- **4 valid claude-* entries** (opus-4-8, opus-4-7, sonnet-4-6, haiku-4-5)
  exercising the tier sort (opus > sonnet > haiku) and the `created_at desc`
  secondary sort within the opus tier.
- **1 `model_snapshot` entry** that MUST be dropped by the parser
  (EC-5 strict-on-`type`).
- **1 non-`claude-*` entry** (`gpt-4o`) that MUST be dropped by the parser
  (id regex `^claude-[a-z0-9.\-]+$`).
- **`has_more: false`** — pagination is currently out of scope; the parser
  logs a `pagination-needed` canary if a real capture ever flips this.

### Refreshing this fixture

Anthropic may add/rename fields over time. To refresh:

```bash
# 1. Capture the live response with your own API key (DO NOT COMMIT THE KEY).
curl -fsS https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" > /tmp/anthropic-models-fresh.json

# 2. Redact any operator-specific fields if Anthropic ever returns them
#    (today the response carries only model metadata — no PII).
# 3. Replace this file, re-run tests, update expectations in
#    web/server/anthropic-models-cache.test.ts (sort order, dropped-items
#    count, has_more).
```

The fixture is intentionally synthetic — tests assert deterministic
behaviour against KNOWN content. A real capture is welcome but tests
must then be updated to match the new content.

## `anthropic-models-response-hostile.json`

Council Review 2026-06-04-0823 P3 #15. Adversarial-input fixture
exercising the parser's reject branches that the happy-path fixture
doesn't touch. Documented entry-index → reject-reason map:

| Index | Reject reason | Defence-in-depth target |
|-------|---------------|-------------------------|
| 0 | (valid baseline — must survive) | sort + label normalisation sanity check |
| 1 | `display_name` contains bidi control chars (U+202C/U+202E etc.) | Trojan-Source CVE-2021-42574 |
| 2 | `display_name` contains C0 control (`\t`) | NDJSON-line-discipline defence |
| 3 | `display_name` contains C1 control (U+0080-U+009F) | terminal-escape-sequence defence |
| 4 | `id` exceeds `MODEL_ID_MAX_LEN` (128 chars) | argv-injection length bound |
| 5 | `display_name` exceeds `MODEL_LABEL_MAX_LEN` (256 chars) | log-pollution bound |

The fixture is consumed by the test
`"processes hostile-input fixture: only valid baselines survive"`
in `anthropic-models-cache.test.ts`. If you tighten the parser
(e.g., adopt strict ISO-8601 regex on `created_at` per Persistence
P3-4), the test will RED — extend this fixture with the new reject
shape AND update this table.
