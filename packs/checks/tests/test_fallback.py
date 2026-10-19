"""fallback pack: switching model/provider inside an error handler without logging."""
from tests.helpers import RepoTestCase

PY = '''def ask(prompt):
    try:
        return client.create(model=MODEL, prompt=prompt)
    except BadRequestError:
{body}
        return client.create(model=model, prompt=prompt)
'''
JS = '''async function ask(p) {
  try {
    return await call(p);
  } catch (err) {
    provider = "openrouter";
    return await call(p);
  }
}
'''


class SilentFallbackTest(RepoTestCase):
    def test_python_silent_switch_warns(self):
        self.repo.write("bot/ai.py", PY.format(body='        model = "gpt-4o-mini"'))
        findings = self.repo.findings(["fallback"])
        self.assertEqual([(f.rule_id, f.line) for f in findings], [("fallback.silent-model-fallback", 5)])

    def test_python_logged_switch_is_fine(self):
        body = '        logger.warning("model %s failed, falling back", MODEL)\n        model = "gpt-4o-mini"'
        self.repo.write("bot/ai.py", PY.format(body=body))
        self.assertEqual(self.repo.ids(["fallback"]), [])

    def test_js_silent_switch_warns(self):
        self.repo.write("src/ai.js", JS)
        self.assertEqual([f.line for f in self.repo.findings(["fallback"])], [5])

    def test_js_console_warn_is_fine(self):
        self.repo.write("src/ai.js", JS.replace('provider = "openrouter";',
                                                'console.warn("fallback", err);\n    provider = "openrouter";'))
        self.assertEqual(self.repo.ids(["fallback"]), [])

    def test_handler_without_switch_is_fine(self):
        self.repo.write("bot/ai.py", PY.format(body="        raise"))
        self.assertEqual(self.repo.ids(["fallback"]), [])
