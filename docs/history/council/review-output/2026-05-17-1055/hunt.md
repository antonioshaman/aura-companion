# Hunt — Security Review (v2 router A/B detector)

Scope: `web/scripts/detect-stack.ts` only — read-side, no HTTP/WS/spawn/persistence. Reviewed against §A attack surface, §B credential & secret hygiene (specifically secret-leakage channel), and the AC-3.3 fail-closed contract.

The detector is well-scoped and the EC-7 resolving wrapper (`resolveMarker`) is the right architectural shape — a single chokepoint for every filesystem access with explicit symlink rejection, bounds-check on the realpath, and a closed `MarkerReason` enum that doubles as the content-leak boundary. The findings below are all P2/P3: defensive gaps and hygiene observations, not exploit paths in production code. No P1.

---

### 1. JSON parse success on non-object root silently treats malformed-in-spirit packages as "absent rather than malformed"

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:213-226` |
| **Principle** | §A fail-closed vs fail-open / AC-3.3 "never silently downgrades malformed to absent" |

**Finding:** When `web/package.json` contains valid JSON whose root value is `null`, a boolean, a number, an array, or a string (rather than an object), `probePackageJson` coerces it to `{}` via the `pkg && typeof pkg === "object"` guard and returns `parsed: true` with no match and no `reason`. This is observationally indistinguishable from "the file parses to an empty object" — both look like "marker file present, no match, no error".
**Consequence:** A user whose `package.json` got truncated to e.g. `null` or to a bare array (rare but possible via a botched merge or a misconfigured pre-commit formatter) will see "Found at workspace root: web/package.json" with no `(json_parse)` annotation, even though the file's contents are semantically unusable. The detector falls through to `unknown` for the right reason but for the wrong forensic story — the operator cannot tell from the refusal whether the file is structurally bad. This is exactly the spirit of AC-3.3 the spec is guarding ("never silently downgrades malformed to absent"), even though the letter is satisfied (no fallback to `aura`).
**Fix:** Treat any JSON parse result whose root is not a plain object as a structured failure: return `parsed: false, reason: "json_parse"` from the same branch that already catches throw-on-parse. One extra conditional after `JSON.parse` keeps the failure mode legible and the refusal honest.

---

### 2. TOCTOU window between realpath bounds-check and file read

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:126-133, 159` |
| **Principle** | §A zero trust / defence in depth at validation gates |

**Finding:** `resolveMarker` validates that `realpathSync(candidate)` is within `rootResolved + sep`, then returns `r.absolute = candidate` (the pre-resolution path). The subsequent `readFileSync(absolute, "utf8")` reads `candidate` again, not `real`. Between the realpath check and the read, an attacker who can write to the workspace could replace a regular file with a symlink whose target is outside the workspace; the second read follows the new symlink.
**Consequence:** In the deployed threat model (developer tool, single-user workspace, no untrusted concurrent writers) this race is uneconomic to mount and the worst-case yield is one file's first 64 KB being interpreted as a marker (no exfil channel — the contents are not echoed in the refusal). Real risk is bounded to "could `detectStack` mis-classify a stack if a hostile sibling process is racing it" — practically zero for this surface. The finding is hygiene-only.
**Fix:** Read from the resolved canonical path rather than the pre-resolution candidate — pass `real` (or call `realpathSync` again at read time and assert bounds again) to `readText`. Belt-and-suspenders only; not load-bearing for the current scope but cheap to add and durable against any future caller that points this detector at a less-trusted directory.

---

### 3. Path-traversal pre-check is substring-based, not resolution-based

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:108-109` |
| **Principle** | §A secure defaults / defence in depth — controls that survive refactor |

**Finding:** The traversal guard is `relativeMarker.startsWith("/") || relativeMarker.includes("..")`. The current set of marker names is hardcoded and safe, so the guard is never the line that catches a real attack — the load-bearing defence is the realpath bounds-check on line 130. But the substring guard is brittle: any future marker name that legitimately contains `..` (e.g. `tsconfig..base.json`-style naming, or a relative marker passed through some helper that hasn't sanitised) would be rejected as `out_of_bounds`, and any marker accidentally hardcoded with a leading slash would be rejected without surfacing the cause.
**Consequence:** Future-refactor footgun, not a current vulnerability. A reviewer extending `MARKER_NAMES` could pass a benign-looking string and get an opaque `out_of_bounds` reason in the refusal that does not match the actual problem.
**Fix:** Drop the substring guards and rely entirely on the realpath bounds-check (line 130) — it is strictly stronger and already canonical. Alternatively, keep the substring guard but rename the reason to reflect that the cause is a syntactic-form-check, not a resolved-out-of-tree detection, so the refusal stays accurate.

---

### 4. `read_error` reason is overloaded across at-least-three distinct failure modes

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:69-74, 119, 128, 149, 154, 162` |
| **Principle** | §C breach forensics — logs that capture outcomes but not inputs are a forensic dead-end |

