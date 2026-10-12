"""pii pack: phones and birth dates near names in added lines and commit messages (warn)."""
import unittest

from aura_check.rules.pii import pii_in_line
from tests.helpers import RepoTestCase, phone_ru


class PiiLineTest(unittest.TestCase):
    def test_positive_fixtures(self):
        # Synthetic people; the shape mirrors the Co-Pilot seed file.
        for line in (
            f"contact: {phone_ru()}",
            "call 8 (912) 345-67-89 tomorrow",  # aura-check: ignore[pii.personal-data]
            "Ivan Petrov, born 12.03.2015",  # aura-check: ignore[pii.personal-data]
            "{'name': 'Masha', 'birthdate': date(2016, 4, 1)}",  # aura-check: ignore[pii.personal-data]
            "Anna Smirnova 2014-05-17",  # aura-check: ignore[pii.personal-data]
        ):
            with self.subTest(line=line):
                self.assertTrue(list(pii_in_line(line)))

    def test_negative_fixtures(self):
        for line in (
            "## 2026-10-12 Jane Doe released v2",   # changelog line: recent date, no keyword
            "order id 89123456789012",              # long id, not a phone
            "timeout = 30000",
            "created_at = date(2024, 1, 1)",        # date without a name
            "Version 1.2.3 (build 20240101)",
        ):
            with self.subTest(line=line):
                self.assertEqual(list(pii_in_line(line)), [])


class PiiRuleTest(RepoTestCase):
    def test_added_lines_and_commit_message_warn(self):
        self.repo.commit()
        self.repo.write("seed.py", "KIDS = [('Ivan Petrov', '12.03.2015')]  # birth dates\n")  # aura-check: ignore[pii.personal-data]
        self.repo.add()
        msg = self.repo.write("MSG", f"feat: seed\n\nparent phone {phone_ru()}\n")
        rc, out, _ = self.repo.cli("--changed", "--commit-msg-file", str(msg), "--pack", "pii")
        self.assertEqual(rc, 0, "pii is warn-level: does not fail the commit")
        self.assertIn("seed.py:1", out)
        self.assertIn("commit-message:new:3", out)
        rc, _, _ = self.repo.cli("--changed", "--commit-msg-file", str(msg), "--pack", "pii", "--strict")
        self.assertEqual(rc, 1)

    def test_full_scan_does_not_report_old_files(self):
        # Diff/commit-message scoped by design: old fixtures don't fire forever.
        self.repo.write("seed.py", "KIDS = [('Ivan Petrov', '12.03.2015')]  # birth dates\n")  # aura-check: ignore[pii.personal-data]
        self.repo.commit()
        self.assertEqual(self.repo.ids(["pii"]), [])
