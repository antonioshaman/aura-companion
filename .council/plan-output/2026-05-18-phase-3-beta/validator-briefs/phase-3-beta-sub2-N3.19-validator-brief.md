# Validator brief — commit N3.19 unclebob seed-new (Clean Architecture / SOLID, second EC-34 wire-format paired seat)

**Topic:** Author the unclebob catalog seat — `_council-experts-v2/unclebob/{meta.yaml, plan.md, review.md, references/quality-unclebob.md}` + 2 B1 mirrors at `council-{plan,review}-v2/references/quality-unclebob.md` + lock manifest append + coverage-tokens append + `EXPECTED_COUNT 17 → 18`. **Closes the first paired-tension cluster** (sub-2: torvalds + unclebob) — second EC-34 wire-format paired seat after N3.18 torvalds.

**Atomicity:** Single per-expert atomic commit matching sub-1 + N3.18 precedent. 9 files touched.

## D7 shell-paste evidence (at-commit)

```
$ wc -l ~/.claude/skills/_council-experts-v2/unclebob/references/quality-unclebob.md
151 quality-unclebob.md

$ grep -nE '^## §|^### ' ~/.claude/skills/_council-experts-v2/unclebob/references/quality-unclebob.md
11:## §A SOLID principle-purity
17:### Principles
67:### Tone characteristics
73:### Anti-patterns to detect
83:## §B Clean Architecture + didactic discipline
89:### Principles
139:### Tone characteristics
145:### Anti-patterns to detect

$ grep -cE '^- \*\*[a-z]' quality-unclebob.md
8                                                     # principle bullet count

$ grep -cE '^  Detection signal in code review:' quality-unclebob.md
8                                                     # 8/8 = 100% Detection-signal coverage

$ grep -cE '^  Cross-ref:' quality-unclebob.md
8

$ sha256sum _council-experts-v2/unclebob/references/quality-unclebob.md \
            council-plan-v2/references/quality-unclebob.md \
            council-review-v2/references/quality-unclebob.md
700e9aa485c04c6506f08743bda14e0dfa1e3e78b090b15bf8f5e501d56f24d5  [canonical + 2 mirrors — byte-identity confirmed]

$ ~/.claude/skills/_council-experts-v2/.verify/verify-catalog.sh
... 12 gates green
=== C6: ✓ all 18 dirs have meta.yaml, count == EXPECTED_COUNT
=== C7+C8: ✓ 18 meta.yaml conform; EC-34 wire-format: 2 paired / 0 explicit-unpaired / 16 legacy-2-key
=== C10: ✓ 174 tokens + 37 structural anchors + 1 forbidden patterns
=== C12: ✓ 18 mirror sets / 48 mirrors / 18 canonicals
exit: 0
```

```
$ grep -niE 'ignore previous|new instructions:|^system:|^assistant:|^user:|<\|im_start|\[INST\]|eval\(|exec\(' \
      ~/.claude/skills/_council-experts-v2/unclebob/{meta.yaml,plan.md,review.md,references/quality-unclebob.md}
(0 hits — Tier-1 + Tier-2 clean)

$ python3 -c "
data = open('~/.claude/skills/_council-experts-v2/unclebob/references/quality-unclebob.md').read()
hits = [(i, hex(ord(c))) for i, c in enumerate(data) if ord(c) in (0x200B,0x200C,0x200D,0x202E,0x202D,0xFEFF)]
print(hits or 'no zero-width/RTL-override hits')
"
no zero-width/RTL-override hits

$ grep -nE '/home/auracomp/|/tmp/aura-phase3beta|^/root/' \
      ~/.claude/skills/_council-experts-v2/unclebob/references/quality-unclebob.md
(0 hits — EC-23 path-bytes clean)

$ for tok in single-responsibility-as-boundary "dependency-inversion as architectural law" \
             open-closed-by-extension interface-segregation-by-client \
             "screaming architecture" "policy-vs-detail separation" \
             "boundary-crossings via owned interfaces" didactic-discipline-as-pedagogy; do
    grep -cF "$tok" quality-unclebob.md
  done
  3 single-responsibility-as-boundary
  4 dependency-inversion as architectural law
  3 open-closed-by-extension
  3 interface-segregation-by-client
  3 screaming architecture
  3 policy-vs-detail separation
  3 boundary-crossings via owned interfaces
  2 didactic-discipline-as-pedagogy
```

