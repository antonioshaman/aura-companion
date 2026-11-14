# Turn-failure fixtures

Raw NDJSON frames copied verbatim (one frame per line, never re-serialised)
from `~/.companion/recordings/` on the prod box. They contain no credentials:
only usage counters (`input_tokens`, …), session/message UUIDs and provider
error text. Used by `session-failure.replay.test.ts` (EC-6).

- `claude-403-org-disabled-2026-11-13.ndjson` — synthetic assistant frame
  (`error: "oauth_org_not_allowed"`) + `result` (`is_error: true`,
  `api_error_status: 403`, "Your organization has disabled Claude subscription
  access for Claude Code …").
- `claude-session-limit-2026-11-14.ndjson` — `rate_limit_event`
  (`status: "rejected"`, `rateLimitType: "five_hour"`, `resetsAt: 1794657600`),
  synthetic assistant (`error: "rate_limit"`) and the 429 `result`.
- `codex-usage-limit-2026-10-30.ndjson` — `account/rateLimits/updated`, v2
  `error` notification (`codexErrorInfo: "usageLimitExceeded"`) and the failed
  `turn/completed`.

The extra-usage case reuses `../usage-limit/claude-out-of-usage-credits-2026-10-14.ndjson`.

No capture exists on the box for: Claude 401, Claude network failure mid-turn,
"version X or newer is required", Codex id-less auth error, Codex network
error, stale Codex copy. Those tests build frames inline using the exact wire
shapes of the installed CLIs: Claude 2.1.283 (`SDKAssistantMessageError` enum
`authentication_failed | oauth_org_not_allowed | … | rate_limit | …`,
`system/api_retry` with nullable `error_status`) and codex 0.162.1
(`CodexErrorInfo` members `unauthorized`, `usageLimitExceeded`,
`httpConnectionFailed{httpStatusCode}`, `responseStreamDisconnected{…}`, …).
When one of these incidents is recorded, replace the inline frame with it.
