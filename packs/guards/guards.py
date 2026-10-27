#!/usr/bin/env python3
"""Aura guards pack: Claude Code hooks that stop the costliest agent failures.

Modes (first CLI argument):
  pre    PreToolUse(Bash) hook  - deny/ask/warn before a risky command runs.
  post   PostToolUse(Bash) hook - after a deploy-like command, remind to verify the LIVE system.
  stop   Stop hook              - "done needs proof": block once if the turn deployed something
                                  and claims done without a verification command afterwards.
  check  Manual/CI helper       - `guards.py check '<shell command>'` prints the decision as JSON
                                  (usable from any agent, e.g. Codex, or by a human).

Hook protocol (Claude Code hooks spec): the hook reads one JSON object on stdin and
prints one JSON object on stdout, exit code 0. Decisions go in
`hookSpecificOutput.permissionDecision` ("deny" / "ask") with a
`permissionDecisionReason`; soft warnings use `hookSpecificOutput.additionalContext`
without a permission decision, so the normal permission flow is untouched.
The Stop hook answers `{"decision": "block", "reason": ...}`.

Fail-open by design: any internal error produces no output and exit 0, so a guard
bug can never wedge the agent. Pure stdlib; Python >= 3.8.

Disable rules with GUARDS_DISABLE="rule-id,rule-id" in the HOOK's environment (e.g. the `env`
block of settings.json) or a project file `.claude/guards.json` containing
{"disable": ["rule-id", ...]}. `GUARDS_DISABLE=all` turns the pack off. An inline
`GUARDS_DISABLE=x cmd` prefix on the agent's command does NOT work: the hook inspects the command
string before it runs and only reads its own environment. Rule ids are listed in RULES below and
in README.md.

One-shot approval ("Allow once", Aura): an "ask"-level decision is suppressed exactly once when
`~/.companion/guards-allow/` holds an unexpired, HMAC-signed entry for the same rule(s) and the
same exact command string (sha256), written by the Aura server after the user pressed
"Allow once". The entry is consumed (renamed away, then deleted) before the command is allowed.
"deny"-level findings can never be allowed once. See `consume_allow_once` below.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import posixpath
import re
import shlex
import socket
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

RULES = {
    "pkill": "deny pkill/killall (match by name/cmdline)",
    "force-push": "ask before git push --force / -f / +refspec",
    "git-reset-hard": "ask before git reset --hard / git clean -f",
    "rm-rf": "ask before rm -rf outside /tmp and build dirs",
    "sql-destructive": "ask before DROP/TRUNCATE/DELETE|UPDATE without WHERE via a DB client",
    "alembic-downgrade": "ask before alembic downgrade",
    "test-db": "ask before tests/migrations when the DB name has no test marker",
    "service-restart": "ask before systemctl/service restart|stop, show hostname",
    "secret-rotation": "ask before secret/token rotation, show hostname",
    "alembic-ssh-env": "warn on alembic upgrade over ssh without loading the service env",
    "deploy-verify": "PostToolUse reminder to verify the live system after deploy",
    "done-needs-proof": "Stop hook: block a 'done' claim after deploy without verification",
}

LEVEL_ORDER = {"warn": 1, "ask": 2, "deny": 3}


@dataclass
class Finding:
    rule: str
    level: str  # "deny" | "ask" | "warn"
    reason: str


# --------------------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------------------


def disabled_rules(cwd: Optional[str]) -> set:
    out = set()
    raw = os.environ.get("GUARDS_DISABLE", "")
    out.update(x.strip() for x in raw.split(",") if x.strip())
    if cwd:
        path = os.path.join(cwd, ".claude", "guards.json")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            out.update(str(x) for x in data.get("disable", []) if x)
        except (OSError, ValueError, AttributeError):
            pass
    return out


def hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return "unknown-host"


# --------------------------------------------------------------------------------------
# Shell parsing (best effort; never executes anything)
# --------------------------------------------------------------------------------------

_PUNCT = set("();<>|&\n")
_HEREDOC_RE = re.compile(r"<<(-?)\s*(['\"]?)([A-Za-z_][\w.-]*)\2")


@dataclass
class Segment:
    words: List[str]
    redirects: List[Tuple[str, str]] = field(default_factory=list)
    pipe_from_prev: bool = False  # True when this segment receives the previous one's stdout


def strip_heredocs(cmd: str) -> Tuple[str, Dict[str, str]]:
    """Replace heredoc bodies with placeholder delimiters; return (command, {placeholder: body})."""
    lines = cmd.split("\n")
    out_lines: List[str] = []
    bodies: Dict[str, str] = {}
    i = 0
    counter = 0
    while i < len(lines):
        line = lines[i]
        pending: List[Tuple[str, str, bool]] = []  # (placeholder, delimiter, strip_tabs)

        def _sub(m: "re.Match[str]") -> str:
            nonlocal counter
            counter += 1
            ph = f"__GUARDS_HEREDOC_{counter}__"
            pending.append((ph, m.group(3), m.group(1) == "-"))
            return f"<< {ph}"

        # Do not treat `<<<` here-strings as heredocs.
        new_line = re.sub(r"(?<!<)" + _HEREDOC_RE.pattern + r"", _sub, line) if "<<" in line else line
        out_lines.append(new_line)
        i += 1
        for ph, delim, strip_tabs in pending:
            body: List[str] = []
            while i < len(lines):
                cand = lines[i].lstrip("\t") if strip_tabs else lines[i]
                i += 1
                if cand.strip() == delim:
                    break
                body.append(lines[i - 1])
            bodies[ph] = "\n".join(body)
    return "\n".join(out_lines), bodies


def _tokens(cmd: str) -> List[str]:
    try:
        lex = shlex.shlex(cmd, posix=True, punctuation_chars="();<>|&\n")
        lex.whitespace = " \t\r"
        lex.whitespace_split = True
        lex.commenters = "#"
        return list(lex)
    except ValueError:
        # Unbalanced quotes etc.: crude fallback that still separates operators.
        return re.findall(r"\|\||&&|[;|&()\n]|[<>]+&?|[^\s;|&()<>]+", cmd)


def _is_punct(tok: str) -> bool:
    return bool(tok) and all(c in _PUNCT for c in tok)


def split_segments(cmd: str) -> List[Segment]:
    segs: List[Segment] = []
    cur = Segment(words=[])
    toks = _tokens(cmd)
    i = 0
    while i < len(toks):
        tok = toks[i]
        if _is_punct(tok) and ("<" in tok or ">" in tok) and not any(c in tok for c in ";|()\n"):
            # Redirection: next token is the target (file, heredoc placeholder, here-string).
            target = toks[i + 1] if i + 1 < len(toks) and not _is_punct(toks[i + 1]) else ""
            # `2>&1` style: a numeric fd word just before is not an argument.
            if cur.words and cur.words[-1].isdigit() and tok.startswith(">"):
                cur.words.pop()
            cur.redirects.append((tok, target))
            i += 2 if target else 1
            continue
        if _is_punct(tok):
            if cur.words or cur.redirects:
                segs.append(cur)
            cur = Segment(words=[], pipe_from_prev=tok in ("|", "|&"))
            i += 1
            continue
        cur.words.append(tok)
        i += 1
    if cur.words or cur.redirects:
        segs.append(cur)
    return segs


def pipelines(segs: List[Segment]) -> List[List[Segment]]:
    out: List[List[Segment]] = []
    for s in segs:
        if s.pipe_from_prev and out:
            out[-1].append(s)
        else:
            out.append([s])
    return out


_ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)

# wrapper -> (options that take an argument, number of positional args before the command)
_WRAPPERS: Dict[str, Tuple[set, int]] = {
    "sudo": ({"-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"}, 0),
    "doas": ({"-u", "-C"}, 0),
    "env": ({"-u", "-C", "-S", "--unset", "--chdir"}, 0),
    "nohup": (set(), 0),
    "time": ({"-f", "-o"}, 0),
    "nice": ({"-n"}, 0),
    "ionice": ({"-c", "-n", "-p"}, 0),
    "timeout": ({"-s", "-k", "--signal", "--kill-after"}, 1),
    "setsid": (set(), 0),
    "exec": ({"-a"}, 0),
    "command": (set(), 0),
    "builtin": (set(), 0),
    "stdbuf": ({"-i", "-o", "-e"}, 0),
    "chronic": (set(), 0),
    "unbuffer": (set(), 0),
    "systemd-run": ({"-p", "-u", "-E", "-H", "-M", "--unit", "--property", "--setenv", "--description",
                     "--slice", "--uid", "--gid", "--working-directory", "--on-calendar"}, 0),
    "xargs": ({"-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"}, 0),
    "watch": ({"-n", "-d"}, 0),
    "flock": ({"-w", "-E"}, 1),
    "su": ({"-c"}, 0),
}


def basename(word: str) -> str:
    return word.rsplit("/", 1)[-1]


def unwrap(words: List[str], env: Dict[str, str]) -> List[str]:
    """Strip leading VAR=val assignments (recorded into env) and wrapper commands."""
    w = list(words)
    for _ in range(12):
        while w and _ASSIGN_RE.match(w[0]):
            k, v = _ASSIGN_RE.match(w[0]).groups()  # type: ignore[union-attr]
            env[k] = v
            w = w[1:]
        if not w:
            return w
        name = basename(w[0])
        if name not in _WRAPPERS:
            return w
        opts_with_arg, positional = _WRAPPERS[name]
        j = 1
        while j < len(w):
            t = w[j]
            if t == "--":
                j += 1
                break
            if name == "env" and _ASSIGN_RE.match(t):
                k, v = _ASSIGN_RE.match(t).groups()  # type: ignore[union-attr]
                env[k] = v
                j += 1
                continue
            if t.startswith("-") and len(t) > 1:
                j += 2 if (t in opts_with_arg and "=" not in t) else 1
                continue
            break
        j += positional
        w = w[j:]
    return w


# --------------------------------------------------------------------------------------
# Rule helpers
# --------------------------------------------------------------------------------------

_SSH_OPTS_WITH_ARG = set("bcDEeFIiJLlmOoopQRSWw") | {"p", "B"}
_SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
_DB_CLIENTS = {"psql", "sqlite3", "sqlite", "mysql", "mariadb", "clickhouse-client", "duckdb", "cockroach", "pgcli",
               "litecli", "mycli"}
_BUILD_DIRS = {"node_modules", "dist", "build", ".next", ".nuxt", ".output", "out", "coverage", "target",
               "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", ".cache",
               ".parcel-cache", ".svelte-kit", ".vite", ".tox", ".nox", "htmlcov", ".gradle", "storybook-static"}
_TMP_PREFIXES = ("/tmp/", "/var/tmp/", "/private/tmp/")


def parse_ssh(words: List[str]) -> Tuple[Optional[str], List[str]]:
    """Return (host, remote_words) for an `ssh ...` invocation."""
    j = 1
    while j < len(words):
        t = words[j]
        if t.startswith("-") and len(t) > 1:
            letters = t[1:]
            # Options that take an argument consume the rest of the token or the next word.
            if letters[-1] in _SSH_OPTS_WITH_ARG and len(letters) == 1:
                j += 2
            else:
                j += 1
            continue
        return t, words[j + 1:]
    return None, []


def _shell_c_script(words: List[str]) -> Optional[str]:
    """`bash -c 'script'` / `bash -lc 'script'` / `su -c 'script'` -> script."""
    for j in range(1, len(words)):
        t = words[j]
        if t.startswith("-") and not t.startswith("--") and "c" in t[1:]:
            return words[j + 1] if j + 1 < len(words) else None
        if not t.startswith("-"):
            return None
    return None


def _git_sub(words: List[str]) -> Tuple[Optional[str], List[str]]:
    j = 1
    while j < len(words):
        t = words[j]
        if t in ("-C", "-c", "--git-dir", "--work-tree", "--namespace"):
            j += 2
            continue
        if t.startswith("-"):
            j += 1
            continue
        return t, words[j + 1:]
    return None, []


def _short_flags(args: Iterable[str]) -> set:
    flags = set()
    for a in args:
        if a.startswith("-") and not a.startswith("--") and len(a) > 1:
            flags.update(a[1:])
    return flags


def _rm_target_safe(target: str, cwd: str) -> bool:
    t = target
    for var in ("$TMPDIR", "${TMPDIR}", "$TMP", "${TMP}"):
        if t.startswith(var + "/") and len(t) > len(var) + 1:
            rest = posixpath.normpath(t[len(var) + 1:])
            return not rest.startswith("..")
    if "$" in t or "`" in t or t.startswith("~"):
        return False
    if t.startswith("/"):
        norm = posixpath.normpath(t)
        if any(norm.startswith(p) and len(norm) > len(p) for p in _TMP_PREFIXES):
            return True
        if cwd:
            cwd_n = posixpath.normpath(cwd)
            if norm.startswith(cwd_n + "/"):
                t = posixpath.relpath(norm, cwd_n)
            else:
                return False
        else:
            return False
    norm = posixpath.normpath(t)
    if norm.startswith("..") or norm in (".", "*"):
        return False
    first = norm.split("/", 1)[0]
    if first in _BUILD_DIRS or first.endswith(".egg-info"):
        return True
    return False


_SQL_DROP_RE = re.compile(r"\b(DROP\s+(TABLE|DATABASE|SCHEMA|OWNED)|TRUNCATE)\b", re.I)


def destructive_sql(sql: str) -> Optional[str]:
    m = _SQL_DROP_RE.search(sql)
    if m:
        return re.sub(r"\s+", " ", m.group(0)).upper()
    for stmt in re.split(r";", sql):
        m = re.search(r"\b(DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b", stmt, re.I)
        if m and not re.search(r"\bWHERE\b", stmt[m.end():], re.I):
            return m.group(1).split()[0].upper() + " without WHERE"
    return None


_TEST_TOKENS = {"test", "tests", "testing"}


def is_test_db_name(name: str) -> bool:
    """`app_test`, `test_app`, `app-test`, `tests.db` -> True; `latest_db`, `contest`, `prod` -> False."""
    return any(tok in _TEST_TOKENS for tok in re.split(r"[_\-.]+", name.lower()))
_DB_VAR_RE = re.compile(r"(DATABASE|(^|_)DB(_|$)|DSN|POSTGRES|^PG|SQLALCHEMY|MYSQL|MONGO)", re.I)


def db_name_from_value(var: str, value: str) -> Optional[Tuple[str, str]]:
    """Return (db_name, host) from a DSN/URL or plain name; None if not a DB setting."""
    v = value.strip().strip("'\"")
    if not v:
        return None
    if "://" in v:
        scheme, rest = v.split("://", 1)
        if scheme.startswith("sqlite"):
            path = rest.split("?", 1)[0]
            if path in ("", "/", ":memory:", "/:memory:"):
                return (":memory:", "local")
            name = basename(path)
            name = re.sub(r"\.(db|sqlite3?|sqlite)$", "", name)
            return (name, "local-file")
        hostpart, _, path = rest.partition("/")
        host = hostpart.rsplit("@", 1)[-1]  # drop credentials, never echo them
        name = path.split("?", 1)[0].split("/", 1)[0]
        return (name or "(default)", host or "?")
    # key=value libpq DSN: "dbname=foo host=bar"
    m = re.search(r"\bdbname=(\S+)", v)
    if m:
        h = re.search(r"\bhost=(\S+)", v)
        return (m.group(1), h.group(1) if h else "?")
    if re.search(r"(NAME|^PGDATABASE$|_DB$|^POSTGRES_DB$)", var, re.I) and re.match(r"^[\w.-]+$", v):
        return (v, "?")
    return None


def read_dotenv(cwd: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not cwd:
        return out
    path = os.path.join(cwd, ".env")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh.read(1_000_000).splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].strip()
                m = _ASSIGN_RE.match(line)
                if m:
                    out[m.group(1)] = m.group(2).strip().strip("'\"")
    except OSError:
        pass
    return out


def read_pytest_env(cwd: str) -> Dict[str, str]:
    """Best effort: DB vars set by pytest-env (`env = ...` in pytest.ini/pyproject/setup.cfg/tox.ini)."""
    out: Dict[str, str] = {}
    if not cwd:
        return out
    line_re = re.compile(r"^\s*[\"']?(?:[DR]:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)[\"']?\s*,?\s*$")
    for fname in ("pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"):
        text = _read_small(os.path.join(cwd, fname))
        if not text or "env" not in text:
            continue
        for line in text.splitlines():
            m = line_re.match(line)
            if m and _DB_VAR_RE.search(m.group(1)) and db_name_from_value(m.group(1), m.group(2)):
                out[m.group(1)] = m.group(2).strip().strip("'\"")
    return out


def effective_db_env(env_sources: List[Tuple[str, Dict[str, str]]]) -> Dict[str, Tuple[str, str]]:
    """Merge sources (highest precedence first) -> {var: (value, source)} for DB-looking vars."""
    merged: Dict[str, Tuple[str, str]] = {}
    for source, env in env_sources:
        for var, val in env.items():
            if _DB_VAR_RE.search(var) and var not in merged:
                merged[var] = (val, source)
    return merged


def non_test_dbs(env_sources: List[Tuple[str, Dict[str, str]]]) -> List[str]:
    """Describe effective DB settings whose database name lacks a test marker (no secrets echoed).

    If ANY effective DB setting names a test database, the run is considered pointed at a test DB
    (projects commonly keep TEST_DATABASE_URL next to DATABASE_URL).
    """
    found: List[str] = []
    saw_test = False
    for var, (val, source) in effective_db_env(env_sources).items():
        parsed = db_name_from_value(var, val)
        if not parsed:
            continue
        name, host = parsed
        if name == ":memory:" or is_test_db_name(name):
            saw_test = True
            continue
        if var.upper().startswith("TEST_") or var.upper().endswith("_TEST"):
            continue  # an explicitly test-scoped variable pointing elsewhere is not our concern
        found.append(f"{var} -> db '{name}' on {host} (from {source})")
    return [] if saw_test else found


def _strip_runner(words: List[str]) -> List[str]:
    """`uv run pytest`, `poetry run alembic`, `python -m pytest` -> the inner command."""
    w = words
    for _ in range(4):
        if not w:
            return w
        n = basename(w[0])
        if n in ("uv", "poetry", "pipenv", "pdm", "hatch", "rye") and len(w) > 1 and w[1] == "run":
            j = 2
            while j < len(w) and w[j].startswith("-"):
                j += 2 if w[j] in ("--with", "--python", "-p", "--env-file", "--group", "--extra") else 1
            w = w[j:]
            continue
        if n in ("uvx", "pipx") or (n == "pipx" and len(w) > 1 and w[1] == "run"):
            w = w[1:] if n == "uvx" else w[2:]
            continue
        if re.match(r"^python(\d+(\.\d+)?)?$", n) and len(w) > 2 and w[1] == "-m":
            w = w[2:]
            continue
        if n in ("coverage",) and len(w) > 2 and w[1] == "run":
            j = 2
            while j < len(w) and w[j].startswith("-"):
                j += 1
            if j < len(w) and w[j] == "-m":
                j += 1
            w = w[j:]
            continue
        return w
    return w


def is_test_or_migration(words: List[str]) -> Optional[str]:
    w = _strip_runner(words)
    if not w:
        return None
    n = basename(w[0])
    if n in ("pytest", "py.test"):
        return "pytest"
    if n == "alembic":
        sub = _alembic_sub(w)
        if sub in ("upgrade", "downgrade", "stamp"):
            return f"alembic {sub}"
    if n == "manage.py" or (re.match(r"^python", n) and len(w) > 1 and basename(w[1]) == "manage.py"):
        rest = w[1:] if n == "manage.py" else w[2:]
        if rest and rest[0] in ("migrate", "test", "flush", "sqlflush"):
            return f"manage.py {rest[0]}"
    if n == "prisma" and len(w) > 1 and w[1] in ("migrate", "db"):
        return "prisma " + w[1]
    return None


def _alembic_sub(words: List[str]) -> Optional[str]:
    j = 1
    while j < len(words):
        t = words[j]
        if t in ("-c", "--config", "-n", "--name", "-x"):
            j += 2
            continue
        if t.startswith("-"):
            j += 1
            continue
        return t
    return None


_SECRET_WORD = r"(secret|token|key|cred|credential|password|passwd|api[-_]?key|jwt|cert)s?"
_ROTATE_RE = re.compile(r"(rotat(e|ion|ing)|regenerate|revoke|roll)[-_ ]?" + _SECRET_WORD
                        + r"|" + _SECRET_WORD + r"[-_ ]?(rotat(e|ion)|regen(erate)?|roll)", re.I)


_NOT_ROTATION_CMDS = {"grep", "egrep", "rg", "ag", "ack", "git", "cat", "less", "more", "head", "tail", "echo",
                      "printf", "man", "logrotate", "sed", "awk", "find", "ls", "vim", "nano", "code", "jq",
                      "test", "[", "true", "false"}


def secret_rotation(words: List[str]) -> Optional[str]:
    if not words:
        return None
    n = basename(words[0])
    if n in _NOT_ROTATION_CMDS:
        return None
    joined = " ".join(words)
    if n == "gh" and words[1:3] == ["secret", "set"]:
        return "gh secret set"
    if n == "aws" and len(words) > 2 and words[1] == "secretsmanager" and words[2] in (
            "rotate-secret", "put-secret-value", "update-secret"):
        return "aws secretsmanager " + words[2]
    if n == "aws" and len(words) > 2 and words[1] == "iam" and words[2] in ("create-access-key", "delete-access-key"):
        return "aws iam " + words[2]
    if n == "vault" and len(words) > 2 and words[1] in ("kv", "write") and ("put" in words or words[1] == "write"):
        return "vault write"
    if n in ("fly", "flyctl") and words[1:3] == ["secrets", "set"]:
        return "fly secrets set"
    if n == "doppler" and words[1:3] == ["secrets", "set"]:
        return "doppler secrets set"
    if n == "kubectl" and len(words) > 2 and words[1] in ("create", "apply") and "secret" in words[2:4]:
        return "kubectl create secret"
    if n == "wrangler" and words[1:3] == ["secret", "put"]:
        return "wrangler secret put"
    # Script/CLI whose name or arguments say "rotate token/secret/key".
    if _ROTATE_RE.search(basename(words[0])) or _ROTATE_RE.search(joined):
        return "secret rotation"
    if re.search(r"\brotate\b", joined, re.I) and re.search(_SECRET_WORD, joined, re.I):
        return "secret rotation"
    return None


_ENV_LOADERS = re.compile(
    r"(set\s+-a|(^|[\s;&|])(source|\.)\s+\S*env|export\s+\$\(|env\s+\$\(|--env-file|EnvironmentFile|"
    r"\bdotenv\b|DATABASE_URL=|DB_DSN=|SQLALCHEMY_URL=|\bdocker\b|\bkubectl\s+exec|systemd-run)",
    re.I)


# --------------------------------------------------------------------------------------
# PreToolUse analysis
# --------------------------------------------------------------------------------------


class Analyzer:
    def __init__(self, cwd: str, process_env: Optional[Dict[str, str]] = None):
        self.cwd = cwd or ""
        self.process_env = dict(process_env) if process_env is not None else {}
        self.findings: List[Finding] = []
        self.host = hostname()

    def add(self, rule: str, level: str, reason: str) -> None:
        self.findings.append(Finding(rule, level, reason))

    def where(self, remote: Optional[str]) -> str:
        if remote:
            return f"remote host '{remote}' (via ssh from local host '{self.host}')"
        return f"host '{self.host}'"

    def analyze(self, cmd: str, remote: Optional[str] = None, depth: int = 0) -> List[Finding]:
        if depth > 4 or not cmd or not cmd.strip():
            return self.findings
        cmd, bodies = strip_heredocs(cmd)
        segs = split_segments(cmd)
        env: Dict[str, str] = {}
        cwd = self.cwd

        # Raw patterns the tokenizer cannot see (command substitution).
        if re.search(r"\bkill\b[^|;&\n]*\$\(\s*pgrep\b", cmd) or re.search(
                r"\bpgrep\b[^|;&\n]*\|\s*(sudo\s+)?xargs\s+(-\S+\s+)*(sudo\s+)?kill\b", cmd):
            self.add("pkill", "deny",
                     "`kill $(pgrep ...)` / `pgrep | xargs kill` matches processes by name/cmdline - same blast "
                     "radius as `pkill -f`. On a shared box it killed prod (test server shares prod's user and "
                     "argv). Find the exact PID first (`pgrep -af PATTERN` / `ps -o pid,user,args`), check it is "
                     "yours, then `kill <PID>`.")

        for pipe in pipelines(segs):
            pipe_text_parts: List[str] = []
            for seg in pipe:
                pipe_text_parts.extend(seg.words)
                for op, tgt in seg.redirects:
                    if op == "<<<":
                        pipe_text_parts.append(tgt)
            for seg in pipe:
                words = unwrap(seg.words, env)
                if not words:
                    continue
                n = basename(words[0])
                heredoc_text = "\n".join(bodies.get(t, "") for _, t in seg.redirects if t in bodies)

                if n == "cd" and len(words) > 1 and not any(c in words[1] for c in "$`~"):
                    cwd = posixpath.normpath(posixpath.join(cwd or "/", words[1]))
                    continue
                if n == "export":
                    for t in words[1:]:
                        m = _ASSIGN_RE.match(t)
                        if m:
                            env[m.group(1)] = m.group(2)
                    continue

                # ---- recursion into nested shells / remote commands
                if n == "ssh":
                    host, remote_words = parse_ssh(words)
                    if remote_words:
                        remote_cmd = " ".join(remote_words) if len(remote_words) > 1 else remote_words[0]
                        self._ssh_alembic_env(remote_cmd, host)
                        self.analyze(remote_cmd, remote=host or "?", depth=depth + 1)
                    if heredoc_text:  # `ssh host <<EOF` or `ssh host bash -s <<EOF`
                        self._ssh_alembic_env(heredoc_text, host)
                        self.analyze(heredoc_text, remote=host or "?", depth=depth + 1)
                    continue
                if n in _SHELLS or n == "su":
                    script = _shell_c_script(words)
                    if script:
                        self.analyze(script, remote=remote, depth=depth + 1)
                    elif heredoc_text and len(words) <= 2:
                        self.analyze(heredoc_text, remote=remote, depth=depth + 1)
                    continue
                if n == "eval" and len(words) > 1:
                    self.analyze(" ".join(words[1:]), remote=remote, depth=depth + 1)
                    continue
                if n == "docker" and len(words) > 2 and words[1] == "exec":
                    # docker exec [opts] CONTAINER cmd... -> analyze inner command (same host).
                    j = 2
                    while j < len(words) and words[j].startswith("-"):
                        j += 2 if words[j] in ("-e", "--env", "-u", "--user", "-w", "--workdir",
                                               "--env-file") else 1
                    inner = words[j + 1:]
                    if inner:
                        self._segment_rules(inner, seg, pipe_text_parts, heredoc_text, env, cwd, remote)
                    continue

                self._segment_rules(words, seg, pipe_text_parts, heredoc_text, env, cwd, remote)
        return self.findings

    # ------------------------------------------------------------------
    def _ssh_alembic_env(self, remote_cmd: str, host: Optional[str]) -> None:
        if re.search(r"\balembic\b[^;&|\n]*\bupgrade\b", remote_cmd) and not _ENV_LOADERS.search(remote_cmd):
            self.add("alembic-ssh-env", "warn",
                     f"`alembic upgrade` over ssh on '{host}' without loading the service environment. A bare "
                     "ssh shell does not have the systemd unit's EnvironmentFile, so alembic falls back to the "
                     "default URL in alembic.ini/env.py (auraengine x3: migrated a local SQLite file while prod "
                     "Postgres stayed old). Load the env first, e.g. `set -a; . /path/to/.env; set +a; alembic "
                     "upgrade head`, then confirm with `alembic current` against the real DB.")

    def _segment_rules(self, words: List[str], seg: Segment, pipe_text_parts: List[str], heredoc_text: str,
                       env: Dict[str, str], cwd: str, remote: Optional[str]) -> None:
        n = basename(words[0])
        args = words[1:]

        # ---- pkill / killall
        if n in ("pkill", "killall", "pkill.exe"):
            self.add("pkill", "deny",
                     f"`{n}` matches processes by name/cmdline, not by identity. On a shared box a test server "
                     "shares prod's user and argv, so `pkill -f` killed production. Find the exact PID "
                     "(`pgrep -af PATTERN` / `ps -o pid,user,lstart,args -p ...`), confirm it is the process you "
                     "started, then `kill <PID>`.")

        # ---- git
        if n == "git":
            sub, rest = _git_sub(words)
            if sub == "push":
                flags = _short_flags(rest)
                long_force = [a for a in rest if a in ("--force", "--force-with-lease", "--force-if-includes",
                                                         "--mirror", "--delete")
                              or a.startswith("--force-with-lease=")]
                plus_ref = [a for a in rest if a.startswith("+") and len(a) > 1]
                delete_ref = [a for a in rest if a.startswith(":") and len(a) > 1]
                if "f" in flags or "d" in flags or long_force or plus_ref or delete_ref:
                    what = (long_force or plus_ref or delete_ref or ["-f/-d"])[0]
                    self.add("force-push", "ask",
                             f"`git push {what}` rewrites or deletes remote history on {self.where(remote)}. "
                             "Other agents/humans may have pushed on top. Confirm the branch is yours and "
                             "nobody else works on it; prefer a new branch or a revert commit.")
            elif sub == "reset" and "--hard" in rest:
                self.add("git-reset-hard", "ask",
                         f"`git reset --hard` on {self.where(remote)} discards uncommitted work irreversibly - "
                         "including other agents' changes in a shared checkout. Check `git status` / "
                         "`git stash list` first, or use `git stash` so it can be undone.")
            elif sub == "clean" and ("f" in _short_flags(rest) or "--force" in rest) and "n" not in _short_flags(
                    rest) and "--dry-run" not in rest:
                self.add("git-reset-hard", "ask",
                         f"`git clean -f` on {self.where(remote)} deletes untracked files irreversibly. Run "
                         "`git clean -n` first to see what would go.")

        # ---- rm -rf
        if n == "rm":
            flags = _short_flags(args)
            recursive = bool({"r", "R"} & flags) or "--recursive" in args
            force = "f" in flags or "--force" in args
            if recursive and force:
                targets = []
                after_ddash = False
                for a in args:
                    if a == "--":
                        after_ddash = True
                        continue
                    if a.startswith("-") and not after_ddash:
                        continue
                    targets.append(a)
                bad = [t for t in targets if not _rm_target_safe(t, cwd if not remote else "")]
                if bad or not targets:
                    shown = ", ".join(bad[:5]) if bad else "(targets from stdin/xargs - unknown)"
                    self.add("rm-rf", "ask",
                             f"`rm -rf` outside /tmp and the project's build dirs on {self.where(remote)}: "
                             f"{shown}. This is irreversible. Double-check the expanded path (`ls -ld <path>`).")

        # ---- destructive SQL through a DB client
        if n in _DB_CLIENTS:
            sql_parts = [" ".join(pipe_text_parts), heredoc_text]
            for i, a in enumerate(args):
                if a in ("-f", "--file") and i + 1 < len(args) and not remote:
                    sql_parts.append(_read_small(os.path.join(cwd or ".", args[i + 1])))
                if a in (".read",) and i + 1 < len(args) and not remote:
                    sql_parts.append(_read_small(os.path.join(cwd or ".", args[i + 1])))
            for op, tgt in seg.redirects:
                if op == "<" and tgt and not remote:
                    sql_parts.append(_read_small(os.path.join(cwd or ".", tgt)))
            hit = destructive_sql("\n".join(p for p in sql_parts if p))
            if hit:
                self.add("sql-destructive", "ask",
                         f"Destructive SQL ({hit}) via `{n}` on {self.where(remote)}. Confirm which database this "
                         "connects to (aurasoul_coin 2026-06-15: a run against the PROD database wiped users and "
                         "ledger). Take a backup / run it inside BEGIN; ... ROLLBACK; first.")
        if n in ("dropdb",):
            self.add("sql-destructive", "ask",
                     f"`dropdb` on {self.where(remote)} destroys a whole database. Confirm the target and backup.")
        if n == "redis-cli" and any(a.lower() in ("flushall", "flushdb") for a in args):
            self.add("sql-destructive", "ask", f"`redis-cli FLUSH*` on {self.where(remote)} wipes data.")

        # ---- alembic downgrade
        inner = _strip_runner(words)
        if inner and basename(inner[0]) == "alembic" and _alembic_sub(inner) == "downgrade":
            self.add("alembic-downgrade", "ask",
                     f"`alembic downgrade` on {self.where(remote)} drops schema (and usually data) in the target "
                     "DB. Confirm which DATABASE_URL alembic will use and that a backup exists.")

        # ---- tests / migrations against a non-test DB
        kind = is_test_or_migration(words)
        if kind and not remote:
            sources: List[Tuple[str, Dict[str, str]]] = [("command", env)]
            if kind == "pytest":
                sources.append(("pytest env config", read_pytest_env(cwd)))
            if self.process_env:
                sources.append(("process env", self.process_env))
            dotenv = read_dotenv(cwd)
            if dotenv:
                sources.append((os.path.join(cwd, ".env"), dotenv))
            bad = non_test_dbs(sources)
            if bad:
                self.add("test-db", "ask",
                         f"`{kind}` with database settings that do not look like a test DB: "
                         + "; ".join(bad[:4])
                         + ". Heuristic: a DB name without `test` as a separate token (`_test`, `test_`, "
                           "`-test`) is treated as real data. aurasoul_coin 2026-06-15: tests ran against the prod "
                           "DB and wiped users/ledger. Point the run at a *_test database (or confirm the project's "
                           "conftest overrides it) before continuing.")

        # ---- service restart / stop
        if n == "systemctl":
            sub_args = [a for a in args if not a.startswith("-")]
            if sub_args and sub_args[0] in ("restart", "stop", "kill", "try-restart", "reload-or-restart",
                                             "condrestart", "force-reload", "disable", "mask"):
                units = " ".join(sub_args[1:]) or "(no unit)"
                self._restart(f"systemctl {sub_args[0]} {units}", remote)
        if n == "service" and len(args) >= 2 and args[1] in ("restart", "stop", "force-reload"):
            self._restart(f"service {args[0]} {args[1]}", remote)
        if n == "supervisorctl" and args and args[0] in ("restart", "stop"):
            self._restart(f"supervisorctl {' '.join(args)}", remote)

        # ---- secret rotation
        rot = secret_rotation(words)
        if rot:
            self.add("secret-rotation", "ask",
                     f"{rot} on {self.where(remote)}. Confirm this is the intended host/environment and list every "
                     "consumer of this secret first (warehouse: a token rotated on the wrong host caused a 10 h "
                     "outage). Run `hostname` and check which services read the secret before rotating.")

    def _restart(self, what: str, remote: Optional[str]) -> None:
        self.add("service-restart", "ask",
                 f"`{what}` on {self.where(remote)}. Confirm this is the intended host and that the service runs "
                 "the right branch/commit with migrations applied (aurasoul 10-04: prod was started from a branch "
                 "without migrations). If this service hosts your own agent session (e.g. the Aura/companion "
                 "server), restarting it kills this very command (exit 137) - run it detached "
                 "(`systemd-run --on-active=2 systemctl restart ...`) and verify afterwards.")


def _read_small(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(1_000_000)
    except OSError:
        return ""


def _guidance(level: str, rules: List[str]) -> str:
    """Footer appended to ask/deny reasons. The leading `(guards decision: <level>.` marker is
    machine-read by the Aura server (web/server/guard-denial.ts) - keep it stable."""
    disable_json = json.dumps({"disable": rules})
    inline_note = ("An inline `GUARDS_DISABLE=" + rules[0] + " <command>` prefix does NOT work: the hook checks "
                   "the command before it runs and only reads its own environment.")
    if level == "deny":
        return ("(guards decision: deny. This cannot be approved once - do not retry; follow the advice above "
                "or ask the user. If this is a false positive, the user can opt the project out persistently "
                "with " + disable_json + " in <project>/.claude/guards.json. " + inline_note + ")")
    return ("(guards decision: ask. Do not retry or work around this on your own - ask the user. In Aura the "
            "user can press \"Allow once\" on the guard card to approve exactly this command one time. For a "
            "persistent project-level opt-out of a false positive, add " + disable_json
            + " to <project>/.claude/guards.json. " + inline_note + ")")


def decide(findings: List[Finding], disabled: set) -> Optional[dict]:
    if "all" in disabled:
        return None
    active = [f for f in findings if f.rule not in disabled]
    if not active:
        return None
    top = max(active, key=lambda f: LEVEL_ORDER[f.level])
    # De-duplicate identical reasons while keeping order.
    seen = set()
    lines = []
    for f in sorted(active, key=lambda f: -LEVEL_ORDER[f.level]):
        key = (f.rule, f.reason)
        if key in seen:
            continue
        seen.add(key)
        lines.append(f"[guards:{f.rule}] {f.reason}")
    text = "\n".join(lines)
    hso: dict = {"hookEventName": "PreToolUse"}
    if top.level in ("deny", "ask"):
        blocking = []
        for f in sorted(active, key=lambda f: -LEVEL_ORDER[f.level]):
            if f.level in ("deny", "ask") and f.rule not in blocking:
                blocking.append(f.rule)
        hso["permissionDecision"] = top.level
        hso["permissionDecisionReason"] = text + "\n" + _guidance(top.level, blocking)
    else:
        hso["additionalContext"] = text
    return {"hookSpecificOutput": hso}


# --------------------------------------------------------------------------------------
# One-shot allowance ("Allow once" in Aura)
# --------------------------------------------------------------------------------------
#
# Written by web/server/guard-denial.ts; keep the two in sync (format v1):
#   ~/.companion/guards-allow/<random>.json  (dir 0700, files 0600)
#   {"v": 1, "rule": "<first rule>", "rules": [...], "commandSha256": "<hex sha256 of the exact command>",
#    "cwd": "<session cwd or ''>", "expiresAt": <epoch ms>, "nonce": "<hex>", "sig": "<hex hmac-sha256>"}
#   sig = HMAC-SHA256(key, "guards-allow-v1\n" + ",".join(sorted(rules)) + "\n" + commandSha256 + "\n"
#                          + cwd + "\n" + str(expiresAt) + "\n" + nonce)
#   key = contents of ~/.companion/guards-allow/.hmac-key (created by the server, 0600).
# No key file -> no entry is ever valid (fail closed). The HMAC stops an agent from approving
# itself by just writing a JSON file; it is NOT a security boundary against an agent that
# deliberately reads the key (same OS user) - see README "Allow once".

ALLOW_SUBDIR = (".companion", "guards-allow")
ALLOW_KEY_NAME = ".hmac-key"
ALLOW_MAX_TTL_MS = 15 * 60 * 1000  # reject entries claiming a longer life than the server ever issues


def allow_dir() -> str:
    home = os.environ.get("HOME") or os.path.expanduser("~")
    return os.path.join(home, *ALLOW_SUBDIR)


def command_sha256(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8")).hexdigest()


def allow_signing_string(rules: Iterable[str], cmd_sha: str, cwd: str, expires_at: int, nonce: str) -> str:
    return "\n".join(["guards-allow-v1", ",".join(sorted(rules)), cmd_sha, cwd, str(int(expires_at)), nonce])


def _read_allow_key(directory: str) -> Optional[bytes]:
    try:
        with open(os.path.join(directory, ALLOW_KEY_NAME), "rb") as fh:
            key = fh.read(4096).strip()
        return key or None
    except OSError:
        return None


def _cwd_matches(entry_cwd: str, cwd: str) -> bool:
    if not entry_cwd:
        return True
    a = posixpath.normpath(entry_cwd)
    b = posixpath.normpath(cwd or "")
    return b == a or b.startswith(a.rstrip("/") + "/")


def _valid_entry(entry: object, key: bytes, rules: set, cmd_sha: str, cwd: str, now_ms: int) -> Tuple[bool, bool]:
    """Return (matches, expired)."""
    if not isinstance(entry, dict) or entry.get("v") != 1:
        return False, False
    raw_rules = entry.get("rules")
    if not isinstance(raw_rules, list):
        raw_rules = [entry.get("rule")]
    entry_rules = [r for r in raw_rules if isinstance(r, str) and r]
    expires_at = entry.get("expiresAt")
    sha = entry.get("commandSha256")
    entry_cwd = entry.get("cwd") or ""
    nonce = entry.get("nonce")
    sig = entry.get("sig")
    if (not entry_rules or not isinstance(expires_at, int) or isinstance(expires_at, bool)
            or not isinstance(sha, str) or not isinstance(entry_cwd, str) or not isinstance(nonce, str)
            or not isinstance(sig, str)):
        return False, False
    if expires_at <= now_ms:
        return False, True
    if expires_at > now_ms + ALLOW_MAX_TTL_MS:
        return False, False
    want = hmac.new(key, allow_signing_string(entry_rules, sha, entry_cwd, expires_at, nonce).encode("utf-8"),
                    hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, sig):
        return False, False
    if not hmac.compare_digest(sha, cmd_sha):
        return False, False
    if not rules.issubset(set(entry_rules)):
        return False, False
    return _cwd_matches(entry_cwd, cwd), False


def consume_allow_once(rules: Iterable[str], command: str, cwd: str, now_ms: Optional[int] = None,
                       directory: Optional[str] = None) -> Optional[str]:
    """If a valid one-shot entry covers every rule in `rules` for this exact command, consume it
    and return its file name; else None. Consumption happens BEFORE the caller allows anything:
    the entry is atomically renamed away (only one concurrent hook can win the rename), then
    deleted. If the delete fails the renamed file no longer ends in .json and is never read again.
    Expired entries are deleted opportunistically."""
    rules = set(rules)
    if not rules or not command:
        return None
    directory = directory or allow_dir()
    try:
        names = sorted(n for n in os.listdir(directory) if n.endswith(".json"))
    except OSError:
        return None
    key = _read_allow_key(directory)
    if key is None:
        return None
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    cmd_sha = command_sha256(command)
    for name in names:
        path = os.path.join(directory, name)
        try:
            if os.path.islink(path):
                continue
            with open(path, "r", encoding="utf-8") as fh:
                entry = json.loads(fh.read(65536))
        except (OSError, ValueError):
            continue
        matches, expired = _valid_entry(entry, key, rules, cmd_sha, cwd, now_ms)
        if expired:
            try:
                os.unlink(path)
            except OSError:
                pass
            continue
        if not matches:
            continue
        claimed = f"{path}.consumed-{os.getpid()}-{int(time.time() * 1e6)}"
        try:
            os.rename(path, claimed)
        except OSError:
            continue  # someone else consumed it first (or it vanished)
        try:
            os.unlink(claimed)
        except OSError:
            pass
        return name
    return None


def pre_tool_use(payload: dict) -> Optional[dict]:
    if payload.get("tool_name") != "Bash":
        return None
    cmd = (payload.get("tool_input") or {}).get("command") or ""
    cwd = payload.get("cwd") or os.getcwd()
    disabled = disabled_rules(cwd)
    if "all" in disabled:
        return None
    findings = Analyzer(cwd, process_env=_db_process_env()).analyze(cmd)
    active = [f for f in findings if f.rule not in disabled]
    levels = {f.level for f in active}
    if "ask" in levels and "deny" not in levels:
        # "deny" findings are never allowed once; an "ask" decision is, if the user approved
        # exactly this command (and every ask rule in it) via Aura.
        ask_rules = {f.rule for f in active if f.level == "ask"}
        consumed = consume_allow_once(ask_rules, cmd, cwd)
        if consumed:
            rest = [f for f in active if f.level != "ask"]
            note = ("[guards] Allowed once by the user via Aura (rules: " + ", ".join(sorted(ask_rules))
                    + "). The approval is used up; the next run of a risky command asks again.")
            out = decide(rest, disabled)
            if out:
                hso = out["hookSpecificOutput"]
                hso["additionalContext"] = note + "\n" + hso.get("additionalContext", "")
                return out
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": note}}
    return decide(findings, disabled)


def _db_process_env() -> Dict[str, str]:
    return {k: v for k, v in os.environ.items() if _DB_VAR_RE.search(k) and not k.startswith("GUARDS_")}


# --------------------------------------------------------------------------------------
# Deploy / verification detection (PostToolUse + Stop)
# --------------------------------------------------------------------------------------

_DEPLOY_SCRIPT_RE = re.compile(r"^(deploy|release|rollout|redeploy)([\w.-]*)$", re.I)
_VERIFY_WORD_RE = re.compile(r"(health|healthz|readyz|livez|smoke|/status\b|/version\b|probe)", re.I)


def classify_events(cmd: str, depth: int = 0, remote: bool = False) -> List[str]:
    """Return the ordered list of 'deploy' / 'verify' events in a shell command."""
    events: List[str] = []
    if depth > 4 or not cmd:
        return events
    cmd2, bodies = strip_heredocs(cmd)
    for seg in split_segments(cmd2):
        words = unwrap(seg.words, {})
        if not words:
            continue
        n = basename(words[0])
        args = words[1:]
        heredoc_text = "\n".join(bodies.get(t, "") for _, t in seg.redirects if t in bodies)
        if n == "ssh":
            _host, rw = parse_ssh(words)
            inner = (" ".join(rw) if len(rw) > 1 else (rw[0] if rw else "")) or heredoc_text
            events.extend(classify_events(inner, depth + 1, remote=True))
            continue
        if n in _SHELLS:
            script = _shell_c_script(words)
            if script or (heredoc_text and len(words) <= 2):
                events.extend(classify_events(script or heredoc_text, depth + 1, remote))
                continue
        ev = _classify_words(words, n, args, remote)
        if ev:
            events.append(ev)
    return events


def _classify_words(words: List[str], n: str, args: List[str], remote: bool) -> Optional[str]:
    plain = [a for a in args if not a.startswith("-")]
    sub = plain[0] if plain else ""
    # --- verification first (status-style subcommands)
    if n in ("curl", "wget", "http", "https", "xh", "httpie", "agent-browser", "journalctl", "nc", "ss",
             "netstat", "lsof", "dig", "host"):
        return "verify"
    if n == "systemctl" and sub in ("status", "is-active", "is-failed", "show", "list-units"):
        return "verify"
    if n in ("docker", "podman"):
        if sub in ("ps", "logs", "inspect", "stats", "top"):
            return "verify"
        if sub == "compose" or n == "docker-compose":
            pass
    if n in ("docker", "podman", "docker-compose"):
        rest = plain[1:] if (sub == "compose" and n != "docker-compose") else plain
        csub = rest[0] if rest else ""
        if sub == "compose" or n == "docker-compose":
            if csub in ("ps", "logs", "top", "images"):
                return "verify"
            if csub in ("up", "restart", "start", "pull", "create"):
                return "deploy"
        if sub in ("restart", "start", "run") and n != "docker-compose" and (sub != "run" or "-d" in args
                                                                           or "--detach" in args):
            return "deploy"
        if sub == "service" and len(plain) > 1 and plain[1] in ("update", "create"):
            return "deploy"
        if sub == "stack" and len(plain) > 1 and plain[1] == "deploy":
            return "deploy"
    if n == "kubectl":
        if sub in ("get", "describe", "logs", "top") or (sub == "rollout" and "status" in plain):
            return "verify"
        if sub in ("apply", "replace", "set", "create") or (sub == "rollout" and "restart" in plain):
            return "deploy"
    if n in ("pm2",):
        if sub in ("status", "list", "ls", "logs", "describe", "show"):
            return "verify"
        if sub in ("restart", "reload", "start", "startOrReload", "startOrRestart"):
            return "deploy"
    if n == "supervisorctl":
        if sub == "status":
            return "verify"
        if sub in ("restart", "start", "reload", "update"):
            return "deploy"
    if n == "systemctl" and sub in ("restart", "start", "reload", "try-restart", "reload-or-restart",
                                    "condrestart"):
        return "deploy"
    if n == "service" and len(plain) >= 2 and plain[1] in ("start", "restart", "reload"):
        return "deploy"
    if n in ("fly", "flyctl"):
        if sub in ("status", "logs", "checks"):
            return "verify"
        if sub == "deploy":
            return "deploy"
    if n in ("vercel", "netlify", "wrangler", "railway", "heroku", "firebase", "gcloud", "serverless", "sls"):
        if sub in ("deploy", "publish", "up") or "--prod" in args:
            return "deploy"
    if n == "helm" and sub in ("upgrade", "install"):
        return "deploy"
    if n == "gh" and sub == "run" and len(plain) > 1 and plain[1] in ("view", "watch"):
        return "verify"
    if n == "git" and remote:
        gsub, _ = _git_sub(words)
        if gsub in ("pull", "merge", "reset", "checkout", "switch"):
            return "deploy"
    if n == "rsync" and any(re.match(r"^[\w.@-]+:", a) for a in plain[-1:]):
        return "deploy"
    if n in ("make", "just", "task", "npm", "pnpm", "yarn", "bun"):
        targets = [a for a in plain if a != "run"]
        if targets and _DEPLOY_SCRIPT_RE.match(targets[0]):
            return "deploy"
        if targets and _VERIFY_WORD_RE.search(targets[0]):
            return "verify"
    if n in _SHELLS or n in ("python", "python3", "node", "bun", "deno"):
        script = plain[0] if plain else ""
        if script and _DEPLOY_SCRIPT_RE.match(basename(script).split(".")[0] + ""):
            return "deploy"
        if script and _VERIFY_WORD_RE.search(basename(script)):
            return "verify"
    if _DEPLOY_SCRIPT_RE.match(n.split(".")[0]) or re.match(r"^(deploy|redeploy)[\w-]*\.sh$", n, re.I):
        return "deploy"
    if _VERIFY_WORD_RE.search(n):
        return "verify"
    return None


DEPLOY_REMINDER = (
    "[guards:deploy-verify] That was a deploy-like command. Before saying it is done/deployed, prove it on the "
    "LIVE system: (1) probe the public URL/endpoint the user hits (`curl -sS -o /dev/null -w '%{http_code}' "
    "https://...`, health endpoint); (2) confirm the running version/SHA matches what you shipped (version "
    "endpoint, `git -C <deploy dir> rev-parse HEAD`, image label, process start time vs. commit time); "
    "(3) read the service logs since the restart (`journalctl -u <unit> --since -5min`, `docker compose logs "
    "--since 5m`). In 14 of 19 audited projects 'deployed SUCCESS' was claimed while prod still ran old code "
    "or was broken.")


def post_tool_use(payload: dict) -> Optional[dict]:
    if payload.get("tool_name") != "Bash":
        return None
    cwd = payload.get("cwd") or os.getcwd()
    disabled = disabled_rules(cwd)
    if "all" in disabled or "deploy-verify" in disabled:
        return None
    cmd = (payload.get("tool_input") or {}).get("command") or ""
    events = classify_events(cmd)
    if "deploy" not in events:
        return None
    last_deploy = max(i for i, e in enumerate(events) if e == "deploy")
    if "verify" in events[last_deploy + 1:]:
        return None  # the same command already verifies after deploying
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": DEPLOY_REMINDER}}


# --------------------------------------------------------------------------------------
# Stop hook: "done needs proof"
# --------------------------------------------------------------------------------------

_DONE_RE = re.compile(
    r"(\b(done|deployed|shipped|released|rolled out|is live|now live|live now|completed|all set|fixed|"
    r"up and running|works now|successfully)\b|"
    r"готово|задеплоен|задеплоил|развёрнут|развернут|развернул|развёрнул|выкачен|выкатил|выложен|выложил|"
    r"сделано|исправлено|запущен|работает)", re.I)
_HONEST_RE = re.compile(
    r"(not (yet )?verified|unverified|could not verify|couldn't verify|did not verify|didn't verify|"
    r"not deployed|не проверен|не проверял|без проверки|не удалось проверить|не задеплоен|не развёрнут|"
    r"не развернут)", re.I)
_VERIFY_TOOLS = re.compile(r"(WebFetch|browser|playwright|puppeteer|fetch)", re.I)


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _is_real_user_turn(entry: dict) -> bool:
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") == "text" for b in content) and not any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
    return False


def load_transcript(path: str) -> List[dict]:
    entries: List[dict] = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if isinstance(obj, dict):
                    entries.append(obj)
    except OSError:
        pass
    return entries


def turn_activity(entries: List[dict]) -> Tuple[List[str], str]:
    """Events ('deploy'/'verify') in the current turn and the last assistant text."""
    start = 0
    for i, e in enumerate(entries):
        if _is_real_user_turn(e):
            start = i
    events: List[str] = []
    last_text = ""
    for e in entries[start:]:
        if e.get("type") != "assistant" or e.get("isSidechain"):
            continue
        content = (e.get("message") or {}).get("content")
        if not isinstance(content, list):
            if isinstance(content, str) and content.strip():
                last_text = content
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text", "").strip():
                last_text = b["text"]
            if b.get("type") == "tool_use":
                name = b.get("name", "")
                inp = b.get("input") or {}
                if name == "Bash":
                    events.extend(classify_events(inp.get("command", "") or ""))
                elif _VERIFY_TOOLS.search(name):
                    events.append("verify")
    return events, last_text


def stop_hook(payload: dict) -> Optional[dict]:
    if payload.get("stop_hook_active"):
        return None  # we already blocked once in this stop cycle; never loop
    cwd = payload.get("cwd") or os.getcwd()
    disabled = disabled_rules(cwd)
    if "all" in disabled or "done-needs-proof" in disabled:
        return None
    entries = load_transcript(payload.get("transcript_path") or "")
    events, last_text = turn_activity(entries)
    final = payload.get("last_assistant_message") or last_text
    if "deploy" not in events:
        return None
    last_deploy = max(i for i, e in enumerate(events) if e == "deploy")
    if "verify" in events[last_deploy + 1:]:
        return None
    if not final or not _DONE_RE.search(final) or _HONEST_RE.search(final):
        return None
    return {
        "decision": "block",
        "reason": (
            "[guards:done-needs-proof] This turn ran a deploy-like command, and your final message claims it is "
            "done, but no verification ran after the last deploy. Before finishing, show evidence from the LIVE "
            "system: an HTTP probe of the public URL/health endpoint, the running version/SHA, and the service "
            "logs/status since the restart (curl / journalctl / systemctl status / docker ps). If you cannot "
            "verify, say explicitly that it is NOT verified and what the user should check."),
    }


# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------


def main(argv: List[str]) -> int:
    mode = argv[1] if len(argv) > 1 else ""
    try:
        if mode == "check":
            cmd = " ".join(argv[2:]) if len(argv) > 2 else sys.stdin.read()
            cwd = os.getcwd()
            res = decide(Analyzer(cwd, process_env=_db_process_env()).analyze(cmd), disabled_rules(cwd))
            print(json.dumps(res or {"decision": "allow"}, ensure_ascii=False, indent=2))
            return 0
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            return 0
        handler = {"pre": pre_tool_use, "post": post_tool_use, "stop": stop_hook}.get(mode)
        if handler is None:
            sys.stderr.write("usage: guards.py pre|post|stop|check\n")
            return 0
        out = handler(payload)
        if out:
            sys.stdout.write(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as exc:  # fail open: a guard bug must never wedge the agent
        sys.stderr.write(f"guards: internal error ignored: {exc!r}\n")
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
