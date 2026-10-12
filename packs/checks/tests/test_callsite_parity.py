"""call-site-parity pack: a guard added before one call of a function, others left unguarded."""
from tests.helpers import RepoTestCase

BILLING = "def charge(user):\n    pass\n"
BOT = "def on_pay(user):\n    charge(user)\n"
SITE = "def checkout(user):\n    charge(user)\n"


class GuardParityTest(RepoTestCase):
    def setUp(self):
        super().setUp()
        self.repo.write("app/bot.py", BOT)
        self.repo.write("app/site.py", SITE)
        self.repo.write("app/billing.py", BILLING)
        self.repo.commit()

    def test_guard_added_at_one_site_warns_with_other_site(self):
        self.repo.write("app/bot.py",
                        "def on_pay(user):\n    if not user.is_verified():\n        return\n    charge(user)\n")
        self.repo.add()
        findings = self.repo.findings(["call-site-parity"], changed=True)
        self.assertEqual([(f.rule_id, f.path, f.line) for f in findings],
                         [("call-site-parity.guard-missing", "app/bot.py", 2)])
        self.assertIn("app/site.py:2", findings[0].message)

    def test_guard_added_everywhere_is_fine(self):
        guarded = "    if not user.is_verified():\n        return\n    charge(user)\n"
        self.repo.write("app/bot.py", "def on_pay(user):\n" + guarded)
        self.repo.write("app/site.py", "def checkout(user):\n" + guarded)
        self.repo.add()
        self.assertEqual(self.repo.ids(["call-site-parity"], changed=True), [])

    def test_guard_before_non_project_function_is_fine(self):
        # `print`/stdlib/library calls are not a contract the project owns.
        self.repo.write("app/bot.py", "def on_pay(user):\n    charge(user)\n    log_it(user)\n")
        self.repo.write("app/site.py", SITE + "    log_it(user)\n")
        self.repo.commit()
        self.repo.write("app/bot.py",
                        "def on_pay(user):\n    charge(user)\n    if user.is_verified():\n        log_it(user)\n")
        self.repo.add()
        self.assertEqual(self.repo.ids(["call-site-parity"], changed=True), [])

    def test_guard_with_new_call_or_in_new_file_is_fine(self):
        # Only a guard put in front of an *existing* call is the lesson's shape;
        # brand-new code would otherwise flag every `if` it adds.
        self.repo.write("app/bot.py", BOT + "\ndef refund(user):\n    if user.is_verified():\n        charge(user)\n")
        self.repo.write("app/new.py", "def x(user):\n    if user.is_verified():\n        charge(user)\n")
        self.repo.add()
        self.assertEqual(self.repo.ids(["call-site-parity"], changed=True), [])

    def test_generic_helper_with_many_call_sites_is_skipped(self):
        # A guard in front of one of many calls to a widely used helper is
        # site-specific, not a shared contract (keeps real-history noise down).
        for i in range(11):
            self.repo.write(f"app/m{i}.py", f"def f{i}(user):\n    charge(user)\n")
        self.repo.commit()
        self.repo.write("app/bot.py",
                        "def on_pay(user):\n    if not user.is_verified():\n        return\n    charge(user)\n")
        self.repo.add()
        self.assertEqual(self.repo.ids(["call-site-parity"], changed=True), [])

    def test_full_scan_mode_does_not_run(self):
        # Parity is a property of a change; nothing to compare in a full scan.
        self.repo.write("app/bot.py",
                        "def on_pay(user):\n    if not user.is_verified():\n        return\n    charge(user)\n")
        self.repo.commit()
        self.assertEqual(self.repo.ids(["call-site-parity"]), [])
