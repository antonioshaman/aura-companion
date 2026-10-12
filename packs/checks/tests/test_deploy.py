"""deploy pack: inline secrets in systemd units; service running from a non-main/dirty checkout."""
import tempfile
from pathlib import Path

from tests.helpers import Repo, RepoTestCase

UNIT = "[Unit]\nDescription=bot\n\n[Service]\nWorkingDirectory={wd}\n{env}\nExecStart=/usr/bin/python3 -m bot\n"


class InlineSecretTest(RepoTestCase):
    def test_inline_key_is_an_error(self):
        self.repo.write("deploy/bot.service", UNIT.format(wd="/opt/bot", env="Environment=OPENAI_API_KEY=whatever"))
        findings = self.repo.findings(["deploy"])
        self.assertEqual([(f.rule_id, f.line) for f in findings], [("deploy.systemd-inline-secret", 6)])
        self.assertIn("OPENAI_API_KEY", findings[0].message)

    def test_quoted_multi_assignment_and_dropin(self):
        self.repo.write("deploy/bot.service.d/override.conf",
                        '[Service]\nEnvironment="LOG_LEVEL=info" "BOT_TOKEN=abc"\n')
        self.assertEqual([f.line for f in self.repo.findings(["deploy"])], [2])

    def test_environment_file_and_harmless_vars_are_fine(self):
        env = "EnvironmentFile=/etc/bot/env\nEnvironment=LOG_LEVEL=info PYTHONUNBUFFERED=1"
        self.repo.write("deploy/bot.service", UNIT.format(wd="/opt/bot", env=env))
        self.assertEqual(self.repo.ids(["deploy"]), [])


class WorkdirTest(RepoTestCase):
    """--runtime: inspects installed units (here: a temp unit dir) and their checkouts."""

    def setUp(self):
        super().setUp()
        self.prod = Repo()
        self.addCleanup(self.prod.cleanup)
        self.prod.write("app.py", "print(1)\n")
        self.prod.commit()
        self.units = Path(tempfile.mkdtemp(prefix="aura-check-units-"))
        (self.units / "bot.service").write_text(UNIT.format(wd=self.prod.root, env=""))

    def run_runtime(self):
        return self.repo.findings(["deploy"], runtime=True, unit_dirs=[self.units])

    def test_clean_main_is_fine(self):
        self.assertEqual(self.run_runtime(), [])

    def test_feature_branch_and_dirty_tree_warn(self):
        self.prod.git("checkout", "-q", "-b", "feat/x")
        self.prod.write("app.py", "print(2)\n")
        findings = self.run_runtime()
        self.assertEqual([f.rule_id for f in findings], ["deploy.workdir-not-clean-main"])
        self.assertIn("branch 'feat/x'", findings[0].message)
        self.assertIn("1 modified tracked file", findings[0].message)

    def test_not_run_without_runtime_flag(self):
        self.prod.git("checkout", "-q", "-b", "feat/x")
        self.assertEqual(self.repo.findings(["deploy"], unit_dirs=[self.units]), [])
