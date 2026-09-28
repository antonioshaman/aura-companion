# Layer flags (knowledge / observer / council / auto-proceed)

Four Aura meta-layers can be switched on and off independently. This supports ablation runs (AuraBench variants C–G) and lets you turn off a layer that isn't paying for itself. The code lives in `web/server/layer-flags.ts`.

| Layer | Env (server default) | Per-session (`layers.<name>`) | Enforcement |
|---|---|---|---|
| `knowledge` | `COMPANION_LAYER_KNOWLEDGE` | `knowledge` | Claude: `--disallowedTools` for `Read/Edit/Write(./.agents/knowledge/**)`, `Bash(bun run --cwd web kb:*)`, `Skill(prime\|learn\|self-reflect\|review-with-kb\|evolve)`, plus an appended directive. Codex gets the directive only, as `developerInstructions` on `thread/start` and `thread/resume` (soft). |
| `observer` | `COMPANION_LAYER_OBSERVER` | `observer` | Host-side. A `councilMode: "council"` create returns **409** instead of falling back to a solo session. |
| `council` | `COMPANION_LAYER_COUNCIL` | `council` | Claude: `Skill(council-*)` and `Skill(_council-experts)` go into `--disallowedTools`, plus the directive. Codex gets the directive only. |
| `autoProceed` | `COMPANION_LAYER_AUTO_PROCEED` | `autoProceed` | Host-side. `autoProceedOnIdle` is removed at the create boundary, and the auto-proceed enactor refuses `arm` for the session. |

- **Defaults.** Every layer is on, which matches current prod. With default flags the create body and the spawn argv are byte-identical to what they were before C3.
- **Values.** Accepted values are `on/off/1/0/true/false`, case-insensitive. Any other value **fails closed** to the default and logs a warning:
  - for env values, once at boot (`[layer-flags] …`);
  - for per-session values, on each create request.
- **Precedence.** A per-session value overrides the server default. The resolved flags are stored on `SdkSessionInfo.layers` whenever the session's flags or the server's flags differ from the defaults, so a relaunch applies the same restrictions again. On resume:
  - **Claude** — the directive is not re-emitted on `--resume`, same as the observer prompt. It doesn't need to be: the CLI (verified on 2.1.283) stores a `prompt_snapshot` of the full system prompt in the transcript and restores it on `--resume`. The `--disallowedTools` rules are in the argv, so they apply again on every spawn.
  - **Codex** — the directive is sent again on `thread/resume`, because a server restart resumes the thread.
- **Known confound.** The workspace `CLAUDE.md`/`AGENTS.md` still mentions the KB. The directive tells the agent to ignore those instructions. The bench harness removes the files entirely for the "naked" variants.
- **Usage.** `POST /api/sessions/create` with `{"cwd": "...", "layers": {"knowledge": "off"}}`. The flags are not exposed in the UI; they are an operator/bench API.
