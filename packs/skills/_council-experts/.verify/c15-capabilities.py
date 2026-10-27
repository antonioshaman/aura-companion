#!/usr/bin/env python3
"""C15 — capability-profile schema gate (RC-2, PLAN Task 10 / hashimoto D1+D2).

The RC-2 selection engine seats advisors by matching a fingerprint against each
advisor's `capabilities` profile. This gate makes the profile contract
mechanically enforceable so a typo'd/unknown/malformed token fails CI instead of
silently making an advisor unseatable (its runtime failure mode is invisible).

Validates:
  1. `.verify/capability-vocabulary.json` is well-formed (schema_version, non-empty
     closed `signals` groups + `domains`).
  2. Every advisor dir carrying a `capabilities` block has a SCHEMA-VALID one:
     non-empty string lists, every signal ∈ vocab.signals, every domain ∈
     vocab.domains. A malformed/unknown-token profile FAILS (loud) — it is never
     silently dropped.
  3. The seatable universe (dirs with a valid capabilities block) is non-empty
     (zero-dangling: an empty universe is itself a failure).

A dir WITHOUT a `capabilities` block is fine (deliberately unseated / not-yet-
migrated) — absence is a known state, malformation is not.

Exit 0 = green, 1 = at least one violation.
"""
import json
import os
import sys

try:
    import yaml
except ImportError:
    print("  ✗ python3 `yaml` module unavailable — cannot validate capability profiles")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.dirname(HERE)
VOCAB = os.path.join(HERE, "capability-vocabulary.json")

errors = []


def load_vocab():
    if not os.path.isfile(VOCAB):
        errors.append(f"vocabulary missing at {VOCAB}")
        return None
    try:
        v = json.load(open(VOCAB))
    except Exception as e:  # noqa: BLE001
        errors.append(f"vocabulary is not valid JSON: {e}")
        return None
    if v.get("schema_version") != 1:
        errors.append("vocabulary schema_version must be 1")
    sig = set()
    groups = v.get("signals")
    if not isinstance(groups, dict) or not groups:
        errors.append("vocabulary.signals must be a non-empty object of groups")
        groups = {}
    for grp in groups.values():
        if isinstance(grp, list):
            for t in grp:
                if isinstance(t, str):
                    sig.add(t.lower())
    dom = set(t.lower() for t in v.get("domains", []) if isinstance(t, str))
    if not sig:
        errors.append("vocabulary has no signal tokens")
    if not dom:
        errors.append("vocabulary has no domain tokens")
    return sig, dom


def validate_tokens(raw, vocab, label, advisor):
    if not isinstance(raw, list) or len(raw) == 0:
        errors.append(f"{advisor}: capabilities.{label} must be a non-empty list")
        return
    for t in raw:
        if not isinstance(t, str):
            errors.append(f"{advisor}: capabilities.{label} has a non-string member {t!r} (YAML coercion?)")
            continue
        if t.lower() not in vocab:
            errors.append(f"{advisor}: capabilities.{label} token '{t}' is not in the vocabulary")


def main():
    loaded = load_vocab()
    if loaded is None:
        _report()
        return
    sig_vocab, dom_vocab = loaded

    seatable = 0
    for name in sorted(os.listdir(CATALOG)):
        if name.startswith("."):
            continue
        meta = os.path.join(CATALOG, name, "meta.yaml")
        if not os.path.isfile(meta):
            continue
        try:
            doc = yaml.safe_load(open(meta))
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: meta.yaml is not valid YAML: {e}")
            continue
        if not isinstance(doc, dict):
            errors.append(f"{name}: meta.yaml is not a mapping")
            continue
        caps = doc.get("capabilities")
        if caps is None:
            continue  # deliberately unseated / not-yet-migrated — fine
        if not isinstance(caps, dict):
            errors.append(f"{name}: capabilities must be a mapping")
            continue
        validate_tokens(caps.get("signals"), sig_vocab, "signals", name)
        validate_tokens(caps.get("domains"), dom_vocab, "domains", name)
        # count as seatable only if it passed (no error added for this advisor in this pass)
        if not any(e.startswith(f"{name}:") for e in errors):
            seatable += 1

    if seatable == 0 and not errors:
        errors.append("no seatable advisor (zero dirs carry a valid capabilities block)")

    _report(seatable)


def _report(seatable=0):
    if errors:
        for e in errors:
            print(f"  ✗ {e}")
        sys.exit(1)
    print(f"  ✓ vocabulary valid; {seatable} advisors carry schema-valid capability profiles")
    sys.exit(0)


if __name__ == "__main__":
    main()