**Finding:** The `MarkerReason` enum collapses three observably-distinct failure modes into one bucket: (a) `lstatSync` throws (line 119), (b) `realpathSync` throws on a non-symlink leaf (line 128), (c) `statSync` reports the path is not a regular file — e.g. a fifo, socket, or block device (line 149), (d) `readFileSync` throws after a successful stat — typically a transient I/O error or permission change mid-read (line 162). All four surface as `reason: "read_error"` in the refusal. The refusal's "Found at workspace root: pyproject.toml (read_error)" gives the operator no actionable signal — is the file unreadable due to permissions, is it a device node, or did something happen mid-read?
**Consequence:** Not a security exploit; a forensic narrative gap. When an end-user reports "the detector refuses on a workspace I think should detect cleanly", the maintainer has no way to triage the cause from the refusal text alone and has to ask for a strace or a manual reproduction.
**Fix:** Split `read_error` into `not_regular_file`, `permission_denied`, and `io_error` (or leave one `read_error` catchall but emit the underlying errno class as a short annotation — `errno=EACCES`, `errno=EISDIR`, etc.). The errno class is not a content leak (it's a kernel-level error code from a closed list) and it sharply improves post-incident diagnostics in the spirit of §C "capture inputs, not only outcomes".

---

### 5. `dedupedMarkerList` always appends `OVERRIDE` even when refusal cause is unrelated

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:499-514, 528-532` |
| **Principle** | §A secure defaults — the message the operator reads must guide them to the safer action |

**Finding:** When `kind === "ambiguous"` (both Aura and Python markers present, no override file), the refusal still says "Checked for: ... .council-stack-override" and the footer says "To override, run: /council-plan-aura | /council-plan-python". This is correct and helpful — the operator's escape hatch IS the suffixed skills. But the *enumeration* claims the detector checked an override file that the operator may not even know exists; combined with the suffixed-skill footer, the operator may infer that creating `.council-stack-override` is the recommended path rather than running the suffixed skill directly.
**Consequence:** Behavioural drift, not a vulnerability. Over time, more workspaces will accumulate `.council-stack-override` files than need them. Each such file is a new piece of in-repo state with its own provenance question ("who put this here?", "is this still correct?"). The override is a power-user escape hatch; surfacing it equally with the suffixed skill nudges users toward the higher-state-cost path.
**Fix:** In the refusal footer, lead with the suffixed-skill option and demote `.council-stack-override` to a parenthetical "(advanced: persist the choice by writing 'aura' or 'python' to .council-stack-override)". Keeps both paths discoverable; biases the default toward the lower-state-cost one.

---

### 6. Refusal does not annotate the override file when present-but-malformed

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:546-548` |
| **Principle** | §C breach forensics — name what is known, name what is being investigated |

**Finding:** When `result.overrideMalformed === true` and at least one marker is also present, the refusal appends `.council-stack-override (malformed)` to the "Found at workspace root" list (line 547). But when the override is malformed AND no other markers are present, the refusal goes through the `present.length === 0` branch (line 537) and prints "(no recognised stack markers)" — without ever mentioning that an override file was found on disk and rejected. The condition `!result.overrideMalformed` on line 537 saves the `.council-stack-override (malformed)` annotation, but the path through line 539-548 never iterates `present` in the empty case.
**Consequence:** Operator sees the `override_malformed` headline (correct) and "no recognised stack markers" — without seeing that the malformed override file is literally sitting at the workspace root. They may not understand which file to fix without re-reading the headline. Forensic narrative is slightly degraded; AC-3.1 ("refusal names markers checked + filenames found") is technically met via the "Checked for" list but the operationally-relevant "this file at this path is malformed" callout is buried.
**Fix:** When `overrideMalformed` is true, always append a `.council-stack-override (malformed)` line under "Found at workspace root", regardless of whether other markers were present. One extra branch in the empty-list path of `renderRefusal`.

---

### 7. Override allow-list match is case-sensitive and whitespace-tolerant only at the boundary

| | |
|---|---|
| **File** | `web/scripts/detect-stack.ts:383-405` |
| **Principle** | §A secure defaults / spec AC-3.3 — fail loud on malformed, not silent on borderline |

**Finding:** `readOverride` trims whitespace then exact-matches against `["aura", "python"]`. `"AURA"`, `"Aura"`, `"aura\nfoo"`, `"aura python"` all become `malformed: true` and the detector refuses loudly. This is correct fail-closed behaviour. However, the headline `REFUSAL_HEADLINES.override_malformed` ("Stack detection: .council-stack-override is malformed.") does not tell the operator *what* the allowed values are, and the override footer (lines 493-497) names the suffixed *skills* rather than the allowed override *values*. An operator who wrote `Aura` (capital A) and reads only the headline will have no in-message hint about the case-sensitivity.
**Consequence:** Hygiene observation. The operator can find the answer by reading the source or by guessing — but Hunt's "controls that survive contact with reality" frame says the refusal should not require the operator to read the source to recover.
**Fix:** Either add a one-line "(allowed values: aura, python)" annotation under the `override_malformed` headline, or make the value-comparison case-insensitive after trim (`trimmed.toLowerCase()` against the allow-list). The first is preferable — it preserves the strict contract while making the failure self-explanatory.
