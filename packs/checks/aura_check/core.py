"""Core of aura-check: rule registry, scan context, diff parsing, runner.

Stdlib only (Python >= 3.8) so the tool runs on any project box without
installing anything. Rules live in ``aura_check.rules.*`` and register
themselves with the ``@rule`` decorator.
"""
from __future__ import annotations

import fnmatch
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterable, Iterator, List, Optional, Set, Tuple

ERROR = "error"
WARN = "warn"

MAX_FILE_BYTES = 1_000_000

# Directories never worth scanning in walk mode (non-git trees).
SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "env", "__pycache__", "dist", "build",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".next", "coverage",
}
# Generated / binary-ish files whose content is never a lesson target.
SKIP_FILE_GLOBS = (
    "*.lock", "*.lockb", "package-lock.json", "*.min.js", "*.map", "*.png", "*.jpg",
    "*.jpeg", "*.gif", "*.webp", "*.ico", "*.pdf", "*.woff", "*.woff2", "*.ttf",
    "*.zip", "*.gz", "*.mp4", "*.mp3", "*.sqlite", "*.db",
)

SUPPRESS_RE = re.compile(r"aura-check:\s*ignore(?:\[([\w.,\- ]+)\])?")


@dataclass
class Finding:
    rule_id: str
    severity: str
    path: str  # repo-relative, or a label such as "commit-message:<sha>"
    line: int  # 1-based; 0 = whole file / not applicable
    message: str

    def location(self) -> str:
        return f"{self.path}:{self.line}" if self.line else self.path


@dataclass
class Rule:
    id: str
    pack: str
    severity: str
    title: str
    evidence: str
    hint: str
    fn: Callable[["Context"], Iterable[Tuple[str, int, str]]]
    # When True and running in --changed mode, findings are only kept if they
    # point at a line the diff added (pre-existing debt in touched files is not
    # re-reported on every commit).
    diff_scoped: bool = False
    runtime_only: bool = False
    # Published guideline the rule enforces, as "catalog-id: criterion" pairs
    # separated by ";" (ids from docs/research/uiux-sources/catalog.json).
    source: str = ""


RULES: List[Rule] = []


def rule(*, id: str, pack: str, severity: str, title: str, evidence: str, hint: str,
         diff_scoped: bool = False, runtime_only: bool = False, source: str = ""):
    def deco(fn):
        RULES.append(Rule(id=id, pack=pack, severity=severity, title=title,
                          evidence=evidence, hint=hint, fn=fn,
                          diff_scoped=diff_scoped, runtime_only=runtime_only, source=source))
        return fn
    return deco


@dataclass
class FileDiff:
    path: str
    is_new: bool = False
    added: List[Tuple[int, str]] = field(default_factory=list)  # (new lineno, text)
    removed: List[str] = field(default_factory=list)

    @property
    def added_lines(self) -> Set[int]:
        return {n for n, _ in self.added}


