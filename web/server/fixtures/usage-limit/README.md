# Usage-limit fixtures

Real frames captured from `~/.companion/recordings/` on the prod box, trimmed of
bulky usage/modelUsage fields. Used by `usage-limit-parse.test.ts` and
`claude-adapter.usage-limit.test.ts`.

- `claude-session-limit-2026-10-14.ndjson` — five-hour window hit at
  2026-10-14T23:37:48Z: `rate_limit_event` (`status: "rejected"`,
  `resetsAt: 1792028400` = 2026-10-15T01:40Z), synthetic assistant
  "You've hit your session limit · resets 1:40am (UTC)", and the
  `result` frame (`is_error: true`, `api_error_status: 429`). The text and the
  structured epoch agree, which the parser test asserts.
- `claude-out-of-usage-credits-2026-10-14.ndjson` — weekly
  `seven_day_overage_included` window rejected: the visible text carries NO
  reset time ("You're out of usage credits…"), only the structured
  `resetsAt: 1791979200` (2026-10-14T12:00Z) does.

No Codex usage-limit hit exists in the recordings yet. The Codex fixtures in
the tests are built from the real `account/rateLimits/updated` and v2 `error`
notification shapes seen in recordings, with the limit values/strings taken
from the installed codex binary (`codexErrorInfo: "usageLimitExceeded"`,
"You've hit your usage limit. … Try again at …").
