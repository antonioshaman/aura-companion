"""--baseline: a strict, reviewed list of accepted findings.

Contract (Task 14): an unbaselined finding still fails the run, a baseline
entry that no longer fires fails the run (so fixed debt cannot keep a stale
pass), and every entry records a human ruling. A false positive is never a
valid ruling: noisy rules are fixed or dropped, not baselined.
"""
import json

from tests.helpers import RepoTestCase

ALERT = "export function save() {\n  alert('Saved');\n}\n"


def entry(**over):
    e = {"rule": "uiux.native-alert", "path": "web/src/Form.tsx", "match": "alert('Saved'); | }",
         "count": 1, "ruling": "true-problem", "action": "fix-later",
         "reason": "Real blocking dialog; replace with an inline message.",
         "ruledBy": "owner", "ruledAt": "2026-10-28"}
    e.update(over)
    return e


class BaselineTest(RepoTestCase):
    def setUp(self):
        super().setUp()
        self.repo.write("web/src/Form.tsx", ALERT)

    def write_baseline(self, *entries):
        self.repo.write(".aura-check-baseline.json", json.dumps({"entries": list(entries)}))

    def run_cli(self, *extra):
        self.repo.add()  # full scans see tracked files only
        return self.repo.cli("--pack", "uiux", "--strict", "--baseline", ".aura-check-baseline.json", *extra)

    def test_without_baseline_the_finding_fails_strict(self):
        self.repo.add()
        self.assertEqual(self.repo.cli("--pack", "uiux", "--strict")[0], 1)

    def test_baselined_finding_passes_and_is_counted(self):
        self.write_baseline(entry())
        rc, out, err = self.run_cli()
        self.assertEqual(rc, 0, out + err)
        self.assertIn("1 finding(s) accepted by the baseline", out)

    def test_new_finding_next_to_a_baselined_one_fails(self):
        # Same file, same text: the count, not the path, decides.
        self.write_baseline(entry())
        self.repo.write("web/src/Form.tsx", ALERT + "export function again() {\n  alert('Saved');\n}\n")
        rc, out, _ = self.run_cli()
        self.assertEqual(rc, 1)
        self.assertIn("uiux.native-alert  web/src/Form.tsx:5", out)

    def test_stale_entry_fails_after_the_defect_is_fixed(self):
        self.write_baseline(entry(), entry(path="web/src/Gone.tsx"))
        rc, out, _ = self.run_cli()
        self.assertEqual(rc, 1)
        self.assertIn("STALE baseline entry", out)
        self.assertIn("web/src/Gone.tsx", out)

    def test_stale_check_is_skipped_in_changed_mode(self):
        # --changed sees only touched files, so absence proves nothing there.
        self.write_baseline(entry(), entry(path="web/src/Gone.tsx"))
        self.repo.commit()
        self.repo.write("web/src/Other.tsx", "export const x = 1;\n")
        self.repo.add("web/src/Other.tsx")
        rc, out, _ = self.run_cli("--changed")
        self.assertEqual(rc, 0, out)

    def test_entries_of_unselected_packs_are_not_stale(self):
        self.write_baseline(entry(), entry(rule="secrets.in-file", path="x.py", match="X"))
        self.assertEqual(self.run_cli()[0], 0)

    def test_every_entry_needs_a_human_ruling(self):
        for bad in (entry(ruling="false-positive"), entry(action="maybe"), entry(reason=""),
                    entry(ruledBy=""), entry(ruledAt="yesterday"), entry(count=0),
                    {k: v for k, v in entry().items() if k != "match"}):
            self.write_baseline(bad)
            rc, _, err = self.run_cli()
            self.assertEqual(rc, 2, bad)
            self.assertIn("invalid baseline", err)

    def test_missing_or_broken_baseline_file_is_a_usage_error(self):
        self.assertEqual(self.repo.cli("--pack", "uiux", "--baseline", "nope.json")[0], 2)
        self.repo.write(".aura-check-baseline.json", "{not json")
        self.assertEqual(self.run_cli()[0], 2)

    def test_json_format_lists_stale_entries(self):
        self.write_baseline(entry(path="web/src/Gone.tsx"))
        rc, out, _ = self.run_cli("--format", "json")
        self.assertEqual(rc, 1)
        data = json.loads(out)
        self.assertEqual([d["rule_id"] for d in data], ["baseline.stale-entry", "uiux.native-alert"])
