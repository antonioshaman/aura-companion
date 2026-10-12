"""secrets pack: tokens/keys in tracked files and commit messages (error level)."""
import unittest

from aura_check.rules.secrets import find_secrets
from tests.helpers import (RepoTestCase, fake_bot_token, fake_gonka, fake_npm, fake_openai,
                           fake_private_key_header, rand)


class FindSecretsTest(unittest.TestCase):
    """Pattern level: each token family from the task brief is recognised."""

    def test_each_token_family_is_detected(self):
        cases = {
            "npm token": f"//registry.npmjs.org/:_authToken={fake_npm()}",
            "Gonka key": f"GONKA = '{fake_gonka()}'",
            "OpenAI/Anthropic-style key": f"client = OpenAI(api_key='{fake_openai()}')",
            "Telegram bot token": f"bot = Bot('{fake_bot_token()}')",
            "private key block": fake_private_key_header(),
        }
        for label, line in cases.items():
            with self.subTest(label=label):
                self.assertIn(label, [l for l, _ in find_secrets(line)])

    def test_key_assignment_with_high_entropy_value(self):
        # KEY=<random> is caught even without a known prefix.
        hits = list(find_secrets(f"PAYMENT_SECRET_KEY={rand(32, 9)}"))
        self.assertEqual(len(hits), 1)
        self.assertIn("PAYMENT_SECRET_KEY", hits[0][0])

    def test_placeholders_env_lookups_and_fake_values_are_quiet(self):
        # Negative fixtures: docs/examples must not fail the build.
        for line in (
            "OPENAI_API_KEY=your-api-key-here",
            "API_KEY = os.environ['API_KEY']",
            "token = process.env.BOT_TOKEN",
            "SECRET_KEY=changeme",
            "client = OpenAI(api_key='sk-test-not-a-real-key-at-all')",
            "TOKEN_TTL_SECONDS=3600",
            "MAX_TOKENS=4096",
        ):
            with self.subTest(line=line):
                self.assertEqual(list(find_secrets(line)), [])


class SecretRuleTest(RepoTestCase):
    def test_tracked_file_with_secret_is_an_error_and_secret_is_masked(self):
        token = fake_openai()
        self.repo.write("app/config.py", f"OPENAI = '{token}'\n")
        self.repo.commit()
        rc, out, _ = self.repo.cli("--pack", "secrets")
        self.assertEqual(rc, 1)
        self.assertIn("secrets.in-file", out)
        self.assertIn("app/config.py:1", out)
        # Never print the secret itself.
        self.assertNotIn(token, out)

    def test_inline_ignore_comment_suppresses(self):
        self.repo.write("app/config.py", f"OPENAI = '{fake_openai()}'  # aura-check: ignore[secrets.in-file]\n")
        self.repo.commit()
        self.assertEqual(self.repo.ids(["secrets"]), [])

    def test_changed_mode_only_scans_added_lines(self):
        # Pre-existing debt in a touched file is not re-reported on every commit...
        self.repo.write("app/config.py", f"OPENAI = '{fake_openai()}'\n")
        self.repo.commit()
        self.repo.write("app/config.py", f"OPENAI = '{fake_openai()}'\nDEBUG = True\n")
        self.repo.add("app/config.py")
        self.assertEqual(self.repo.ids(["secrets"], changed=True), [])
        # ...but a newly added secret is.
        self.repo.write("app/other.py", f"NPM = '{fake_npm()}'\n")
        self.repo.add("app/other.py")
        self.assertEqual(self.repo.ids(["secrets"], changed=True), ["secrets.in-file"])

    def test_commit_message_file(self):
        msg = self.repo.write("MSG", f"fix: rotate key\n\nold value {fake_gonka()}\n# comment line\n")
        rc, out, _ = self.repo.cli("--commit-msg-file", str(msg), "--pack", "secrets")
        self.assertEqual(rc, 1)
        self.assertIn("secrets.in-commit-message", out)
        self.assertIn("commit-message:new:3", out)

    def test_commit_messages_in_ci_range(self):
        # CI mode (--changed --base) reads every commit message of base..HEAD.
        self.repo.commit("chore: base")
        self.repo.git("branch", "base")
        self.repo.write("README.md", "hi\n")
        self.repo.commit(f"feat: deploy\n\nused {fake_bot_token()}")
        rc, out, _ = self.repo.cli("--changed", "--base", "base", "--pack", "secrets")
        self.assertEqual(rc, 1)
        self.assertIn("secrets.in-commit-message", out)