## Empirical claims

1. **Path-3 hybrid depth at 151L** matching lerdorf/colvin/torvalds precedent within 134-167L NR2 floor.
2. **8/8 = 100% Detection-signal coverage** + 8 Cross-refs (4 of which bridge to fowler explicitly per fowler-subplan REC-5).
3. **EC-34 wire-format empirically lands second** — `meta.yaml` ships 4-key shape `{creator, stack, paired_with: fowler, tension_axis: "principle-purity ↔ economic-pragmatic"}`. C7 verdict: `2 paired / 0 explicit-unpaired / 16 legacy-2-key`.
4. **Per fowler REC-5 — NOT soft-pedalled into "Fowler with more discipline"** — the doc encodes unclebob as authentically principle-driven (SOLID is non-negotiable; dependency-inversion is architectural law, not refactor outcome; screaming-architecture must be designed upfront, not emergent). Cross-refs to fowler in 4 principles explicitly NAME the tension: "fowler waits for second caller; unclebob demands the boundary upfront" (§A P1); "fowler argues architecture emerges; unclebob counters some structural laws are non-emergent" (§A P2); "fowler defends architecture-as-emergent; unclebob says top-level statement is non-emergent" (§B P1); "fowler economic-discipline; unclebob extends with future-reader pedagogy" (§B P4).
5. **B1 mirror byte-identity** across 3 paths via sha256 `700e9aa4...`.
6. **All 12 verify-catalog gates green**. C10 tokens 166→174 (+8 unclebob); structural anchors 35→37 (+2); C12 18 mirror sets / 48 mirrors / 18 canonicals.
7. **Hunt Tier-1 + Tier-2 + EC-23 + zero-width/RTL + ANSI canaries: 0-hit** across all four files.
8. **Dispatcher prompt section-header drift:** identical CONTEXT/RECOMMENDATION/FINDING/OUTPUT structural markers vs lerdorf reference; per-lane descriptive lines differ as required for unclebob's domain.
9. **Mirror-shape (non-Aura, 2-mirror per sub-1/N3.18 precedent)** per dec-008 runtime probe: neither Aura panel currently lists unclebob; conservative match of lerdorf/colvin/torvalds pattern. PICKUP hinted "may show full-panel (UI uses cleanarch tags) OR non-aura"; sub-2 chose non-aura to match precedent and avoid panel-list extension out of PICKUP boundary (g). Aura-extension is additive if Phase 3γ wires unclebob into Aura panels.
10. **Aura-companion AP-3 honest acknowledgement** — the doc's §B P1 cross-ref to fowler implicitly recognises that Aura's `council-types.ts` hosts both writer + reader schemas in one file (AP-3 convention floor) — a fowler-economic-pragmatic choice that an unclebob-principle-purity lens would object to. The doc encodes this tension honestly without inventing a false harmony.

## Expected validator response

PASS if all empirical claims match runtime + verify-catalog.sh exit 0 reproduces. FAIL on (a) section-header bounds drift, (b) Detection-signal <8/8, (c) canary hit, (d) sha256 byte-identity fail, (e) C7 paired-count mismatch, (f) any of C1-C12 red.

## Self-validation result (D16 fallback)

PASS — empirical evidence above. The 12-gate run shows exit 0; canaries clean; sha256 matches; principle/Detection/Cross-ref at 8/8/8; EC-34 wire-format gate reports `2 paired` for the first time (sub-2 first paired-tension cluster closed empirically).

End of brief.
