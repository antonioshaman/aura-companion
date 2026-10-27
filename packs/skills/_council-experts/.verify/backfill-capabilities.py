#!/usr/bin/env python3
"""RC-2 idempotent capability-profile backfill (PLAN Task 2).

Adds `schema_version: 2` + a `capabilities: {signals, domains}` block to every
SEATED advisor's meta.yaml. Idempotent: re-running is a no-op on already-migrated
files (detected by a present `capabilities:` key). Fail-loud: every token is
validated against .verify/capability-vocabulary.json before any write — an
unknown/typo'd token aborts the whole run rather than silently writing a token
that will never match a fingerprint (ritchie B-2 / hunt).

Appends raw YAML text to preserve each file's existing content/quoting verbatim
(clean diff), rather than round-tripping through a YAML dumper.

Seated set = advisors named in any council panel (README): cross-stack + Aura-only
+ Python-only. Unseated dirs (unseated.allow) are intentionally left v1/no-caps —
"no capabilities ⇒ never seated" (AC2.2) is their correct state until promoted.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.dirname(HERE)
VOCAB = os.path.join(HERE, "capability-vocabulary.json")

# Capability profiles for the 14 seated advisors. signals ⊆ vocabulary.signals
# (+ reserved `any` for cross-stack lenses), domains ⊆ vocabulary.domains.
CAP_MAP = {
    # --- cross-stack (seated in both Python and Aura panels) ---
    "hunt":      {"signals": ["any"], "domains": ["security"]},
    "fowler":    {"signals": ["any"], "domains": ["refactoring", "backend-architecture"]},
    "saarinen":  {"signals": ["browser-spa", "react"], "domains": ["ui-visual-quality"]},
    "friedman":  {"signals": ["browser-spa", "cli", "telegram-mini-app"], "domains": ["ux-flow"]},
    "willison":  {"signals": ["any"], "domains": ["llm-pipeline"]},
    "hashimoto": {"signals": ["docker", "github-actions", "systemd", "vps", "cloud-run", "nginx", "kubernetes"], "domains": ["devops-deploy", "ci-supply-chain"]},
    "beck":      {"signals": ["any"], "domains": ["test-quality"]},
    # --- Aura-only ---
    "dahl":      {"signals": ["bun", "node", "typescript", "hono", "express", "fastify", "websocket", "ndjson", "json-rpc", "rest", "sse"], "domains": ["backend-architecture", "protocol-correctness", "realtime-streaming"]},
    "ritchie":   {"signals": ["stdio-subprocess", "cli"], "domains": ["process-lifecycle", "filesystem-persistence"]},
    "abramov":   {"signals": ["react", "vue", "svelte", "nextjs", "browser-spa", "typescript", "javascript"], "domains": ["frontend-architecture"]},
    "watson":    {"signals": ["browser-spa", "react"], "domains": ["accessibility"]},
    # --- Python-only ---
    "durov":     {"signals": ["telegram-bot", "telegram-mini-app"], "domains": ["chat-platform-ux", "ux-flow"]},
    "vanrossum": {"signals": ["python", "cpython", "aiogram", "fastapi", "flask", "django", "starlette"], "domains": ["backend-architecture"]},
    "brandur":   {"signals": ["postgres", "sqlite", "mysql", "sqlalchemy", "alembic", "prisma", "drizzle"], "domains": ["database-persistence", "schema-migrations"]},
}


def load_vocab():
    v = json.load(open(VOCAB))
    signals = {t for grp in v["signals"].values() for t in grp}
    domains = set(v["domains"])
    return signals, domains


def yaml_list(items):
    return "[" + ", ".join(items) + "]"


def main():
    signals_vocab, domains_vocab = load_vocab()
    # Fail-loud validation pass BEFORE any write.
    for aid, cap in CAP_MAP.items():
        bad_s = [t for t in cap["signals"] if t not in signals_vocab]
        bad_d = [t for t in cap["domains"] if t not in domains_vocab]
        if bad_s or bad_d:
            sys.exit(f"ABORT {aid}: signals not in vocab {bad_s}; domains not in vocab {bad_d}")
        meta = os.path.join(CATALOG, aid, "meta.yaml")
        if not os.path.isfile(meta):
            sys.exit(f"ABORT {aid}: meta.yaml missing at {meta} (seated advisor must have one)")

    changed, skipped = [], []
    for aid, cap in CAP_MAP.items():
        meta = os.path.join(CATALOG, aid, "meta.yaml")
        text = open(meta).read()
        if "capabilities:" in text:
            skipped.append(aid)
            continue
        block = text.rstrip("\n") + "\n"
        block += "schema_version: 2\n"
        block += "capabilities:\n"
        block += f"  signals: {yaml_list(cap['signals'])}\n"
        block += f"  domains: {yaml_list(cap['domains'])}\n"
        open(meta, "w").write(block)
        changed.append(aid)

    print(f"backfill: {len(changed)} migrated, {len(skipped)} already-present")
    if changed:
        print("  migrated:", ", ".join(sorted(changed)))
    if skipped:
        print("  skipped :", ", ".join(sorted(skipped)))


if __name__ == "__main__":
    main()
