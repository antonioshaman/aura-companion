# Sign-in fixtures (LLM auth phase 2)

- `claude-auth-login-2.1.283.txt`, `codex-login-device-auth-0.162.1.txt` — byte-for-byte
  output of `claude auth login` / `codex login --device-auth` captured 2026-11-14 on the
  service box (isolated HOME, synthetic credentials). Attempt secrets (Claude `state` and
  `code_challenge`, the Codex one-time code) are replaced by synthetic values of the same
  shape. Refresh both when a CLI changes its sign-in output, and add the version to
  `PROVEN_LOGIN_VERSIONS` in `../login-transcript.ts`.
- `fake-login-cli.mjs` — fake official CLI for both providers (scenarios in its header).
  Reproduces the verified side effects, including the destructive start (Claude rewrites
  an expired `.credentials.json` with empty tokens; Codex deletes `auth.json`). Writes only
  synthetic `SYNTH-CANARY-*` credentials. Tests wrap it in a per-scenario shell script
  (`#!/bin/sh` + `exec node fake-login-cli.mjs --scenario=… "$@"`), because the login
  runner passes the CLI an environment allowlist only.
