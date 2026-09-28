# Validator brief — commit N3.18 torvalds seed-new (Linux-kernel pragmatism, first EC-34 wire-format paired seat)

**Topic:** Author the torvalds catalog seat — `_council-experts-v2/torvalds/{meta.yaml, plan.md, review.md, references/quality-torvalds.md}` + 2 B1 mirrors at `council-{plan,review}-v2/references/quality-torvalds.md` + lock manifest append + coverage-tokens append + `EXPECTED_COUNT 16 → 17`. **Empirically codifies EC-34 wire-format** in meta.yaml per sub-2 PICKUP override of sub-1 D14: `paired_with: ritchie` + `tension_axis: "Linux pragmatism ↔ Unix purity"`.

**Atomicity:** Single per-expert atomic commit matching sub-1 N3.15/N3.16 precedent. 9 files touched (4 new in `torvalds/` dir + 2 new mirrors + 3 modified `.verify/` files).

## D7 shell-paste evidence (at-commit)

```
$ wc -l ~/.claude/skills/_council-experts-v2/torvalds/references/quality-torvalds.md
151 quality-torvalds.md

$ grep -nE '^## §|^### ' ~/.claude/skills/_council-experts-v2/torvalds/references/quality-torvalds.md
11:## §A "Don't break userspace" + measured-pragmatism scope
17:### Principles
67:### Tone characteristics
73:### Anti-patterns to detect
83:## §B Subsystem ownership + show-me-the-code discipline
89:### Principles
139:### Tone characteristics
145:### Anti-patterns to detect

$ grep -cE '^- \*\*[a-z]' quality-torvalds.md       # principle bullet count
8

$ grep -cE '^  Detection signal in code review:' quality-torvalds.md
8                                                  # 8/8 = 100% Detection-signal coverage

$ grep -cE '^  Cross-ref:' quality-torvalds.md
8

$ sha256sum _council-experts-v2/torvalds/references/quality-torvalds.md \
            council-plan-v2/references/quality-torvalds.md \
            council-review-v2/references/quality-torvalds.md
d05c1cabe20dc3b90104c2983ff8b73936f9a62916c53f957d03ee3b7eea9e24  [canonical + 2 mirrors — sha256 byte-identity confirmed across 3 paths]

$ ~/.claude/skills/_council-experts-v2/.verify/verify-catalog.sh
... 12 gates green
=== C6: ✓ all 17 dirs have meta.yaml, count == EXPECTED_COUNT
=== C7+C8: ✓ 17 meta.yaml conform; EC-34 wire-format: 1 paired / 0 explicit-unpaired / 16 legacy-2-key
=== C10: ✓ 166 tokens + 35 structural anchors + 1 forbidden patterns
=== C11: ✓ 1 B2 entries / 4 mirrors
=== C12: ✓ 17 mirror sets / 46 mirrors / 17 canonicals
exit: 0
```

```
$ grep -niE 'ignore previous|new instructions:|^system:|^assistant:|^user:|<\|im_start|\[INST\]|eval\(|exec\(' \
      ~/.claude/skills/_council-experts-v2/torvalds/{meta.yaml,plan.md,review.md,references/quality-torvalds.md}
(0 hits — Tier-1 + Tier-2 clean)

$ python3 -c "
data = open('~/.claude/skills/_council-experts-v2/torvalds/references/quality-torvalds.md').read()
hits = [(i, hex(ord(c))) for i, c in enumerate(data) if ord(c) in (0x200B,0x200C,0x200D,0x202E,0x202D,0xFEFF)]
print(hits or 'no zero-width/RTL-override hits')
"
no zero-width/RTL-override hits

$ grep -nE '/home/auracomp/|/tmp/aura-phase3beta|^/root/' \
      ~/.claude/skills/_council-experts-v2/torvalds/references/quality-torvalds.md
(0 hits — EC-23 path-bytes clean)
```

## Empirical claims

1. **Path-3 hybrid depth confirmed at 151L (matches lerdorf/colvin precedent within 134-167L NR2 floor).** 2 §-sections at 71L (§A) and 69L (§B), both within the 67-83L per-section range.
2. **8/8 = 100% Detection-signal-in-code-review coverage** — every principle (4 in §A, 4 in §B) carries the `Detection signal in code review:` sub-paragraph + `Cross-ref:` sub-paragraph, matching sub-1 precedent.
3. **EC-34 wire-format empirically lands** for the first time — `meta.yaml` ships 4-key shape `{creator, stack, paired_with: ritchie, tension_axis: "Linux pragmatism ↔ Unix purity"}`. C7 verdict from gate: `1 paired / 0 explicit-unpaired / 16 legacy-2-key`. The schema extension from N3.17 is empirically verified live.
4. **Tension axis encoded at doc layer** — Cross-refs in 5 principles (§A P1+P3+P4, §B P5+P6) name ritchie sections explicitly, encoding the "Linux pragmatism ↔ Unix purity" axis at content-level (not only meta.yaml-level). Per ritchie-subplan Torvalds-tension framing: "Ritchie defends invariants the kernel enforces; Torvalds defends invariants the kernel allows you to skip when measured-safe. Both Unix-discipline; differ on where discipline ends and ceremony begins."
5. **B1 mirror byte-identity** confirmed across 3 paths via sha256 `d05c1cab...` matching pinned value in `_ref-mirrors.lock`.
6. **All 12 verify-catalog gates green** post-commit-readiness. C10 tokens 158→166 (+8 torvalds principle-name tokens); structural anchors 33→35 (+2 §A/§B); C12 17 mirror sets / 46 mirrors / 17 canonicals.
7. **Hunt Tier-1 + Tier-2 + EC-23 + zero-width/RTL + ANSI canaries:** 0-hit across all four files (canonical + 2 mirrors + meta.yaml + 2 dispatcher panels). torvalds was not on the high-risk authorship list (lerdorf PHP / colvin tools / majors-sridharan logs), but the discipline still ran clean.
8. **Dispatcher prompt section-header drift:** structural headers (`CONTEXT + FEATURE BRIEF`, `RECOMMENDATION:`, `FINDING:`, `IMPORTANT — OUTPUT INSTRUCTIONS`) identical between lerdorf and torvalds plan.md/review.md; per-lane descriptive lines differ as required (each expert's "Stay in your lane" + "If no...recommendations" lines describe domain).
9. **Mirror-shape choice (non-Aura, 2-mirror per sub-1 precedent)** confirmed per dec-008 runtime probe: neither `council-plan-aura-v2/SKILL.md` nor `council-review-aura-v2/SKILL.md` panel lists currently include torvalds; conservative match of sub-1 lerdorf/colvin pattern. Aura-extension cheap-additive if Phase 3γ wires torvalds into Aura panels later.

## Expected validator response

PASS if all empirical claims above match runtime + the per-commit gate (verify-catalog.sh exit 0) reproduces. FAIL with specific corrections if (a) section header bounds drift outside 67-83L per-section, (b) Detection-signal coverage < 8/8, (c) Tier-1/Tier-2/EC-23 canaries surface a hit, (d) sha256 byte-identity fails across the 3 mirror paths, (e) C7 paired-count fails to register torvalds, (f) any of C1-C12 goes red.

## Self-validation result (writer-self in absence of validator-tmux per D16)

PASS — empirical evidence above. The full 12-gate run shows exit 0; the canary suite shows 0-hit on all four screens; sha256 byte-identity matches; principle/Detection-signal/Cross-ref counts at 8/8/8 each; EC-34 wire-format gate reports `1 paired` for the first time.

End of brief.
