"""llm-output pack: raw LLM text returned on JSON parse failure + the publish guard snippets."""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from tests.helpers import RepoTestCase

SNIPPETS = Path(__file__).resolve().parent.parent / "snippets"
sys.path.insert(0, str(SNIPPETS))
import publish_guard  # noqa: E402

PY_BAD = '''from openai import OpenAI

def parse_reply(body):
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return {"reply": body.strip()}
    return data
'''
PY_GOOD = PY_BAD.replace('return {"reply": body.strip()}', 'log.warning("bad json")\n        return None')
TS_BAD = '''import Anthropic from "@anthropic-ai/sdk";
export function parse(text: string) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}
'''


class RawOnParseFailureTest(RepoTestCase):
    def test_python_raw_body_in_envelope_warns(self):
        # The auraengine 2eb2bf0 shape: wrap the unparsed body and carry on.
        self.repo.write("bot/llm.py", PY_BAD)
        findings = self.repo.findings(["llm-output"])
        self.assertEqual([(f.rule_id, f.line) for f in findings], [("llm-output.raw-on-parse-failure", 7)])

    def test_typescript_return_raw_warns(self):
        self.repo.write("src/llm.ts", TS_BAD)
        self.assertEqual([f.line for f in self.repo.findings(["llm-output"])], [6])

    def test_returning_none_is_fine(self):
        self.repo.write("bot/llm.py", PY_GOOD)
        self.assertEqual(self.repo.ids(["llm-output"]), [])

    def test_non_llm_file_and_test_files_are_ignored(self):
        self.repo.write("app/config.py", PY_BAD.replace("from openai import OpenAI", "import os"))
        self.repo.write("tests/test_llm.py", PY_BAD)
        self.assertEqual(self.repo.ids(["llm-output"]), [])


class PublishGuardPythonTest(unittest.TestCase):
    def test_rejects_non_final_text(self):
        for text in ('{"reply": "hi"}', "[1, 2]", "```json\n{}\n```", '{"reply": "unterminated',
                     "Sure! <thinking>plan</thinking> hi", 'Answer: "soft": "x"', "", None):
            with self.subTest(text=text):
                self.assertIsNotNone(publish_guard.publish_problem(text))
                with self.assertRaises(publish_guard.UnpublishableText):
                    publish_guard.assert_publishable(text)

    def test_accepts_plain_reply(self):
        self.assertEqual(publish_guard.assert_publishable("  Thanks, see you {soon}!  "), "Thanks, see you {soon}!")


@unittest.skipUnless(shutil.which("bun"), "bun not installed")
class PublishGuardTypeScriptTest(unittest.TestCase):
    """The TS snippet must agree with the Python one on the same inputs."""

    def test_parity_with_python(self):
        cases = ['{"reply": "hi"}', "```\nx\n```", "<analysis>x</analysis>", 'x "hard": 1', "", "Plain answer."]
        script = (f"import {{ publishProblem }} from {json.dumps(str(SNIPPETS / 'publishGuard.ts'))};\n"
                  f"console.log(JSON.stringify({json.dumps(cases)}.map((c) => publishProblem(c))));")
        out = subprocess.run(["bun", "-e", script], capture_output=True, text=True, check=True).stdout
        ts = json.loads(out)
        py = [publish_guard.publish_problem(c) for c in cases]
        self.assertEqual([t is None for t in ts], [p is None for p in py])
        self.assertIsNone(ts[-1])
