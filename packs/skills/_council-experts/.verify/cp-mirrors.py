#!/usr/bin/env python3
"""cp-mirrors.py — B2 build-time runner for council-experts catalog mirrors.

Reads `_council-experts/.verify/_phase2-merges.yml`, validates schema +
expert-ID regex + ref-path shape + realpath bounds, and for each merge entry
that has a `b2:` block materialises `canonical → mirrors[]` atomically
(tmp+fsync+rename, mode 0644).

Modes
-----
  cp-mirrors.py              — materialise mirrors (default; idempotent)
  cp-mirrors.py --check      — verify schema + IDs + readability + byte-identity
                               of existing mirrors; exit 1 on any drift; NO
                               filesystem mutation. Byte-identity is checked
                               over the mirror groups declared in
                               `_ref-mirrors.lock` (the full relationship), not
                               only the `b2:` blocks in `_phase2-merges.yml`
                               (the build recipe, which covers 4 of 56 mirrors).
  cp-mirrors.py --selftest   — run adversarial ID-regex tests against the
                               same regex objects used by the runner; useful
                               for refactor regressions.

Defences (Hunt REC-4 + REC-7 + supply-chain hardening from council plan Task 8)
-----------------------------------------------------------------------------
  - Expert-ID regex `^[a-z][a-z0-9-]{1,31}$` enforced at every YAML-derived
    ID (targets + sources) per `feedback_call_site_presence_not_just_symbol_export`.
  - Ref-path regex `^[a-z][a-z0-9-]{0,63}(/[a-z][a-z0-9_.-]{0,63})*$` rejects
    `..`, leading `/`, `~`, `$`, NUL, control chars, backslashes, whitespace.
  - Realpath bounds: every canonical/mirror path resolves under SKILLS root;
    any escape (symlink trickery, `..` survival) → ValueError before any I/O.
  - Atomic mirror writes via tmp+fsync+os.replace (POSIX-atomic rename); leak
    cleanup in finally.
  - argv-form throughout (subprocess.run never used; pure stdlib I/O — no
    shell, no globbing, no IFS interaction).
  - Idempotent: mirrors already sha256-identical to canonical are skipped
    (avoids spurious mtime bumps for clean re-runs).
  - --check mode also asserts the property dispatch actually depends on — that
    the catalog and every reference document are readable by this process —
    plus no executable bit on data files and no group/world-writable config.
    It deliberately does NOT assert a mode floor: tightening the catalog to
    0750 is safer, not a violation.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("✗ pyyaml not available — install python3-yaml", file=sys.stderr)
    sys.exit(2)

# --- regex authorities (single source) ----------------------------------------

ID_REGEX = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
# Ref-path: lowercase ASCII; first segment also accepts leading `_` so the
# catalog-root sentinel `_council-experts/...` validates (Phase 1 naming
# convention reserves leading-`_` for infrastructure dirs). Non-first segments
# additionally accept `.` and `_` so filenames like `quality-hashimoto.md` and
# subdir names with intra-name underscores validate. Forbids: '..', leading
# '/', '~', '$', NUL, control, backslash, whitespace (by construction — the
# character class is closed). Council plan Task 8 cited a stricter form
# `^[a-z][a-z0-9-]{...}` without leading-`_`; relaxed here per the
# concrete canonical path under audit (HANDOFF wins via
# `feedback_multi_source_instruction_contradiction_defer_surface`: surfaced
# explicitly in the N2 commit message rather than silently broadened).
REF_PATH_REGEX = re.compile(r"^[a-z_][a-z0-9_-]{0,63}(/[a-z][a-z0-9_.-]{0,63})*$")

# Phase-2 allow-lists (intentional hand-curation; widens only with explicit
# review per Hunt REC-4 closed-set principle).
TARGET_ALLOWLIST = frozenset({"dahl", "ritchie", "hashimoto"})
SOURCE_ALLOWLIST = frozenset({
    "backend-ts", "realtime-ndjson",
    "subprocess", "persistence-fs",
    "deploy-docker-gha", "deploy-vps",
})

ALLOWED_MERGE_KEYS = frozenset({"target", "sources", "reason", "b2"})
ALLOWED_B2_KEYS = frozenset({"canonical", "mirrors"})

# Destination policy for the materialiser. `_resolve_bounded` stops a write from
# leaving the skills root, which leaves everything INSIDE it as a legal target:
# `mirrors: [council-review-aura/SKILL.md]` in the YAML would have made this
# script overwrite the Chair's dispatch instructions with an expert's reference
# doc, and `_council-experts/hunt/review-aura.md` would have let it overwrite a
# subagent prompt. Both are files an agent then reads and obeys.
#
# A mirror may only be a reference doc under a dispatcher's `references/`. That
# is the only kind of file this script has any business creating: mirrors exist
# so a dispatcher can inject a doc without reaching into the catalog. SKILL.md
# and the catalog prompts are authored, never generated.
MIRROR_DEST_REGEX = re.compile(
    r"^council-(plan|review|implement)(-aura)?/references/[a-z][a-z0-9_.-]{0,63}\.md$"
)
# A canonical is read, not written, so its policy is only about provenance: it
# must be a reference doc too — either the catalog copy or (for dahl/ritchie,
# whose canonical still lives beside its consumer) a dispatcher's.
CANONICAL_SRC_REGEX = re.compile(
    r"^(_council-experts/[a-z][a-z0-9-]{1,31}/references/[a-z][a-z0-9_.-]{0,63}\.md"
    r"|council-(plan|review|implement)(-aura)?/references/[a-z][a-z0-9_.-]{0,63}\.md)$"
)

# --- locations ---------------------------------------------------------------

HERE = Path(__file__).resolve().parent
CATALOG_ROOT = HERE.parent
SKILLS_ROOT = CATALOG_ROOT.parent
MERGES_YAML = HERE / "_phase2-merges.yml"


# --- validators ---------------------------------------------------------------


class SchemaError(ValueError):
    pass


def _check_id(s, ctx):
    if not isinstance(s, str):
        raise SchemaError(f"{ctx}: expected str, got {type(s).__name__}")
    if not ID_REGEX.match(s):
        raise SchemaError(f"{ctx}: invalid ID {s!r} (must match {ID_REGEX.pattern})")
    return s


def _check_ref_path(p, ctx):
    if not isinstance(p, str):
        raise SchemaError(f"{ctx}: expected str, got {type(p).__name__}")
    # Defense-in-depth: explicit substring rejects BEFORE the regex (regex would
    # also reject these, but explicit failure gives a clearer diagnostic).
    for forbidden in ("..", "//", "\x00", "\\"):
        if forbidden in p:
            raise SchemaError(f"{ctx}: forbidden substring {forbidden!r} in path {p!r}")
    if p.startswith("/") or p.startswith("~") or p.startswith("$"):
        raise SchemaError(f"{ctx}: path must not start with /, ~, or $: {p!r}")
    if not REF_PATH_REGEX.match(p):
        raise SchemaError(f"{ctx}: invalid ref path {p!r} (must match {REF_PATH_REGEX.pattern})")
    return p


def _resolve_bounded(rel_path, ctx):
    """Resolve rel_path against SKILLS_ROOT realpath; reject escape."""
    skills_real = str(SKILLS_ROOT.resolve())
    joined = (SKILLS_ROOT / rel_path).resolve()
    joined_s = str(joined)
    # startswith check against realpath + os.sep avoids /tmp vs /tmpfoo prefix
    # collision. SKILLS_ROOT itself counts as inside.
    if not (joined_s == skills_real or joined_s.startswith(skills_real + os.sep)):
        raise SchemaError(f"{ctx}: realpath escape: {rel_path!r} resolved to {joined_s!r} outside {skills_real!r}")
    return joined


def validate_yaml(spec):
    """Schema-check parsed YAML. Returns list of merge-entry dicts."""
    if not isinstance(spec, dict):
        raise SchemaError(f"top-level not a mapping (got {type(spec).__name__})")
    extra = set(spec.keys()) - {"merges"}
    if extra:
        raise SchemaError(f"top-level: unexpected keys: {sorted(extra)}")
    merges = spec.get("merges")
    if not isinstance(merges, list) or not merges:
        raise SchemaError("`merges` must be a non-empty list")
    for i, m in enumerate(merges):
        ctx = f"merges[{i}]"
        if not isinstance(m, dict):
            raise SchemaError(f"{ctx}: not a mapping")
        extra = set(m.keys()) - ALLOWED_MERGE_KEYS
        if extra:
            raise SchemaError(f"{ctx}: unexpected keys: {sorted(extra)}")
        target = _check_id(m.get("target"), f"{ctx}.target")
        if target not in TARGET_ALLOWLIST:
            raise SchemaError(f"{ctx}.target: {target!r} not in allow-list {sorted(TARGET_ALLOWLIST)}")
        sources = m.get("sources")
        if not isinstance(sources, list) or len(sources) < 1:
            raise SchemaError(f"{ctx}.sources: must be a non-empty list")
        for j, sid in enumerate(sources):
            sid_v = _check_id(sid, f"{ctx}.sources[{j}]")
            if sid_v not in SOURCE_ALLOWLIST:
                raise SchemaError(f"{ctx}.sources[{j}]: {sid_v!r} not in allow-list {sorted(SOURCE_ALLOWLIST)}")
        reason = m.get("reason")
        if not isinstance(reason, str) or not (10 <= len(reason) <= 1000):
            raise SchemaError(f"{ctx}.reason: must be str of length 10..1000 (got len={len(reason) if isinstance(reason, str) else type(reason).__name__})")
        b2 = m.get("b2")
        if b2 is not None:
            if not isinstance(b2, dict):
                raise SchemaError(f"{ctx}.b2: not a mapping")
            extra = set(b2.keys()) - ALLOWED_B2_KEYS
            if extra:
                raise SchemaError(f"{ctx}.b2: unexpected keys: {sorted(extra)}")
            canonical = _check_ref_path(b2.get("canonical"), f"{ctx}.b2.canonical")
            _resolve_bounded(canonical, f"{ctx}.b2.canonical")
            if not CANONICAL_SRC_REGEX.match(canonical):
                raise SchemaError(
                    f"{ctx}.b2.canonical: {canonical!r} is not a reference doc "
                    f"(must match {CANONICAL_SRC_REGEX.pattern})"
                )
            mirrors = b2.get("mirrors")
            if not isinstance(mirrors, list) or not mirrors:
                raise SchemaError(f"{ctx}.b2.mirrors: must be a non-empty list")
            seen = set()
            for k, mp in enumerate(mirrors):
                mp_v = _check_ref_path(mp, f"{ctx}.b2.mirrors[{k}]")
                _resolve_bounded(mp_v, f"{ctx}.b2.mirrors[{k}]")
                if not MIRROR_DEST_REGEX.match(mp_v):
                    raise SchemaError(
                        f"{ctx}.b2.mirrors[{k}]: {mp_v!r} is not a legal mirror "
                        f"destination (must match {MIRROR_DEST_REGEX.pattern})"
                    )
                if mp_v == canonical:
                    raise SchemaError(f"{ctx}.b2.mirrors[{k}]: mirror equals canonical {mp_v!r}")
                if mp_v in seen:
                    raise SchemaError(f"{ctx}.b2.mirrors[{k}]: duplicate mirror {mp_v!r}")
                seen.add(mp_v)
    return merges


# --- atomic mirror write ------------------------------------------------------


def _sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_copy(src, dst):
    """Atomic write of src bytes to dst. Mode 0644."""
    with open(src, "rb") as sf:
        content = sf.read()
    tmp = str(dst) + ".tmp." + str(os.getpid())
    try:
        # O_EXCL via 'x' mode prevents collision if a stale tmp exists from a
        # crashed prior run (operator must inspect/clean before retry).
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        try:
            with os.fdopen(fd, "wb") as tf:
                tf.write(content)
                tf.flush()
                os.fsync(tf.fileno())
        except Exception:
            os.close(fd) if False else None  # fdopen took ownership
            raise
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def materialise_b2(merges, dry_run=False):
    """For each B2 merge, copy canonical → mirrors. Returns summary list."""
    summary = []
    for m in merges:
        b2 = m.get("b2")
        if b2 is None:
            continue
        canon_rel = b2["canonical"]
        canon_abs = SKILLS_ROOT / canon_rel
        if not canon_abs.is_file():
            raise SchemaError(f"canonical missing on disk: {canon_rel}")
        canon_sha = _sha256(canon_abs)
        for mp_rel in b2["mirrors"]:
            # Re-assert at the write site, not only in validate_yaml. This is the
            # one function in the catalog that clobbers a file, so its destination
            # policy must hold for any caller, including one that skipped
            # validation.
            if not MIRROR_DEST_REGEX.match(mp_rel):
                raise SchemaError(f"refusing to write outside references/: {mp_rel}")
            mp_abs = SKILLS_ROOT / mp_rel
            mp_abs.parent.mkdir(parents=True, exist_ok=True)
            if mp_abs.is_file() and _sha256(mp_abs) == canon_sha:
                summary.append((mp_rel, "unchanged"))
                continue
            if dry_run:
                summary.append((mp_rel, "would-write"))
                continue
            _atomic_copy(canon_abs, mp_abs)
            summary.append((mp_rel, "wrote"))
    return summary


def verify_byte_identity(merges):
    """Read-only verifier: confirm every mirror sha256 == canonical sha256."""
    err = 0
    for m in merges:
        b2 = m.get("b2")
        if b2 is None:
            continue
        canon_abs = SKILLS_ROOT / b2["canonical"]
        if not canon_abs.is_file():
            print(f"  ✗ canonical missing: {b2['canonical']}")
            err = 1
            continue
        canon_sha = _sha256(canon_abs)
        for mp_rel in b2["mirrors"]:
            mp_abs = SKILLS_ROOT / mp_rel
            if not mp_abs.is_file():
                print(f"  ✗ mirror missing: {mp_rel}")
                err = 1
                continue
            mp_sha = _sha256(mp_abs)
            if mp_sha != canon_sha:
                print(f"  ✗ byte-identity drift: {mp_rel}")
                print(f"      canonical sha256: {canon_sha}")
                print(f"      mirror    sha256: {mp_sha}")
                err = 1
    return err


def verify_lock_mirror_identity():
    """Byte-compare every mirror relationship the LOCK declares, not just the
    subset `_phase2-merges.yml` happens to carry a `b2:` block for.

    `_phase2-merges.yml` is a build recipe: it lists the merges whose mirrors
    this script materialises, which is one entry / four files. The set of files
    that ARE mirrors is twenty-two groups / fifty-six files. Verifying the
    recipe instead of the relationship meant fifty-two mirrored prompts could
    diverge from their canonical without C11 printing anything.

    Reading the group list from the lock is not scope laundering: C12's
    coverage floor fails on any surface file the lock does not attest, so
    deleting a group here to shrink this check's scope cannot pass C12.

    What this check contributes over C12 is a pin-free comparison. C12 answers
    "do these bytes match the value someone recorded"; this answers "does the
    mirror still equal its canonical", which stays true regardless of what the
    lock says. For a mirror group the two overlap heavily by construction — one
    pinned hash covers canonical and mirrors alike, so drift here generally
    shows up there too. The value is that this one survives a wholesale lock
    regeneration, and that it names the relationship rather than the hash.
    """
    lock = HERE / "_ref-mirrors.lock"
    if not lock.is_file():
        print(f"  ✗ {lock.name} missing — mirror relationships are unverifiable")
        return 1, 0, 0
    try:
        spec = yaml.safe_load(lock.read_text())
    except yaml.YAMLError as e:
        print(f"  ✗ {lock.name}: YAML parse error: {e}")
        return 1, 0, 0
    groups = (spec or {}).get("mirrors")
    if not isinstance(groups, list) or not groups:
        print(f"  ✗ {lock.name}: `mirrors` is empty — zero comparisons is not a pass")
        return 1, 0, 0

    err = 0
    compared = 0
    for e in groups:
        target = e.get("target", "<unnamed>")
        canon_rel = e.get("canonical", {}).get("path")
        try:
            canon_abs = _resolve_bounded(_check_ref_path(canon_rel, f"{target}.canonical"),
                                         f"{target}.canonical")
        except SchemaError as exc:
            print(f"  ✗ {exc}")
            err = 1
            continue
        if not canon_abs.is_file():
            print(f"  ✗ {target}: canonical missing: {canon_rel}")
            err = 1
            continue
        canon_sha = _sha256(canon_abs)
        mirrors = e.get("mirrors") or []
        if not mirrors:
            print(f"  ✗ {target}: mirror group declares no mirrors")
            err = 1
            continue
        for mp_rel in mirrors:
            try:
                mp_abs = _resolve_bounded(_check_ref_path(mp_rel, f"{target}.mirror"),
                                          f"{target}.mirror")
            except SchemaError as exc:
                print(f"  ✗ {exc}")
                err = 1
                continue
            if not mp_abs.is_file():
                print(f"  ✗ {target}: mirror missing: {mp_rel}")
                err = 1
                continue
            compared += 1
            mp_sha = _sha256(mp_abs)
            if mp_sha != canon_sha:
                print(f"  ✗ {target}: byte-identity drift: {mp_rel}")
                print(f"      canonical sha256: {canon_sha}")
                print(f"      mirror    sha256: {mp_sha}")
                err = 1
    if compared == 0:
        print(f"  ✗ {lock.name}: 0 mirror files compared — the check looked at nothing")
        err = 1
    return err, compared, len(groups)


# --- 4-call-site ID regex sweep (per feedback_call_site_presence_not_just_symbol_export) -


def _check_call_sites():
    """Verify ID_REGEX is applied at four production call-sites.

    Call-sites enforced (numbered per HANDOFF):
      1. `_phase2-merges.yml` targets + sources → enforced in validate_yaml() above.
      2. `_phase2-coverage-tokens.yml` targets.<id> keys → enforced here.
      3. Catalog dir names (each `_council-experts/<id>/`) → enforced here.
         (Also enforced by verify-catalog.sh C3 — redundancy is intentional.)
      4. Implement-skill reference-table `Seat` IDs (the `| <id> | … |` rows
         under `| Seat | Task Domain | Reference Document |`) → enforced here.
         RC-2 deleted the fixed `### Council panel` blocks — the roster is now
         selected adaptively from capability profiles — so the surviving
         production call-site where an expert ID enters SKILL.md and is used to
         locate a reference doc is the implement table's Seat column.
    """
    err = 0

    # Site 2: _phase2-coverage-tokens.yml
    cov_yaml = HERE / "_phase2-coverage-tokens.yml"
    if cov_yaml.is_file():
        try:
            cspec = yaml.safe_load(cov_yaml.read_text())
            for tid in (cspec.get("targets") or {}).keys():
                _check_id(tid, f"{cov_yaml.name}: targets.{tid}")
        except (yaml.YAMLError, SchemaError) as e:
            print(f"  ✗ call-site 2 ({cov_yaml.name}): {e}")
            err = 1

    # Site 3: catalog dir names
    for d in CATALOG_ROOT.iterdir():
        if not d.is_dir() or d.name.startswith("."):
            continue
        try:
            _check_id(d.name, f"catalog dir name {d.name}")
        except SchemaError as e:
            print(f"  ✗ call-site 3 (catalog dir): {e}")
            err = 1

    # Site 4: `Seat` IDs in the implement skills' reference tables.
    # The first-cell pattern captures WHATEVER is bulleted in the Seat column, not
    # only well-formed IDs: a selector that only matches valid IDs cannot report a
    # malformed one, it can only fail to see it. Every Seat row is an ID the
    # Builder will use to locate a reference doc, so every one must be adjudicated.
    table_header = "| Seat | Task Domain | Reference Document |"
    n_seat_ids = 0
    n_tables = 0
    for slug in ("council-implement", "council-implement-aura"):
        skill = SKILLS_ROOT / slug / "SKILL.md"
        if not skill.is_file():
            continue
        lines = skill.read_text().splitlines()
        try:
            start = next(i for i, ln in enumerate(lines) if ln.strip() == table_header)
        except StopIteration:
            continue
        n_tables += 1
        for ln in lines[start + 1 :]:
            if not ln.lstrip().startswith("|"):
                break
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            if len(cells) == 3 and set("".join(cells)) <= set("-: "):
                continue  # separator
            seat = cells[0].strip("`") if cells else ""
            if not seat:
                continue
            n_seat_ids += 1
            try:
                _check_id(seat, f"{slug}/SKILL.md: table Seat {seat}")
            except SchemaError as e:
                print(f"  ✗ call-site 4 (table Seat): {e}")
                err = 1

    # Zero-comparison guard. Without it a renamed header, a moved skills root or a
    # reformatted table silently turns this sweep into a no-op that still prints
    # the same green line as a real pass.
    if n_tables == 0:
        print(
            f"  ✗ call-site 4: no '{table_header}' reference table found under {SKILLS_ROOT} "
            f"— nothing was checked"
        )
        err = 1
    elif n_seat_ids == 0:
        print("  ✗ call-site 4: reference tables found but 0 Seat IDs extracted — extraction is broken")
        err = 1

    return err


# --- readability + mode -------------------------------------------------------


def _mode_bits(p):
    return stat.S_IMODE(os.stat(p).st_mode)


def _check_access_and_mode():
    """The catalog must be readable by the process that runs the council, and
    its data files must not be executable or group/world-writable.

    This previously asserted uid-equality against SKILLS_ROOT's owner and a
    0755 *floor* on the catalog directory. Both were wrong. The uid check
    cannot fail on this layout: the skills root is mode 700, so everything
    under it is already unreachable by any other user, and comparing owners
    inside a tree with exactly one possible reader asserts nothing. The 0755
    floor was worse than vacuous — it FAILED when an operator tightened the
    catalog to 0750, so the gate rejected a strictly safer permission and
    trained the operator to disable it. What actually matters is the property
    the council depends on at dispatch time: can this process read the file.
    """
    err = 0

    if not os.access(CATALOG_ROOT, os.R_OK | os.X_OK):
        print(f"  ✗ access: catalog dir {CATALOG_ROOT} is not readable+traversable by this process")
        err = 1

    if MERGES_YAML.is_file():
        if not os.access(MERGES_YAML, os.R_OK):
            print(f"  ✗ access: {MERGES_YAML.name} is not readable by this process")
            err = 1
        mmode = _mode_bits(MERGES_YAML)
        if mmode & 0o022:
            print(f"  ✗ mode: {MERGES_YAML.name} mode {oct(mmode)} is group/world-writable")
            err = 1

    n = 0
    for ref in SKILLS_ROOT.rglob("references/quality-*.md"):
        if "/.git/" in str(ref):
            continue
        n += 1
        if not os.access(ref, os.R_OK):
            print(f"  ✗ access: {ref.relative_to(SKILLS_ROOT)} is not readable by this process")
            err = 1
        m = _mode_bits(ref)
        if m & 0o111:
            print(f"  ✗ mode: {ref.relative_to(SKILLS_ROOT)} has executable bit ({oct(m)})")
            err = 1

    # A glob that stopped matching is silent in exactly the same way as a tree
    # that is genuinely clean. Zero comparisons is not a pass.
    if n == 0:
        print(f"  ✗ access/mode: matched 0 reference documents under {SKILLS_ROOT} — the check looked at nothing")
        err = 1

    return err


# --- adversarial self-test (regex authority) ----------------------------------


_BAD_IDS = [
    "",                  # empty
    "A",                 # uppercase
    "1dahl",             # leading digit
    "-dahl",             # leading hyphen
    "dahl/../etc",       # path traversal
    "dahl;ls",           # shell injection
    "dahl ls",           # whitespace
    "dahl\x00ls",        # NUL
    "dahl\nls",          # newline
    "dahl.md",           # dot
    "dahl_x",            # underscore
    "a" * 33,            # too long (limit is 32 chars total)
    "café",              # non-ASCII
    "dahĺ",        # combining mark
    "dahl..",            # trailing dots
    "../dahl",           # leading ..
]

_GOOD_IDS = [
    "dahl", "ritchie", "hashimoto",
    "backend-ts", "realtime-ndjson", "deploy-docker-gha", "deploy-vps",
    "a1", "a-b-c",
    "a" + "b" * 31,      # exactly 32 chars total — boundary
]


def selftest():
    err = 0
    for s in _BAD_IDS:
        if ID_REGEX.match(s):
            print(f"  ✗ ID_REGEX accepted bad ID: {s!r}")
            err = 1
    for s in _GOOD_IDS:
        if not ID_REGEX.match(s):
            print(f"  ✗ ID_REGEX rejected good ID: {s!r}")
            err = 1

    bad_paths = [
        "/etc/passwd", "../etc", "~/foo", "$HOME/x",
        "foo/../bar", "foo//bar", "foo\\bar", "foo\x00bar",
        "Foo/bar", ".hidden", "foo/.hidden",
    ]
    for p in bad_paths:
        try:
            _check_ref_path(p, "selftest")
        except SchemaError:
            continue
        print(f"  ✗ ref-path accepted bad path: {p!r}")
        err = 1

    good_paths = [
        "_council-experts/hashimoto/references/quality-hashimoto.md",
        "council-plan/references/quality-hashimoto.md",
        "a/b",
        "a-b/c_d.txt",
    ]
    for p in good_paths:
        try:
            _check_ref_path(p, "selftest")
        except SchemaError as e:
            print(f"  ✗ ref-path rejected good path: {p!r} ({e})")
            err = 1

    # Destination policy: paths that are legal ref-paths but illegal WRITE
    # targets. Each of these passes `_check_ref_path` and `_resolve_bounded` —
    # they are the reason bounds-checking alone was not enough.
    bad_dests = [
        "council-review-aura/SKILL.md",
        "_council-experts/hunt/review-aura.md",
        "_council-experts/hunt/references/quality-hunt.md",
        "_council-experts/.verify/_ref-mirrors.lock",
        "council-review-aura/references/quality-dahl.txt",
        "council-review-aura/references/subdir/quality-dahl.md",
        "some-other-skill/references/quality-dahl.md",
    ]
    for p in bad_dests:
        if MIRROR_DEST_REGEX.match(p):
            print(f"  ✗ mirror-dest policy accepted illegal write target: {p!r}")
            err = 1
    good_dests = [
        "council-plan/references/quality-fowler.md",
        "council-review-aura/references/quality-dahl.md",
        "council-implement-aura/references/security.md",
    ]
    for p in good_dests:
        if not MIRROR_DEST_REGEX.match(p):
            print(f"  ✗ mirror-dest policy rejected legal write target: {p!r}")
            err = 1

    if err == 0:
        print(f"  ✓ selftest: {len(_BAD_IDS)} bad IDs rejected, {len(_GOOD_IDS)} good IDs accepted, "
              f"{len(bad_paths)} bad paths rejected, {len(good_paths)} good paths accepted, "
              f"{len(bad_dests)} illegal write targets rejected, "
              f"{len(good_dests)} legal ones accepted")
    return err


# --- entrypoint ---------------------------------------------------------------


def _load_and_validate():
    try:
        spec = yaml.safe_load(MERGES_YAML.read_text())
    except yaml.YAMLError as e:
        print(f"  ✗ {MERGES_YAML.name}: YAML parse error: {e}")
        sys.exit(1)
    try:
        return validate_yaml(spec)
    except SchemaError as e:
        print(f"  ✗ {MERGES_YAML.name}: {e}")
        sys.exit(1)


def main(argv):
    if "--selftest" in argv:
        sys.exit(selftest())

    merges = _load_and_validate()

    if "--check" in argv:
        err = 0
        err |= _check_call_sites()
        err |= _check_access_and_mode()
        # An unreadable file used to escape as a raw PermissionError traceback
        # from the hasher. The exit code happened to be 1, so the gate was not
        # false-green, but a stack trace does not name the check that failed and
        # reads as a broken tool rather than a caught violation.
        try:
            err |= verify_byte_identity(merges)
            lock_err, n_compared, n_groups = verify_lock_mirror_identity()
            err |= lock_err
        except OSError as exc:
            print(f"  ✗ could not read {exc.filename}: {exc.strerror} — byte-identity is unverifiable")
            sys.exit(1)
        if err == 0:
            print(f"  ✓ schema + 4-call-site IDs + access/mode + "
                  f"{n_groups} mirror groups / {n_compared} mirrors byte-identical "
                  f"to their canonical — all green")
        sys.exit(err)

    # Default: materialise B2 mirrors.
    summary = materialise_b2(merges, dry_run=False)
    for rel, status in summary:
        print(f"  [{status:9}] {rel}")
    n_wrote = sum(1 for _, s in summary if s == "wrote")
    n_unchanged = sum(1 for _, s in summary if s == "unchanged")
    print(f"  ✓ materialised: {n_wrote} wrote, {n_unchanged} unchanged")


if __name__ == "__main__":
    main(sys.argv[1:])
