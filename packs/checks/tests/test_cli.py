"""CLI contract: modes, pack selection, exit codes, output formats, launcher script."""
import json
import subprocess
from pathlib import Path

from tests.helpers import Repo, RepoTestCase, fake_npm

BIN = Path(__file__).resolve().parent.parent / "bin" / "aura-check"


class CliTest(RepoTestCase):
    def test_list_shows_every_pack(self):
        rc, out, _ = self.repo.cli("--list")
        self.assertEqual(rc, 0)
        for pack in ("python-alembic", "env", "secrets", "pii", "llm-output", "fallback", "deploy",
                     "telegram-miniapp", "call-site-parity", "uiux"):
            self.assertIn(f"[{pack}]", out)

    def test_usage_errors_exit_2(self):
        self.assertEqual(self.repo.cli("--pack", "nope")[0], 2)
        self.assertEqual(self.repo.cli("--base", "main")[0], 2)
        self.assertEqual(self.repo.cli("--commit-msg-file", "/nonexistent/msg")[0], 2)

    def test_changed_outside_git_exits_2(self):
        plain = Repo(git_init=False)
        self.addCleanup(plain.cleanup)
        self.assertEqual(plain.cli("--changed")[0], 2)

    def test_clean_repo_exits_0_silently(self):
        self.repo.write("README.md", "hello\n")
        self.repo.commit()
        self.assertEqual(self.repo.cli(), (0, "", ""))

    def test_warnings_exit_0_unless_strict(self):
        self.repo.write("docker-compose.yml", "services: {}\n")
        self.repo.write(".gitignore", ".env\n")
        self.repo.write(".env", "P=a$b\n", mode=0o600)
        self.repo.commit()
        self.assertEqual(self.repo.cli()[0], 0)
        self.assertEqual(self.repo.cli("--strict")[0], 1)

    def test_pack_filter_and_json_format(self):
        self.repo.write("cfg.py", f"NPM = '{fake_npm()}'\n")
        self.repo.commit()
        rc, out, _ = self.repo.cli("--pack", "env,pii")
        self.assertEqual((rc, out), (0, ""))
        rc, out, _ = self.repo.cli("--pack", "secrets", "--format", "json")
        self.assertEqual(rc, 1)
        data = json.loads(out)
        self.assertEqual([(d["rule_id"], d["severity"], d["path"], d["line"]) for d in data],
                         [("secrets.in-file", "error", "cfg.py", 1)])

    def test_text_output_has_hint_and_evidence(self):
        self.repo.write("cfg.py", f"NPM = '{fake_npm()}'\n")
        self.repo.commit()
        _, out, _ = self.repo.cli()
        self.assertIn("fix: ", out)
        self.assertIn("why (evidence from real projects):", out)
        self.assertIn("1 error(s), 0 warning(s)", out)

    def test_ignore_file(self):
        self.repo.write("fixtures/cfg.py", f"NPM = '{fake_npm()}'\n")
        self.repo.write(".aura-check-ignore", "# vendored fixtures\nsecrets.in-file fixtures/*\n")
        self.repo.commit()
        self.assertEqual(self.repo.cli()[0], 0)

    def test_walk_mode_without_git(self):
        # Non-git trees are scanned by walking the directory.
        tree = Repo(git_init=False)
        self.addCleanup(tree.cleanup)
        plain = tree.root
        (plain / "node_modules").mkdir(parents=True)
        (plain / "node_modules" / "x.py").write_text(f"NPM = '{fake_npm()}'\n")
        (plain / "a.py").write_text(f"NPM = '{fake_npm(7)}'\n")
        from aura_check import core
        findings = core.run(core.Context(plain), ["secrets"])
        self.assertEqual([f.path for f in findings], ["a.py"])

    def test_launcher_script(self):
        self.repo.write("cfg.py", f"NPM = '{fake_npm()}'\n")
        self.repo.commit()
        proc = subprocess.run([str(BIN), "--root", str(self.repo.root)], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("secrets.in-file", proc.stdout)
