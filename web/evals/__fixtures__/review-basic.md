{
  "schema_version": 1,
  "checkpoint_id": "phase-x",
  "phase": "phase-x",
  "session_group_id": "grp_test123",
  "observer_provider": "claude",
  "observer_model": "claude-opus-4-8",
  "observer_cli_version": "claude-code",
  "reviewed_at": "2026-06-14T00:00:00Z",
  "findings": [
    {"severity": "STOP", "claim": "race in ws-bridge", "evidence_path": "web/server/ws-bridge.ts", "evidence_lines": [10, 20], "confidence": "high"},
    {"severity": "WARN", "claim": "missing test", "evidence_path": "web/server/routes.ts", "confidence": "medium"},
    {"severity": "info", "claim": "style nit", "evidence_path": "web/src/App.tsx"},
    {"severity": "BOGUS", "claim": "bad severity", "evidence_path": "x.ts"},
    {"severity": "WARN", "claim": "", "evidence_path": "y.ts"}
  ]
}
