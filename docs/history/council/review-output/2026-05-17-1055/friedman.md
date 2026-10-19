# Friedman — UX Quality Review

Scope: terminal-text UX surface of the Phase 0 stack-detection refusal. Files reviewed:
- `web/scripts/detect-stack.ts` — `renderRefusal`, `REFUSAL_HEADLINES`, `OVERRIDE_FOOTER`, `dedupedMarkerList`
- `~/.claude/skills/council-plan/SKILL.md` Phase 0
- `~/.claude/skills/council-implement/SKILL.md` Phase 0
- `~/.claude/skills/council-review/SKILL.md` Phase 0

Worst-case refusal walked through line-by-line (unknown class, empty workspace):

```
Stack detection: no recognised stack markers at workspace root.   1
                                                                  2 (blank)
Checked for:                                                      3
  - web/package.json:name=aura-companion                          4
  - web/package.json:dependencies.hono                            5
  - web/server/ws-bridge.ts                                       6
  - pyproject.toml:aiogram                                        7
  - requirements.txt:^aiogram + bot/                              8
  - .council-stack-override                                       9
                                                                 10 (blank)
Found at workspace root:                                         11
  (no recognised stack markers)                                  12
                                                                 13 (blank)
To override, run:                                                14
  /council-plan-aura      # if this workspace is the Aura...     15
  /council-plan-python    # if this workspace is the Python...   16
```

16 lines. Within `renderRefusal`'s own `≤18` ceiling, but **above the plan's stated ceiling of 15**. The ambiguous class adds 1-2 lines for the found filenames, pushing 17-18 — still under 18, still over plan's 15.

---

### 1. The "/council-plan-python" override hint points at a slash command that does not exist
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:494-497` (and mirrored in all 3 SKILL.md Phase 0 footers) |
| **Principle** | Principle 9 — Trust compounds slowly, breaks fast (P1 — actively misleads) |

**Finding:** The refusal footer tells the user to run `/council-plan-python` (and the mirror copies say `/council-implement-python`, `/council-review-python`) "if this workspace is the Python bot (suffixed variant)" — but only the **Aura** side has a suffixed sibling. The Python body lives **inside the suffixless skill itself**; dispatch rules at SKILL.md line 47/49 confirm "continue with the Python council body below". A user typing `/council-plan-python` will hit "skill not found" and be stranded after the refusal told them to.

**Consequence:** AC-3.2 (10-second readability) is satisfied only insofar as the user can read the override line fast — but the line is a dead end. The first thing a stuck user does is try the suggested command; on the python side it fails, eroding trust in the entire router (Friedman: "every time a user discovers a mistake, it's a small betrayal").

**Fix:** Footer should distinguish the two arms by their **actual** affordance: `/council-plan-aura` to dispatch the Aura variant, and `echo python > .council-stack-override && /council-plan` to pin this suffixless skill to its Python body. Or, simpler, drop the python-suffix line entirely and replace with one sentence: "Or create `.council-stack-override` with `aura` or `python` on a single line." Same fix in `council-implement/SKILL.md:86` and `council-review/SKILL.md:86`.

---

### 2. `override_malformed` refusal never tells the user the allow-list — the actionable hint is missing
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:516-553` (renderRefusal) and SKILL.md mirrors line 65 |
| **Principle** | Principle 2 — Error states with no recovery action (P1 — blocks task in 10s window) |

**Finding:** When `.council-stack-override` is malformed, the user sees:
> Stack detection: .council-stack-override is malformed.
> ...
>   - .council-stack-override (malformed)

The body never states the **closed allow-list** (`aura` | `python`) or that the value must be on a single trimmed line. The skill prose at SKILL.md line 42 says "Anything else (empty, whitespace, `Aura`, `both`) → refuse" — but that explanatory text is **not in the refusal output the user actually sees**. The user is told their file is wrong with no signal of what right looks like.

**Consequence:** A user whose override is `Aura` (capitalised), `python\n  ` (trailing whitespace tolerated, but malformed if non-allow-listed value), or `both` is told nothing more than "malformed". They cannot fix in 10 seconds because they do not know the rule. This is the same anti-pattern Friedman cites: "Show the rule or rationale."

**Fix:** In the `override_malformed` branch of `renderRefusal`, replace the generic body with a class-specific body: append one line under the "Found" section reading `Expected exact lowercase: 'aura' or 'python', single line, no quotes.` Treat malformed-override as a distinct failure class (it already is in `REFUSAL_HEADLINES` — extend the differentiation into the body too).

