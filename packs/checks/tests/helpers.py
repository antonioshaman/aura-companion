"""Shared fixtures: throwaway git repos and synthetic secrets.

Fixture secrets are generated at runtime from a seeded PRNG, so no
token-shaped literal ever exists in this source tree (the repo stays clean for
aura-check itself and for GitHub push protection). They are random enough to
pass the "looks fake" filter, but they are not real credentials.
"""
from __future__ import annotations

import io
import os
import random
import shutil
import string
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import List, Optional, Tuple

from aura_check import cli, core

ALNUM = string.ascii_letters + string.digits


def rand(n: int, seed: int, alphabet: str = ALNUM) -> str:
    rng = random.Random(seed)
    return "".join(rng.choice(alphabet) for _ in range(n))


def fake_npm(seed: int = 1) -> str:
    return "npm" + "_" + rand(36, seed)


def fake_openai(seed: int = 2) -> str:
    return "sk" + "-proj-" + rand(40, seed)


def fake_gonka(seed: int = 3) -> str:
    return "gnk" + "-" + rand(32, seed)


def fake_bot_token(seed: int = 4) -> str:
    return rand(10, seed, "123456789") + ":" + rand(35, seed + 100)


def fake_private_key_header() -> str:
    return "-----BEGIN " + "OPENSSH PRIVATE" + " KEY-----"


def phone_ru() -> str:
    return "+7" + " 912 " + "345-67-89"


class Repo:
    """A temporary git repository with helpers to stage files and run checks."""

    def __init__(self, git_init: bool = True):
        self.root = Path(tempfile.mkdtemp(prefix="aura-check-test-"))
        if git_init:
            self.git("init", "-q", "-b", "main")
            self.git("config", "user.email", "test@example.invalid")
            self.git("config", "user.name", "aura-check test")
            self.git("config", "commit.gpgsign", "false")
            self.git("config", "core.hooksPath", "/dev/null")

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout

    def write(self, rel: str, text: str, mode: Optional[int] = None) -> Path:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        if mode is not None:
            os.chmod(p, mode)
        return p

    def add(self, *rels: str) -> None:
        self.git("add", "--", *(rels or (".",)))

    def commit(self, message: str = "chore: fixture") -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)

    def ctx(self, **kw) -> core.Context:
        # Full scans only see tracked files: stage fixtures written so far.
        if not kw.get("changed") and (self.root / ".git").exists():
            self.git("add", "-A")
        return core.Context(self.root, **kw)

    def findings(self, packs: Optional[List[str]] = None, **kw) -> List[core.Finding]:
        return core.run(self.ctx(**kw), packs)

    def ids(self, packs: Optional[List[str]] = None, **kw) -> List[str]:
        return [f.rule_id for f in self.findings(packs, **kw)]

    def cli(self, *args: str) -> Tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = cli.main(["--root", str(self.root), *args])
        return rc, out.getvalue(), err.getvalue()


class RepoTestCase(unittest.TestCase):
    git_init = True

    def setUp(self) -> None:
        self.repo = Repo(git_init=self.git_init)
        self.addCleanup(self.repo.cleanup)
