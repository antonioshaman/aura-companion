# AuraBench corpus (P5/D1)

Generated from the mining + validation run of 2026-09-28. Every task below was mined from a merged PR, its hidden tests **fail on the base commit and pass on the merge commit** (validated in a throwaway worktree), and its prompt passed both leak checks: the deterministic `eval:aurabench leak` (every new name the hidden tests use is named, no other new name from the diff is) and an independent LLM review against the real diff (solution hints / under-specification). The LLM review ran twice: round 1 flagged 20 of 50 prompts (19 under-specified — exact strings, logger shapes, test ids, payload shapes; 1 leaking a private field name); 3 of those were dropped because their hidden tests pin a single implementation, the rest were revised; round 2 re-checked all 22 revised prompts, found 2 remaining gaps, which were fixed. The deterministic check was re-run after every revision.

**43 tasks** — feature 13, bugfix 10, ui 7, debug 4, refactor 4, architecture 3, security 2.

**Re-review (P6/FIX-D2-5, 2026-09-28).** The first pilot showed prompts that give away the diagnosis or the fix in plain English, which the identifier-level check cannot see. All 47 prompts were re-judged by an LLM judge (`eval:aurabench judge`, rubric in `prompt-judge.ts`, calibrated on a human reviewer's rulings) against the PR diff and hidden tests: 25 kept as-is, 18 rewritten to symptom + required behaviour (re-judged until clean), 4 excluded because a passable prompt must state the fix. Every task's hidden tests also passed 3 of 3 runs on the merge commit. Verdicts, rewrites and stability: [`review/REPORT.md`](review/REPORT.md). The "LLM review" column below is the original D1 review.

Base failure kind: assertion 31, missing-interface 12 (the prompt names the interface).

Classes were assigned by hand (the miner's title heuristic labels ~85% as bugfix/feature). `debug` = the prompt gives only the symptom, the agent must locate the cause; `refactor` = behaviour-preserving extraction; `architecture` = a cross-cutting seam or subsystem change.


## Tasks

| id | PR | class | base failure | src files | src ± lines | LLM review |
|---|---|---|---|---|---|---|
| `sever-self-update-and-upstream-sync` | #97 | architecture | assertion | 15 | +22/−1614 | ok |
| `council-watchers-die-silently` | #157 | architecture | missing-interface | 2 | +239/−34 | revised → ok |
| `claude-cli-stdio-transport` | #169 | architecture | missing-interface | 7 | +608/−78 | revised → ok |
| `council-degraded-pair-never-recovers` | #53 | bugfix | assertion | 2 | +71/−4 | revised → ok |
| `archived-sessions-hold-memory` | #89 | bugfix | assertion | 3 | +66/−0 | ok |
| `session-restore-crash-on-sidecar-json` | #98 | bugfix | assertion | 2 | +20/−1 | ok |
| `codex-error-notification-shown-as-drift` | #112 | bugfix | assertion | 2 | +51/−1 | revised → ok |
| `archived-session-cli-survives-restart` | #114 | bugfix | assertion | 1 | +50/−2 | ok |
| `claude-model-switch-404-strands-session` | #116 | bugfix | assertion | 6 | +91/−1 | ok |
| `codex-observer-findings-dropped` | #122 | bugfix | assertion | 1 | +75/−2 | ok |
| `council-lost-review-event-degrades-pair` | #165 | bugfix | assertion | 2 | +120/−21 | ok |
| `codex-model-fallback-picks-mini` | #166 | bugfix | assertion | 1 | +27/−7 | ok |
| `resume-discards-conversation-too-eagerly` | #194 | bugfix | missing-interface | 1 | +81/−8 | ok |
| `codex-session-spawns-council-pair` | #125 | debug | assertion | 1 | +8/−5 | ok |
| `resume-hiccup-loses-conversation` | #171 | debug | missing-interface | 1 | +64/−9 | revised → ok |
| `deaf-session-after-server-restart` | #184 | debug | assertion | 1 | +16/−2 | ok |
| `drift-detector-misses-dead-stdio` | #201 | debug | assertion | 3 | +119/−26 | ok |
| `council-checkpoint-producer-endpoint` | #10 | feature | assertion | 2 | +90/−0 | revised → ok |
| `sessions-lost-on-reboot-tmpdir` | #37 | feature | assertion | 2 | +164/−4 | revised → ok |
| `shutdown-loses-streaming-replies` | #38 | feature | assertion | 2 | +40/−0 | ok |
| `session-schema-version` | #40 | feature | assertion | 1 | +59/−3 | revised → ok |
| `claude-adapter-outbound-queue-overflow` | #52 | feature | assertion | 1 | +166/−0 | revised → ok |
| `council-observer-idle-until-first-checkpoint` | #85 | feature | assertion | 2 | +110/−3 | revised → ok |
| `eval-compare-variant-delta-report` | #134 | feature | missing-interface | 2 | +210/−0 | revised → ok |
| `known-broken-claude-model-substitution` | #176 | feature | missing-interface | 4 | +154/−0 | ok |
| `respawned-cli-forgets-last-message` | #177 | feature | assertion | 1 | +81/−0 | revised → ok |
| `silent-stdio-watchdog-false-positives` | #180 | feature | missing-interface | 1 | +46/−6 | revised → ok |
| `orphan-reaper-misses-stdio-claude` | #187 | feature | assertion | 1 | +32/−0 | ok |
| `compaction-advisory-on-jsonl-growth` | #190 | feature | missing-interface | 2 | +151/−0 | revised → ok |
| `council-seat-model-tier-decision` | #207 | feature | missing-interface | 1 | +131/−0 | revised → ok |
| `extract-empty-chat-state` | #77 | refactor | missing-interface | 3 | +189/−62 | ok |
| `dedupe-assistant-avatar` | #79 | refactor | missing-interface | 4 | +56/−26 | revised → ok |
| `extract-resume-indicator` | #80 | refactor | missing-interface | 3 | +196/−51 | revised → ok |
| `own-sandbox-image-no-upstream-registry` | #96 | refactor | assertion | 13 | +61/−37 | revised → ok |
| `settings-secret-field-saves-mask-dots` | #23 | security | assertion | 1 | +8/−12 | ok |
| `recordings-store-secrets-in-clear` | #28 | security | assertion | 2 | +182/−7 | ok |
| `council-pairing-dropdown-invisible` | #25 | ui | assertion | 1 | +58/−39 | ok |
| `sidebar-duplicate-provider-chips` | #27 | ui | assertion | 3 | +64/−40 | revised → ok |
| `sidebar-pair-chip-duplicates-backend` | #44 | ui | assertion | 4 | +157/−12 | ok |
| `task-panel-stale-snapshot-hint` | #99 | ui | assertion | 4 | +58/−20 | ok |
| `model-switcher-label-lags` | #115 | ui | assertion | 1 | +8/−2 | ok |
| `observer-findings-oldest-first` | #138 | ui | assertion | 2 | +15/−5 | revised → ok |
| `claude-context-usage-meter` | #193 | ui | assertion | 2 | +33/−2 | ok |

## Excluded

194 merged PRs → 134 candidates → 130 validated → 47 selected → 43 after the P6/FIX-D2-5 re-review.

### At mining (no agent-sized task)

| PR | reason |
|---|---|
| #2 | too large: 47 source files (> 30) |
| #4 | non-task PR type "docs" |
| #5 | non-task PR type "docs" |
| #6 | non-task PR type "docs" |
| #11 | non-task PR type "test" |
| #12 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #14 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #18 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #20 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #21 | PR changes only tests; there is no code for the agent to write |
| #22 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #24 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #26 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #31 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #39 | non-task PR type "docs" |
| #42 | non-task PR type "revert" |
| #43 | non-task PR type "revert" |
| #56 | non-task PR type "test" |
| #57 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #58 | non-task PR type "docs" |
| #60 | non-task PR type "docs" |
| #61 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #62 | non-task PR type "test" |
| #63 | non-task PR type "docs" |
| #64 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #66 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #67 | non-task PR type "docs" |
| #69 | non-task PR type "docs" |
| #70 | non-task PR type "docs" |
| #71 | non-task PR type "docs" |
| #72 | non-task PR type "docs" |
| #73 | non-task PR type "docs" |
| #74 | non-task PR type "docs" |
| #75 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #90 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #94 | too large: 40 source files (> 30) |
| #95 | non-task PR type "ci" |
| #100 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #101 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #103 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #104 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #105 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #108 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #110 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #111 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #113 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #127 | non-task PR type "ci" |
| #129 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #143 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #144 | non-task PR type "docs" |
| #148 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #150 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #152 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #154 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #155 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #156 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #164 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #178 | non-task PR type "revert" |
| #183 | PR adds/changes no web/ test files, so nothing distinguishes before from after |
| #192 | PR adds/changes no web/ test files, so nothing distinguishes before from after |

### At validation (hidden tests do not separate base from merge)

| PR | reason |
|---|---|
| #17 | hidden tests fail on merge commit |
| #65 | hidden tests fail on merge commit |
| #76 | hidden tests already pass on base commit |
| #163 | hidden tests fail on merge commit |

### Excluded at re-review (P6/FIX-D2-5)

A passable prompt would have to hand over the fix (LLM judge verdict `exclude`, issue `contract_is_fix`; details in [`review/REPORT.md`](review/REPORT.md)).

| PR | task | reason |
|---|---|---|
| #50 | `archive-council-pair-kills-one-half` | a source-grep canary and a two-method fake coordinator pin the exact calls inside `archiveSession`; stating them is the design of the fix |
| #82 | `ask-user-question-answers-dropped` | the tests pin the SDK's `answers` keying (by question text), which the repo cannot reveal; stating it is the whole fix |
| #172 | `codex-observer-dies-not-initialized-race` | the orchestrator-side tests overwrite private internals (pending set, the private poll method, coordinator/launcher lookups), pinning one implementation; a passable prompt must name them |
| #204 | `drift-detector-blind-on-underscore-cwd` | the tests pin the CLI's underscore→dash slug rule, which the repo cannot reveal; stating it is the whole one-regex fix |

### Validated but not selected

Selection targeted 50 tasks spread over all classes, preferring changes an agent can finish inside the 60-minute cell budget and prompts that can state the problem without dictating the design.

| PR | class (heuristic) | src ± lines | reason |
|---|---|---|---|
| #8 | bugfix | +3241/−175 | too large for a 60-min cell (21 files, 3416 lines) |
| #16 | bugfix | +121/−46 | bugfix quota filled by smaller / less interface-bound tasks |
| #29 | feature | +198/−50 | feature quota filled by smaller / less interface-bound tasks |
| #30 | security | +341/−10 | hidden tests need 16 new names across 3 new modules plus route error-code changes |
| #32 | ui | +197/−1 | ui quota filled by smaller / less interface-bound tasks |
| #33 | feature | +107/−4 | feature quota filled by smaller / less interface-bound tasks |
| #35 | feature | +279/−3 | feature quota filled by smaller / less interface-bound tasks |
| #36 | bugfix | +98/−0 | bugfix quota filled by smaller / less interface-bound tasks |
| #41 | feature | +708/−2 | too large for a 60-min cell (8 files, 710 lines) |
| #45 | feature | +517/−0 | hidden tests need ~20 new exported names (the prompt would be the spec, not a task) |
| #46 | feature | +539/−0 | feature quota filled by smaller / less interface-bound tasks |
| #47 | feature | +562/−0 | hidden tests need ~20 new exported names (the prompt would be the spec, not a task) |
| #48 | feature | +822/−13 | too large for a 60-min cell (7 files, 835 lines) |
| #49 | feature | +297/−2 | feature quota filled by smaller / less interface-bound tasks |
| #51 | feature | +220/−4 | feature quota filled by smaller / less interface-bound tasks |
| #54 | feature | +353/−12 | feature quota filled by smaller / less interface-bound tasks |
| #55 | bugfix | +123/−33 | bugfix quota filled by smaller / less interface-bound tasks |
| #59 | architecture | +1107/−101 | too large for a 60-min cell (19 files, 1208 lines) |
| #68 | feature | +455/−24 | too large for a 60-min cell (11 files, 479 lines) |
| #78 | bugfix | +24/−5 | bugfix quota filled by smaller / less interface-bound tasks |
| #81 | bugfix | +7/−1 | dropped after LLM review: the hidden test pins one implementation (exact scrollIntoView options); stating it hands over the fix |
| #83 | bugfix | +50/−3 | bugfix quota filled by smaller / less interface-bound tasks |
| #84 | feature | +424/−11 | feature quota filled by smaller / less interface-bound tasks |
| #87 | bugfix | +422/−72 | bugfix quota filled by smaller / less interface-bound tasks |
| #91 | feature | +1918/−82 | too large for a 60-min cell (9 files, 2000 lines) |
| #92 | bugfix | +130/−19 | bugfix quota filled by smaller / less interface-bound tasks |
| #93 | refactor | +213/−1 | refactor quota filled by smaller / less interface-bound tasks |
| #102 | feature | +314/−2 | feature quota filled by smaller / less interface-bound tasks |
| #106 | feature | +1036/−16 | too large for a 60-min cell (10 files, 1052 lines) |
| #107 | bugfix | +43/−2 | bugfix quota filled by smaller / less interface-bound tasks |
| #109 | feature | +534/−26 | too large for a 60-min cell (13 files, 560 lines) |
| #117 | bugfix | +41/−4 | bugfix quota filled by smaller / less interface-bound tasks |
| #118 | bugfix | +993/−102 | too large for a 60-min cell (22 files, 1095 lines) |
| #119 | bugfix | +7/−1 | bugfix quota filled by smaller / less interface-bound tasks |
| #120 | bugfix | +103/−2 | bugfix quota filled by smaller / less interface-bound tasks |
| #121 | bugfix | +84/−17 | bugfix quota filled by smaller / less interface-bound tasks |
| #123 | bugfix | +31/−3 | bugfix quota filled by smaller / less interface-bound tasks |
| #124 | bugfix | +34/−11 | bugfix quota filled by smaller / less interface-bound tasks |
| #126 | feature | +2217/−0 | too large for a 60-min cell (15 files, 2217 lines) |
| #128 | feature | +432/−0 | feature quota filled by smaller / less interface-bound tasks |
| #130 | feature | +356/−9 | feature quota filled by smaller / less interface-bound tasks |
| #131 | feature | +189/−1 | feature quota filled by smaller / less interface-bound tasks |
| #132 | feature | +330/−14 | feature quota filled by smaller / less interface-bound tasks |
| #133 | feature | +150/−1 | feature quota filled by smaller / less interface-bound tasks |
| #135 | feature | +241/−0 | feature quota filled by smaller / less interface-bound tasks |
| #136 | feature | +322/−0 | feature quota filled by smaller / less interface-bound tasks |
| #137 | feature | +181/−0 | feature quota filled by smaller / less interface-bound tasks |
| #139 | feature | +1550/−45 | too large for a 60-min cell (20 files, 1595 lines) |
| #141 | feature | +111/−27 | feature quota filled by smaller / less interface-bound tasks |
| #142 | feature | +520/−21 | feature quota filled by smaller / less interface-bound tasks |
| #145 | feature | +284/−4 | hidden tests need 12 new names in a new module |
| #146 | feature | +41/−3 | feature quota filled by smaller / less interface-bound tasks |
| #147 | ui | +101/−0 | ui quota filled by smaller / less interface-bound tasks |
| #149 | debug | +323/−28 | debug quota filled by smaller / less interface-bound tasks |
| #151 | feature | +23/−0 | feature quota filled by smaller / less interface-bound tasks |
| #158 | feature | +305/−56 | feature quota filled by smaller / less interface-bound tasks |
| #159 | feature | +69/−11 | feature quota filled by smaller / less interface-bound tasks |
| #160 | bugfix | +40/−24 | bugfix quota filled by smaller / less interface-bound tasks |
| #161 | bugfix | +12/−1 | dropped after LLM review: the hidden test is a regex over index.ts source pinning one implementation |
| #162 | bugfix | +387/−61 | too large for a 60-min cell (16 files, 448 lines) |
| #167 | feature | +304/−10 | feature quota filled by smaller / less interface-bound tasks |
| #168 | bugfix | +22/−11 | dropped after LLM review: the hidden test pins one exact string form of the fix |
| #170 | bugfix | +20/−11 | bugfix quota filled by smaller / less interface-bound tasks |
| #173 | bugfix | +76/−5 | bugfix quota filled by smaller / less interface-bound tasks |
| #174 | bugfix | +218/−48 | too large for a 60-min cell (15 files, 266 lines) |
| #175 | feature | +564/−0 | feature quota filled by smaller / less interface-bound tasks |
| #179 | debug | +136/−0 | debug quota filled by smaller / less interface-bound tasks |
| #181 | feature | +34/−0 | feature quota filled by smaller / less interface-bound tasks |
| #182 | feature | +151/−2 | feature quota filled by smaller / less interface-bound tasks |
| #185 | bugfix | +100/−13 | bugfix quota filled by smaller / less interface-bound tasks |
| #186 | feature | +1152/−2 | too large for a 60-min cell (10 files, 1154 lines) |
| #189 | debug | +353/−0 | debug quota filled by smaller / less interface-bound tasks |
| #191 | bugfix | +402/−68 | bugfix quota filled by smaller / less interface-bound tasks |
| #196 | bugfix | +88/−20 | bugfix quota filled by smaller / less interface-bound tasks |
| #197 | debug | +123/−14 | debug quota filled by smaller / less interface-bound tasks |
| #200 | bugfix | +231/−29 | bugfix quota filled by smaller / less interface-bound tasks |
| #202 | feature | +1436/−1005 | too large for a 60-min cell (10 files, 2441 lines) |
| #203 | bugfix | +93/−5 | bugfix quota filled by smaller / less interface-bound tasks |
| #206 | feature | +562/−0 | feature quota filled by smaller / less interface-bound tasks |
| #208 | feature | +136/−0 | feature quota filled by smaller / less interface-bound tasks |
| #209 | feature | +174/−0 | feature quota filled by smaller / less interface-bound tasks |
| #210 | feature | +376/−59 | feature quota filled by smaller / less interface-bound tasks |
| #211 | feature | +194/−0 | feature quota filled by smaller / less interface-bound tasks |