---

### 3. Three distinct headlines, one identical body — failure-class differentiation collapses below the fold
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:516-553` (renderRefusal) |
| **Principle** | Principle 6 — Lists drive action; Principle 8 — structure over conversation (P2) |

**Finding:** `REFUSAL_HEADLINES` has three keys (`unknown`, `ambiguous`, `override_malformed`) — so on the surface the per-failure-class differentiation looks correct. But `renderRefusal` produces an **identical body for all three**: same "Checked for" enumeration (all 6 markers, every time, regardless of class), same footer, only the "Found" section varies by what's actually on disk. The user scans the body looking for what to do, sees the same shape three different ways, and has to re-read the headline to figure out which class they're in.

**Consequence:** AC-3.2's 10-second budget is spent re-reading rather than acting. The ambiguous case (both stacks present) needs a different action than the unknown case (no markers): in ambiguous, the user picks one with the override; in unknown, the user is in the wrong directory or the file structure is broken. Today both lead to the same footer copy.

**Fix:** Branch the second-line summary under each headline:
- `unknown` → "Run this skill from a recognised workspace, or set `.council-stack-override`."
- `ambiguous` → "Two stacks share this directory — pin one with `.council-stack-override` to disambiguate."
- `override_malformed` → see Finding 2.

One extra line per class. Stays under 18.

---

### 4. "Found at workspace root" surfaces marker paths the user already saw in "Checked for" — adds no information when probes failed mid-parse
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:534-549` (renderRefusal, `Found` branch) |
| **Principle** | Principle 1 — Structure complexity, don't simplify away user value (P2 — lossy in the case it matters most) |

**Finding:** Given the security constraint (no raw content), the "Found at workspace root" section is the user's **only** signal of why detection failed in a way they can act on. But the implementation only prints `c.path` plus an optional reason in parens. For the case where `web/package.json` exists but `JSON.parse` threw, the line reads:
> `  - web/package.json (json_parse)`

That string — `json_parse` — is an internal `MarkerReason` enum value, not user-facing copy. A user reading it cannot tell whether their file is missing a brace, has a UTF-8 BOM (already stripped silently), or is empty. They also cannot tell whether the absent `pyproject.toml` matters (no line printed) vs being deliberately not present.

**Consequence:** The section that should answer "what did the detector actually see?" leaks implementation jargon and silently omits the absent-marker case. The user is told "Found at workspace root: web/package.json (json_parse)" and has to guess what to do.

**Fix:** Map `MarkerReason` to user-facing phrases: `json_parse → "could not parse as JSON"`, `size_exceeded → "exceeds 16 KB cap"`, `symlink → "is a symlink (rejected)"`, `out_of_bounds → "resolves outside workspace"`, `read_error → "could not be read"`. Still no content leak — these are file-state descriptors, not file contents. Keeps line count flat.

---

### 5. Plan ceiling 15 vs code/test ceiling 18 — drift built in at spec time
| | |
|---|---|
| **File** | `web/scripts/detect-stack.test.ts:167-168` (comment "Hard upper bound 18 keeps AC-3.2 achievable") and SKILL.md mirrors line 59 ("target ≤ 18 lines") |
| **Principle** | Principle 9 — Inconsistency erodes trust; cross-mirror copy drift (P2) |

**Finding:** Three different ceilings coexist:
- Plan spec: ≤15 lines (per the context-brief reference to AC-3.2 readability)
- SKILL.md prose: "target ≤ 18 lines"
- Test code: "Hard upper bound 18"

The worst-case unknown refusal walks out at **16 lines** — passes the code/test gate, fails the plan gate. Since the test enshrines `18` as the hard bound, future copy growth has +3 lines of silent runway above the plan's stated budget.

**Consequence:** Two things drift over time. (1) Copy gets longer until 18 — the slacker number wins. (2) The SKILL.md prose ("target ≤ 18") and the plan ("≤ 15") will diverge further on each edit since no single canary asserts them equal. This is exactly the "lossy across the 3 mirror copies" pattern this review tier was asked to surface.