def parse_unified_diff(text: str) -> Dict[str, FileDiff]:
    """Parse ``git diff -U0`` output into per-file added/removed lines."""
    files: Dict[str, FileDiff] = {}
    cur: Optional[FileDiff] = None
    in_hunk = False
    pending_new = False
    new_line = 0
    hunk_re = re.compile(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")
    for raw in text.splitlines():
        if raw.startswith("diff --git "):
            cur, in_hunk, pending_new = None, False, False
            continue
        if raw.startswith("@@"):
            m = hunk_re.match(raw)
            if m and cur is not None:
                new_line = int(m.group(1))
                in_hunk = True
            continue
        if not in_hunk:
            if raw.startswith("new file mode"):
                pending_new = True
            elif raw.startswith("+++ "):
                target = raw[4:]
                if target == "/dev/null":
                    cur = None  # deleted file: nothing to scan
                else:
                    target = target[2:] if target.startswith("b/") else target
                    cur = files.setdefault(target, FileDiff(path=target))
                    cur.is_new = cur.is_new or pending_new
            continue
        if cur is None:
            continue
        if raw.startswith("+"):
            cur.added.append((new_line, raw[1:]))
            new_line += 1
        elif raw.startswith("-"):
            cur.removed.append(raw[1:])
        elif raw.startswith(" "):
            new_line += 1
    return files


def git(root: Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def is_git_repo(root: Path) -> bool:
    proc = subprocess.run(["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
                          capture_output=True, text=True)
    return proc.returncode == 0 and proc.stdout.strip() == "true"


def walk_files(root: Path) -> List[str]:
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            out.append(os.path.relpath(os.path.join(dirpath, name), root))
    return sorted(out)


class Context:
    """Everything a rule may look at. Rules must not shell out on their own
    except through helpers here (keeps them testable on temp dirs)."""

    def __init__(self, root: Path, *, changed: bool = False, base: Optional[str] = None,
                 commit_messages: Optional[List[Tuple[str, str]]] = None,
                 scan_files: bool = True, runtime: bool = False,
                 unit_dirs: Optional[List[Path]] = None,
                 main_branches: Tuple[str, ...] = ("main", "master")):
        self.root = root.resolve()
        self.changed = changed
        self.base = base
        self.runtime = runtime
        self.unit_dirs = unit_dirs if unit_dirs is not None else default_unit_dirs()
        self.main_branches = main_branches
        self.git = is_git_repo(self.root)
        self.commit_messages: List[Tuple[str, str]] = list(commit_messages or [])
        self._cache: Dict[str, Optional[str]] = {}
        self.ignore = load_ignore(self.root)

        self.tracked: Set[str] = set()
        if self.git:
            self.tracked = set(git(self.root, "ls-files", "-z").split("\0")) - {""}
            self.all_files = sorted(f for f in self.tracked if (self.root / f).is_file())
        else:
            self.all_files = walk_files(self.root)

        self.diff: Dict[str, FileDiff] = {}
        if changed:
            if not self.git:
                raise RuntimeError("--changed needs a git repository")
            if base:
                diff_text = git(self.root, "diff", "-U0", "--no-color", "--no-ext-diff",
                                f"{base}...HEAD")
                log = git(self.root, "log", "--format=%H%x00%B%x1e", f"{base}..HEAD")
                for chunk in log.split("\x1e"):
                    chunk = chunk.strip("\n")
                    if "\0" in chunk:
                        sha, body = chunk.split("\0", 1)
                        self.commit_messages.append((f"commit-message:{sha[:10]}", body))
            else:
                diff_text = git(self.root, "diff", "--cached", "-U0", "--no-color", "--no-ext-diff")
            self.diff = parse_unified_diff(diff_text)
            # Staged-but-new files may not be in the HEAD tree yet; ls-files
            # already includes the index, so tracked covers them.

        if not scan_files:
            self.files: List[str] = []
        elif changed:
            self.files = sorted(p for p in self.diff if (self.root / p).is_file())
        else:
            self.files = list(self.all_files)
        self.files = [f for f in self.files if not self.path_ignored(f)]

    # -- file access -------------------------------------------------------
    def read(self, rel: str) -> Optional[str]:
        if rel in self._cache:
            return self._cache[rel]
        text: Optional[str] = None
        p = self.root / rel
        name = os.path.basename(rel)
        if not any(fnmatch.fnmatch(name, g) for g in SKIP_FILE_GLOBS):
            try:
                if p.is_file() and p.stat().st_size <= MAX_FILE_BYTES:
                    data = p.read_bytes()
                    if b"\0" not in data[:8192]:
                        text = data.decode("utf-8", errors="replace")
            except OSError:
                text = None
        self._cache[rel] = text
        return text

    def lines(self, rel: str) -> List[str]:
        text = self.read(rel)
        return text.splitlines() if text is not None else []

    def scan_lines(self, rel: str) -> Iterator[Tuple[int, str]]:
        """Lines to scan for content rules: added lines in --changed mode,
        the whole file otherwise."""
        if self.changed:
            fd = self.diff.get(rel)
            if fd:
                yield from fd.added
            return
        for i, line in enumerate(self.lines(rel), 1):
            yield i, line

    def files_with_ext(self, *exts: str, universe: Optional[Iterable[str]] = None) -> List[str]:
        src = self.files if universe is None else universe
        return [f for f in src if f.endswith(exts)]

    def path_ignored(self, rel: str, rule_id: Optional[str] = None) -> bool:
        for rid, pattern in self.ignore:
            if rid is not None and rid != rule_id:
                continue
            if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(os.path.basename(rel), pattern):
                return True
        return False


def default_unit_dirs() -> List[Path]:
    return [Path("/etc/systemd/system"), Path.home() / ".config/systemd/user"]


def load_ignore(root: Path) -> List[Tuple[Optional[str], str]]:
    """``.aura-check-ignore``: one entry per line, ``<glob>`` (all rules) or
    ``<rule-id> <glob>``. ``#`` starts a comment."""
    p = root / ".aura-check-ignore"
    out: List[Tuple[Optional[str], str]] = []
    if not p.is_file():
        return out
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) == 1:
            out.append((None, parts[0]))
        else:
            out.append((parts[0], parts[1]))
    return out


def line_suppressed(ctx: Context, f: Finding) -> bool:
    if not f.line or f.path.startswith("commit-message"):
        return False
    lines = ctx.lines(f.path) if not os.path.isabs(f.path) else _abs_lines(f.path)
    if f.line > len(lines):
        return False
    m = SUPPRESS_RE.search(lines[f.line - 1])
    if not m:
        return False
    ids = m.group(1)
    return ids is None or f.rule_id in {s.strip() for s in ids.split(",")}


def _abs_lines(path: str) -> List[str]:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def select_rules(packs: Optional[List[str]], runtime: bool) -> List[Rule]:
    from . import rules  # noqa: F401  (registers rules)
    chosen = [r for r in RULES if packs is None or r.pack in packs]
    return [r for r in chosen if runtime or not r.runtime_only]


def run(ctx: Context, packs: Optional[List[str]] = None) -> List[Finding]:
    findings: List[Finding] = []
    for r in select_rules(packs, ctx.runtime):
        for path, line, message in r.fn(ctx):
            f = Finding(r.id, r.severity, path, line, message)
            if not path.startswith("commit-message") and ctx.path_ignored(path, r.id):
                continue
            if r.diff_scoped and ctx.changed and not path.startswith("commit-message"):
                fd = ctx.diff.get(path)
                if fd is None or line not in fd.added_lines:
                    continue
            if line_suppressed(ctx, f):
                continue
            findings.append(f)
    findings.sort(key=lambda f: (f.severity != ERROR, f.path, f.line, f.rule_id))
    return findings


def rule_by_id(rule_id: str) -> Rule:
    from . import rules  # noqa: F401
    for r in RULES:
        if r.id == rule_id:
            return r
    raise KeyError(rule_id)


def mask(secret: str) -> str:
    """Never print a secret: keep a 4-char prefix for recognisability."""
    return secret[:4] + "…" + f"({len(secret)} chars)"
