"""telegram-miniapp pack: unversioned Mini App URLs and aiogram state handlers swallowing commands."""
from tests.helpers import RepoTestCase

STATES = "from aiogram.fsm.state import State, StatesGroup\n\nclass Form(StatesGroup):\n    name = State()\n"


class MiniAppUrlTest(RepoTestCase):
    def test_unversioned_url_warns(self):
        self.repo.write("bot/kb.py", 'btn = WebAppInfo(url="https://app.example.org/shop/")\n')
        findings = self.repo.findings(["telegram-miniapp"])
        self.assertEqual([(f.rule_id, f.line) for f in findings], [("telegram.miniapp-url-unversioned", 1)])

    def test_versioned_and_templated_urls_are_fine(self):
        self.repo.write("bot/kb.py",
                        'a = WebAppInfo(url="https://app.example.org/?v=5d1c2e7")\n'
                        'b = WebAppInfo(url="https://app.example.org/app/5d1c2e7/")\n'
                        'c = WebAppInfo(url=f"https://app.example.org/?v={BUILD}")\n'
                        'd = "https://t.me/some_bot/app"  # webapp deep link\n')
        self.assertEqual(self.repo.ids(["telegram-miniapp"]), [])

    def test_env_var_for_menu_button(self):
        self.repo.write("deploy/bot.env", "MINI_APP_URL=https://app.example.org/\n")
        self.assertEqual(self.repo.ids(["telegram-miniapp"]), ["telegram.miniapp-url-unversioned"])


class FsmSwallowsCommandsTest(RepoTestCase):
    def test_state_handler_without_command_filter_warns(self):
        self.repo.write("bot/states.py", STATES)
        self.repo.write("bot/handlers.py",
                        "from aiogram import Router\nrouter = Router()\n\n"
                        "@router.message(Form.name)\nasync def got_name(m):\n    pass\n")
        findings = self.repo.findings(["telegram-miniapp"])
        self.assertEqual([(f.rule_id, f.path, f.line) for f in findings],
                         [("telegram.fsm-swallows-commands", "bot/handlers.py", 4)])

    def test_command_exclusion_or_content_filter_is_fine(self):
        self.repo.write("bot/states.py", STATES)
        self.repo.write("bot/handlers.py",
                        "from aiogram import F, Router\nrouter = Router()\n\n"
                        "@router.message(Form.name, ~F.text.startswith('/'))\nasync def a(m): pass\n\n"
                        "@router.message(Form.name, F.photo)\nasync def b(m): pass\n")
        self.assertEqual(self.repo.ids(["telegram-miniapp"]), [])

    def test_catch_all_command_registered_first_is_fine(self):
        self.repo.write("bot/states.py", STATES)
        self.repo.write("bot/handlers.py",
                        "from aiogram import Router\nrouter = Router()\n\n"
                        "@router.message(CommandStart(), StateFilter('*'))\nasync def start(m): pass\n\n"
                        "@router.message(Form.name)\nasync def got_name(m): pass\n")
        self.assertEqual(self.repo.ids(["telegram-miniapp"]), [])
