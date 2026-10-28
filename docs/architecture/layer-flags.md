# Layer flags (knowledge / observer / council / auto-proceed)

Four Aura meta-layers can be switched on and off independently. This supports ablation runs (AuraBench variants C–G) and lets you turn off a layer that isn't paying for itself. The code lives in `web/server/layer-flags.ts`.

| Layer | Env (server default) | Per-session (`layers.<name>`) | Enforcement |
|---|---|---|---|
| `knowledge` | `COMPANION_LAYER_KNOWLEDGE` | `knowledge` | Claude: `--disallowedTools` for `Read/Edit/Write(./.agents/knowledge/**)`, `Bash(bun run --cwd web kb:*)`, `Skill(prime\|learn\|self-reflect\|review-with-kb\|evolve)`, plus an appended directive. Codex gets the directive only, as `developerInstructions` on `thread/start` and `thread/resume` (soft). |
| `observer` | `COMPANION_LAYER_OBSERVER` | `observer` | Host-side. A `councilMode: "council"` create returns **409** instead of falling back to a solo session. |
| `council` | `COMPANION_LAYER_COUNCIL` | `council` | Claude: `Skill(council-*)` and `Skill(_council-experts)` go into `--disallowedTools`, plus the directive. Codex gets the directive only. |
| `autoProceed` | `COMPANION_LAYER_AUTO_PROCEED` | `autoProceed` | Host-side. `autoProceedOnIdle` is removed at the create boundary, and the auto-proceed enactor refuses `arm` for the session. |
| `uiux` | `COMPANION_LAYER_UIUX` | `uiux` | The shipped skill pack (`packs/skills`, installed at boot into `~/.companion/skill-pack`). On: Claude gets `--plugin-dir <pack>/exposures/<id>` (skills answer as `/aura-toolkit:<name>`; used only when the installed CLI's `--help` lists the flag), Codex gets marked read-only copies in its per-session `CODEX_HOME/skills`. Off: no `--plugin-dir`, and Aura's copies are removed from the Codex home. The user's own skill with the same name always wins. Settings → "UI/UX toolkit" (`uiuxToolkit`, default on) lowers the default for new sessions; an explicit `layers.uiux` still wins. Decided at the first spawn, persisted as `SdkSessionInfo.skillExposure`, reused on relaunch/resume; sessions that wanted it but cannot get it (container, old CLI, no pack) show "Toolkit unavailable" in the TopBar. See `web/server/skill-exposure.ts`. |

- **Defaults.** Every layer is on, i.e. every layer is *available*. With default flags the create body and the spawn argv are byte-identical to what they were before C3. "Available" is not "used by default" — see [Session defaults](#session-defaults-aura-diet-2026-10) below.
- **Values.** Accepted values are `on/off/1/0/true/false`, case-insensitive. Any other value **fails closed** to the default and logs a warning:
  - for env values, once at boot (`[layer-flags] …`);
  - for per-session values, on each create request.
- **Precedence.** A per-session value overrides the server default. The resolved flags are stored on `SdkSessionInfo.layers` whenever the session's flags or the server's flags differ from the defaults, so a relaunch applies the same restrictions again. On resume:
  - **Claude** — the directive is not re-emitted on `--resume`, same as the observer prompt. It doesn't need to be: the CLI (verified on 2.1.283) stores a `prompt_snapshot` of the full system prompt in the transcript and restores it on `--resume`. The `--disallowedTools` rules are in the argv, so they apply again on every spawn.
  - **Codex** — the directive is sent again on `thread/resume`, because a server restart resumes the thread.
- **Known confound.** The workspace `CLAUDE.md`/`AGENTS.md` still mentions the KB. The directive tells the agent to ignore those instructions. The bench harness removes the files entirely for the "naked" variants.
- **Usage.** `POST /api/sessions/create` with `{"cwd": "...", "layers": {"knowledge": "off"}}`. The flags are not exposed in the UI; they are an operator/bench API.

## Session defaults (aura-diet, 2026-10)

The layer flags decide what a session *may* use. Separately, Aura's defaults decide what a new session *does* use. They were flipped on evidence: AuraBench measured the observer at +0pp for 2.4× cost and full council at −6pp for 2.9×; in the real-work corpus observer findings were referenced by commits in only 2 of ~10 projects, and 138 KB entries were used twice.

| What | Default | How to opt in | Where |
|---|---|---|---|
| Session mode | **Solo** — one agent, no observer pair | Per session: the Council toggle on the New-Session form, or `councilMode: "council"` + `councilPairing` on `POST /api/sessions/create`. As a UI default: Settings → Session defaults → *Council* (`settings.defaultSessionMode`). | `HomePage.tsx`, `settings-manager.ts` |
| Auto-proceed | **Off** | `autoProceedOnIdle` on a council create (see below). Nothing in the UI sends it. | `routes.ts`, AP-WIRE |
| KB at session start | **Off** — agents consult `.agents/knowledge` on demand | Settings → Session defaults → *Load knowledge base at session start* (`settings.kbAutoPrime`), or `kbAutoPrime: true` on create. | `layer-flags.ts` (`KB_AUTO_PRIME_DIRECTIVE`) |

- **`defaultSessionMode` is a UI default only.** The API never creates a pair unless the request says `councilMode: "council"`; the setting only decides where the New-Session Council toggle starts. The toggle no longer remembers its last value (the old `cc-council-enabled` localStorage key is cleared), so one opt-in for a risky change doesn't make every later session a paid pair. The pairing choice is still remembered.
- **`kbAutoPrime`** is resolved at the create boundary (`applyLayerFlagsToCreateBody`): an explicit boolean wins, otherwise the server setting applies; a non-boolean value falls back to the setting with a warning. It is forwarded only when on, so the default body/argv are unchanged. When on, the directive is appended like the layer directive — Claude `--append-system-prompt`, Codex `developerInstructions` (re-sent on `thread/resume`) — and persisted on `SdkSessionInfo.kbAutoPrime` for relaunch. It is never applied to a Council observer half, and it is dropped (with a warning) when the `knowledge` layer is off, so `COMPANION_LAYER_KNOWLEDGE=off` still wins.
- **Existing sessions/pairs are unaffected.** Nothing here touches running sessions, persisted groups, or their relaunch options.

## Auto-proceed wiring (AP-WIRE)

Auto-proceed is **opt-in per Council pair** and off by default. Before AP-WIRE the server accepted `autoProceedOnIdle` and nothing emitted `orchestrator_turn_idle`, so it never armed.

- **Opt-in.** Send `{"councilMode": "council", "autoProceedOnIdle": {"idleMs": …, "maxIterations": …}}` on `POST /api/sessions/create`. The value is validated at the boundary and stored on the orchestrator-half's `SdkSessionInfo.autoProceedOnIdle` (only that half). Because it is persisted, it survives relaunches and server restarts.
- **Arm.** On each `orchestrator:turn-done` (the in-flight → awaiting-input edge) for an opted-in orchestrator, `CouncilAutoProceedController` routes `orchestrator_turn_idle` through `coordinator.applyEvent`. The state machine arms only while the group is `active`. After `idleMs` the manager sends the existing `[auto-proceed:idle-timeout v1]` frame (recording origin `server:auto-proceed`), and that turn's `result` re-arms.
- **Cancel.**
  - A browser `user_message` cancels the pending timer (`noteUserMessage`).
  - A mid-turn orchestrator is refused by the manager's gate.
  - A **blocking** observer STOP (`severity: STOP`, not `weakEvidence`, not `disputed` — the banner predicate) emits `stop_finding_raised` and joins the group's set of unresolved STOPs. Nothing arms while that set is non-empty. The set has the banner's lifetime: a later review without a STOP does **not** release it. Only a human does, with "Dismiss for now" (`POST /api/groups/:id/stops/resolve`, persisted in `.council/state/<group>-resolved-stops.json`) or "Dispute" (B2b, which also releases held re-raises the dispute now matches). The last release emits `stop_finding_resolved` and re-tries the arm.
  - After a restart the set is rebuilt from the reviews on disk (the REST-bootstrap view the banner uses) minus persisted dismissals. Nothing arms until that restore finishes; a failed restore keeps holding and is retried on the next idle edge.
  - An incomplete restore (a review file that cannot be read or parsed, a broken verdicts file, a failed readdir) also keeps holding. For an opted-in pair the findings bootstrap (`GET /api/groups/:id/findings`) returns `autoProceedRestoreGaps`, and the ObserverPanel shows "Auto-proceed paused: restore incomplete" with each file and reason. A review-file gap can be ignored ("Ignore this file" → `POST /api/groups/:id/restore-gaps/ignore`, persisted in `.council/state/<group>-ignored-restore-gaps.json`). The ignore applies to that file name plus a sha256 of the content the human saw: if the file is rewritten and is still broken, it blocks again; if it becomes a valid review, it is read normally. After an ignore the restore runs again, and an idle edge that was waiting arms. Verdicts and readdir gaps cannot be ignored; the workspace has to be repaired.
  - Foreign / legacy rule: some review files fail the strict parser. If such a file is a JSON object whose `session_group_id` names **another** pair, it belongs to that pair. It is skipped and is not a gap. If a file names no group (legacy format), it cannot be attributed, so it stays a gap that can be ignored.
  - Archiving the pair cancels a pending timer explicitly.
- **Cap.** The per-session `maxIterations` (≤ 10) is clamped by `COMPANION_ORCH_AUTO_PROCEED_MAX_ITERATIONS_CEILING`. That variable can only lower the cap: a value outside `[1, 10]` keeps 10 and logs a warning. Past the cap nothing is armed (the controller logs `auto-proceed.cap-reached` once). A browser-typed user message resets the counter and persists the zeroed trace; synthetic and server-injected frames never do.
- **Logs (EC-9).** `auto-proceed.armed`, `.arm-refused` (with `reason`), `.hold` (`restoring` / `unresolved_stop`), `.stop-held`, `.stop-released` (`via: dismissed | disputed`), `.hold-restored`, `.hold-restore-incomplete` (with `gaps`), `.restore-gap-ignored`, `.cap-reached`, `.archived`. Each carries `event`, `sessionGroupId`, `sessionId` and `role`.
- **Pairings.** Both supported pairings (`claude+claude`, `claude+codex`) have a Claude orchestrator, and only the orchestrator's turn edges drive the timer.