**Fix:** Pick one number, codify it in one place (`MAX_REFUSAL_LINES` constant in `detect-stack.ts`), and have the test assert `lines.length ≤ MAX_REFUSAL_LINES`. Update SKILL.md prose to cite the constant by name ("see `MAX_REFUSAL_LINES` in `detect-stack.ts`") rather than hard-coding a number that will drift. If `15` is the real budget, drop it to `15` and tighten the body.

---

### 6. "Checked for" includes `.council-stack-override` unconditionally — even when the malformed-override IS the failure class
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:508-512` (`dedupedMarkerList`) |
| **Principle** | Principle 6 — Dashboards drive action; scanability (P3) |

**Finding:** The dedupe helper always appends `.council-stack-override` to the "Checked for" list. In the `override_malformed` failure class the user sees `.council-stack-override` listed twice: once under "Checked for" and once under "Found at workspace root" as `.council-stack-override (malformed)`. Visually the same token appears in two adjacent sections, which is mild noise — the user momentarily wonders if these are two different files.

**Consequence:** Minor scan friction. AC-3.2 still achievable but the eye lingers.

**Fix:** When the failure class is `override_malformed`, the override is no longer a "checked candidate" — it's the **named culprit**. Move `.council-stack-override` out of "Checked for" in that branch only, or annotate it in-place: `  - .council-stack-override (← see below)`.

---

### 7. Code-fence in SKILL.md uses placeholder `<list filenames you actually saw via 'ls' — no file content>` — model instruction leaks into user-visible template
| | |
|---|---|
| **File** | `~/.claude/skills/council-plan/SKILL.md:81` (+ mirrors at council-implement:81, council-review:81) |
| **Principle** | Principle 9 — Trust; consistency between template and rendered output (P2) |

**Finding:** The Phase 0 refusal body in SKILL.md shows an inline angle-bracket placeholder describing what the model should fill in. If the model ever emits the template literally (a known LLM failure mode under context pressure), the user sees `<list filenames you actually saw via 'ls' — no file content>` in their terminal — a placeholder that reveals the prompt-engineering seam. Worse, the parenthetical fallback `(or "  (no recognised stack markers)" if the workspace is empty of markers)` is shown as TWO lines in the template even though only one of the branches should render.

**Consequence:** Drift risk between SKILL.md (prose with placeholders) and the verifier's `renderRefusal` (which emits the real string). The skill-mirror test only locks marker names and headlines — it does NOT lock the body shape. A model rendering the template verbatim under load would emit something the verifier never produces, and no test catches it.

**Fix:** Replace the inline placeholder with a concrete worked example showing both branches as two separate code blocks: one labelled "Example body — empty workspace" with the literal `  (no recognised stack markers)` line, and one labelled "Example body — ambiguous workspace" showing two filenames. Removes the placeholder seam entirely.

---

### 8. Footer slash-command alignment uses spaces; column width depends on the longest variant name and will drift per skill
| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:493-497` (`OVERRIDE_FOOTER`) |
| **Principle** | Principle 6 — Scanability (P3) |

**Finding:** `OVERRIDE_FOOTER` aligns the trailing comments with a hand-counted run of spaces (`/council-plan-aura      # ...` — six spaces). The `council-implement` and `council-review` mirrors use the same six-space padding even though their command names are 4 chars longer (`council-implement-aura`) — meaning the alignment looks fine in the `plan` version, misaligned in `implement`/`review`. Hand-counted alignment in three mirror copies is a drift trap.

**Consequence:** The two-column "command # comment" pattern is only scannable when columns line up. Misaligned, the eye treats the `#` as inline rather than as a comment delimiter, slowing the read.

**Fix:** Either drop the inline comment entirely (the command name is self-documenting if the names are right per Finding 1), or compute the alignment dynamically: pad to `max(len(commands)) + 2 spaces`. Single source of truth in `detect-stack.ts` for all three mirror copies.

---

## Summary

8 findings — P1: 2, P2: 4, P3: 2

The refusal copy is **structurally sound** — three differentiated headlines, no first-person, no apology, dedup logic intact, content-leak boundary respected. But two production-impacting defects (Findings 1 and 2) break AC-3.2 in the 10-second window: the override footer suggests a non-existent slash command on the python arm, and the `override_malformed` class never tells the user the allow-list. Either alone strands a user who hit the refusal. The remaining six findings are copy drift, jargon leakage, and visual scanability — fixable with single-pass edits, all within the existing line budget once Finding 5 picks one ceiling.
