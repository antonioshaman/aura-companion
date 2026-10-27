"""Tests for the guards pack (packs/guards/guards.py + install.sh).

Run: python3 -m unittest discover -s packs/guards/tests -v

What is validated:
- PreToolUse: every rule fires (deny/ask/warn) on the real-incident command shapes, and does
  NOT fire on look-alikes (false-positive guards: `grep pkill`, SQL in a heredoc written to a
  file, `kill <PID>`, pytest against a *_test DB, ...).
- PostToolUse: deploy-like commands get a "verify the live system" reminder, unless the same
  command already verifies after deploying.
- Stop: "done needs proof" blocks exactly once (stop_hook_active), only when the turn deployed,
  claims done, and ran no verification after the last deploy. Uses synthetic transcripts in
  Claude Code's JSONL shape.
- install.sh: dry-run writes nothing, --apply is idempotent and keeps foreign hooks, backup is
  made, --uninstall removes only our entries.
- The hooks fail open: garbage stdin -> exit 0, no output.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)
sys.path.insert(0, PACK)

import guards  # noqa: E402

GUARDS_PY = os.path.join(PACK, "guards.py")
INSTALL_SH = os.path.join(PACK, "install.sh")


def decision_for(cmd, cwd=None, process_env=None, disabled=()):
    """Return (decision, rules, text) where decision in allow/ask/deny/warn."""
    cwd = cwd if cwd is not None else tempfile.gettempdir() + "/guards-empty-cwd"
    findings = guards.Analyzer(cwd, process_env=process_env or {}).analyze(cmd)
    out = guards.decide(findings, set(disabled))
    if not out:
        return "allow", set(), ""
    hso = out["hookSpecificOutput"]
    rules = {f.rule for f in findings if f.rule not in disabled}
    if "permissionDecision" in hso:
        return hso["permissionDecision"], rules, hso["permissionDecisionReason"]
    return "warn", rules, hso["additionalContext"]


class PreToolUseTable(unittest.TestCase):
    # (command, expected decision, rule expected to fire or None)
    CASES = [
        # --- pkill / killall: deny; matches by name/cmdline killed prod on a shared box
        ("pkill -f 'bun server/index.ts'", "deny", "pkill"),
        ("pkill node", "deny", "pkill"),
        ("sudo killall python3", "deny", "pkill"),
        ("cd /srv && pkill -9 -f uvicorn", "deny", "pkill"),
        ("kill $(pgrep -f 'bun server')", "deny", "pkill"),
        ("pgrep -f vite | xargs kill", "deny", "pkill"),
        ("bash -c 'pkill -f worker'", "deny", "pkill"),
        ("ssh prod 'pkill -f gunicorn'", "deny", "pkill"),
        ("grep pkill notes.md", "allow", None),            # FP guard: word in an argument
        ("kill 12345", "allow", None),                      # FP guard: explicit PID is the advice
        ("kill -TERM 12345 12346", "allow", None),
        ("pgrep -af 'bun server'", "allow", None),          # FP guard: looking is fine
        ("echo 'never use pkill -f'", "allow", None),
        ("git commit -m 'docs: explain why pkill is banned'", "allow", None),
        ("git commit -F - <<'EOF'\nfix: never pkill -f; rm -rf /\nEOF", "allow", None),  # heredoc to git
        ("gh pr create --body \"$(cat <<'EOF'\nrm -rf / and DROP TABLE x\nEOF\n)\"", "allow", None),
        # --- force push
        ("git push --force origin main", "ask", "force-push"),
        ("git push -f", "ask", "force-push"),
        ("git push origin +main", "ask", "force-push"),
        ("git push --force-with-lease origin feat/x", "ask", "force-push"),
        ("git -C /repo push -uf origin x", "ask", "force-push"),
        ("git push origin --delete old-branch", "ask", "force-push"),
        ("git push -u origin feat/guard-hooks-pack", "allow", None),
        ("git push", "allow", None),
        # --- reset --hard / clean -f
        ("git reset --hard origin/main", "ask", "git-reset-hard"),
        ("git clean -fdx", "ask", "git-reset-hard"),
        ("git clean -n", "allow", None),
        ("git reset --soft HEAD~1", "allow", None),
        # --- rm -rf
        ("rm -rf /", "ask", "rm-rf"),
        ("rm -rf ~/projects", "ask", "rm-rf"),
        ("rm -rf $HOME/x", "ask", "rm-rf"),
        ("rm -rf ../other-repo", "ask", "rm-rf"),
        ("rm -rf src", "ask", "rm-rf"),
        ("rm -fr /var/lib/postgresql", "ask", "rm-rf"),
        ("rm --recursive --force data", "ask", "rm-rf"),
        ("rm -rf /tmp", "ask", "rm-rf"),                   # /tmp itself is not "under /tmp"
        ("rm -rf /tmp/../etc", "ask", "rm-rf"),            # normalised path escapes /tmp
        ("find . -name '*.pyc' | xargs rm -rf", "ask", "rm-rf"),  # unknown targets
        ("rm -rf /tmp/build-123", "allow", None),
        ("rm -rf \"$TMPDIR/scratch\"", "allow", None),
        ("rm -rf node_modules dist .next coverage", "allow", None),
        ("rm -rf ./build web/node_modules/.vite", "ask", "rm-rf"),  # web/... is not a build dir root
        ("rm -rf ./build", "allow", None),
        ("rm -rf pkg.egg-info __pycache__", "allow", None),
        ("rm -r src", "allow", None),                       # spec: only rm -rf
        ("rm file.txt", "allow", None),
        # --- destructive SQL through DB clients
        ("psql $DATABASE_URL -c 'DROP TABLE users'", "ask", "sql-destructive"),
        ("psql -c 'truncate ledger'", "ask", "sql-destructive"),
        ("sqlite3 app.db 'DELETE FROM users'", "ask", "sql-destructive"),
        ("sqlite3 app.db 'UPDATE users SET balance=0'", "ask", "sql-destructive"),
        ("echo 'DROP TABLE x;' | psql mydb", "ask", "sql-destructive"),
        ("psql mydb <<'SQL'\nBEGIN;\nDELETE FROM payments;\nCOMMIT;\nSQL", "ask", "sql-destructive"),
        ("sudo -u postgres psql -c 'DROP DATABASE prod'", "ask", "sql-destructive"),
        ("docker exec -i db psql -U app -c 'TRUNCATE users'", "ask", "sql-destructive"),
        ("ssh prod \"psql -c 'DROP TABLE users'\"", "ask", "sql-destructive"),
        ("dropdb prod", "ask", "sql-destructive"),
        ("psql -c 'DELETE FROM users WHERE id = 5'", "allow", None),
        ("psql -c 'SELECT count(*) FROM users'", "allow", None),
        ("echo \"DROP TABLE users\"", "allow", None),       # FP guard: not sent to a DB
        ("cat > migration.sql <<'EOF'\nDROP TABLE legacy;\nEOF", "allow", None),  # heredoc to a file
        ("grep -rn 'DELETE FROM' src/", "allow", None),
        # --- alembic downgrade
        ("alembic downgrade -1", "ask", "alembic-downgrade"),
        ("uv run alembic -c alembic.ini downgrade base", "ask", "alembic-downgrade"),
        ("alembic history", "allow", None),
        # --- service restart / stop (hostname shown)
        ("sudo systemctl restart aura-companion", "ask", "service-restart"),
        ("systemctl --user stop api.service", "ask", "service-restart"),
        ("service nginx restart", "ask", "service-restart"),
        ("ssh root@prod 'systemctl restart bot'", "ask", "service-restart"),
        ("systemctl status aura-companion", "allow", None),
        ("journalctl -u aura-companion -n 50", "allow", None),
        # --- secret rotation (hostname shown)
        ("./scripts/rotate_token.sh", "ask", "secret-rotation"),
        ("python3 rotate-secrets.py --env prod", "ask", "secret-rotation"),
        ("gh secret set BOT_TOKEN < token.txt", "ask", "secret-rotation"),
        ("aws secretsmanager rotate-secret --secret-id x", "ask", "secret-rotation"),
        ("fly secrets set API_KEY=x", "ask", "secret-rotation"),
        ("grep -rn rotate_token scripts/", "allow", None),  # FP guard
        ("git log --grep 'rotate token'", "allow", None),
        ("logrotate -f /etc/logrotate.conf", "allow", None),
        # --- alembic upgrade over ssh without env: warn only
        ("ssh prod 'cd /srv/app && alembic upgrade head'", "warn", "alembic-ssh-env"),
        ("ssh prod <<'EOF'\ncd /srv/app\nalembic upgrade head\nEOF", "warn", "alembic-ssh-env"),
        ("ssh prod 'cd /srv/app && set -a && . ./.env && set +a && alembic upgrade head'", "allow", None),
        ("ssh prod 'docker compose exec api alembic upgrade head'", "allow", None),
        ("ssh prod 'cd /srv/app && DATABASE_URL=postgresql://h/prod alembic upgrade head'", "allow", None),
        # --- plain safe commands
        ("ls -la", "allow", None),
        ("bun run test", "allow", None),
        ("", "allow", None),
        ("echo 'unbalanced", "allow", None),               # tokenizer fallback must not crash
    ]

    def test_table(self):
        for cmd, want, rule in self.CASES:
            with self.subTest(cmd=cmd):
                got, rules, text = decision_for(cmd)
                self.assertEqual(got, want, f"{cmd!r} -> {got} ({rules}): {text[:200]}")
                if rule:
                    self.assertIn(rule, rules)

    def test_hostname_in_restart_and_rotation_reasons(self):
        # The agent must see WHERE it is before a restart/rotation (warehouse: wrong host, 10 h outage).
        host = socket.gethostname()
        for cmd in ("systemctl restart api", "./rotate_token.sh"):
            _, _, text = decision_for(cmd)
            self.assertIn(host, text)
        _, _, text = decision_for("ssh prod-db 'systemctl restart api'")
        self.assertIn("prod-db", text)
        self.assertIn(host, text)

    def test_restart_reason_mentions_self_kill(self):
        # Restarting the server that hosts the agent killed the agent's own command (exit 137).
        _, _, text = decision_for("systemctl restart aura-companion")
        self.assertIn("137", text)

    def test_deny_wins_over_ask_and_all_reasons_shown(self):
        got, rules, text = decision_for("git reset --hard && pkill -f bun")
        self.assertEqual(got, "deny")
        self.assertEqual(rules, {"git-reset-hard", "pkill"})
        self.assertIn("git reset --hard", text)

    def test_disable_rule(self):
        got, _, _ = decision_for("pkill -f bun", disabled=("pkill",))
        self.assertEqual(got, "allow")
        got, _, _ = decision_for("pkill -f bun && git push -f", disabled=("pkill",))
        self.assertEqual(got, "ask")
        self.assertEqual(guards.decide([guards.Finding("pkill", "deny", "x")], {"all"}), None)


class TestDbRule(unittest.TestCase):
    """pytest/alembic against a DB whose name has no test marker -> ask (aurasoul 2026-06-15)."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="guards-testdb-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name, text):
        with open(os.path.join(self.dir, name), "w") as fh:
            fh.write(text)

    def test_inline_env(self):
        cases = [
            ("DATABASE_URL=postgresql://u:secretpw@db:5432/aurasoul pytest -q", "ask"),
            ("DATABASE_URL=postgresql://u:pw@db/aurasoul_test pytest -q", "allow"),
            ("DATABASE_URL=postgresql://u:pw@db/test_aurasoul python -m pytest", "allow"),
            ("DB_DSN='dbname=ledger host=10.0.0.5' uv run pytest", "ask"),
            ("DATABASE_URL=sqlite:///:memory: pytest", "allow"),
            ("DATABASE_URL=sqlite:///./app.db alembic upgrade head", "ask"),
            ("export DATABASE_URL=postgresql://h/prod && pytest", "ask"),
            ("PGDATABASE=latest_orders pytest", "ask"),       # 'latest' is not a test marker
            ("DATABASE_URL=postgresql://h/prod ls", "allow"),  # not a test/migration command
        ]
        for cmd, want in cases:
            with self.subTest(cmd=cmd):
                got, _, text = decision_for(cmd, cwd=self.dir)
                self.assertEqual(got, want, text)
                # Never echo credentials in the reason.
                self.assertNotIn("secretpw", text)

    def test_dotenv(self):
        self.write(".env", "# prod\nexport DATABASE_URL=postgresql://app:pw@10.0.0.5:5432/warehouse\n")
        got, _, text = decision_for("pytest tests/", cwd=self.dir)
        self.assertEqual(got, "ask")
        self.assertIn("warehouse", text)
        self.assertIn(".env", text)
        # Inline override with a test DB beats .env (precedence: command > config > .env).
        got, _, _ = decision_for("DATABASE_URL=postgresql://h/warehouse_test pytest", cwd=self.dir)
        self.assertEqual(got, "allow")
        # A sibling TEST_DATABASE_URL in .env means the project has a test DB wired.
        self.write(".env", "DATABASE_URL=postgresql://h/warehouse\nTEST_DATABASE_URL=postgresql://h/warehouse_test\n")
        got, _, _ = decision_for("pytest", cwd=self.dir)
        self.assertEqual(got, "allow")

    def test_cd_changes_dotenv_dir(self):
        sub = os.path.join(self.dir, "svc")
        os.mkdir(sub)
        with open(os.path.join(sub, ".env"), "w") as fh:
            fh.write("DATABASE_URL=postgresql://h/billing\n")
        got, _, _ = decision_for(f"cd {sub} && pytest", cwd="/")
        self.assertEqual(got, "ask")

    def test_pytest_env_config(self):
        self.write(".env", "DATABASE_URL=postgresql://h/prod\n")
        self.write("pytest.ini", "[pytest]\nenv =\n    DATABASE_URL=postgresql://h/prod_test\n")
        got, _, _ = decision_for("pytest", cwd=self.dir)
        self.assertEqual(got, "allow")

    def test_process_env(self):
        got, _, _ = decision_for("pytest", cwd=self.dir, process_env={"DATABASE_URL": "postgresql://h/main"})
        self.assertEqual(got, "ask")

    def test_no_db_config_is_allowed(self):
        got, _, _ = decision_for("pytest -q", cwd=self.dir)
        self.assertEqual(got, "allow")


class PostToolUseTable(unittest.TestCase):
    CASES = [
        ("sudo systemctl restart api", True),
        ("docker compose up -d --build", True),
        ("docker-compose up -d", True),
        ("./deploy.sh", True),
        ("bash scripts/deploy-prod.sh", True),
        ("make deploy", True),
        ("ssh prod 'cd /srv/app && git pull && sudo systemctl restart app'", True),
        ("ssh prod 'cd /srv/app && git pull'", True),     # git pull on a server
        ("fly deploy", True),
        ("systemctl restart api && sleep 2 && curl -fsS https://api.example.com/health", False),
        ("systemctl status api", False),
        ("git pull", False),                               # local git pull is not a deploy
        ("bun run test", False),
        ("grep deploy README.md", False),
    ]

    def test_table(self):
        for cmd, reminds in self.CASES:
            with self.subTest(cmd=cmd):
                out = guards.post_tool_use({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": "/"})
                if reminds:
                    self.assertIsNotNone(out)
                    self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "PostToolUse")
                    self.assertIn("LIVE", out["hookSpecificOutput"]["additionalContext"])
                else:
                    self.assertIsNone(out)

    def test_non_bash_ignored(self):
        self.assertIsNone(guards.post_tool_use({"tool_name": "Edit", "tool_input": {"command": "./deploy.sh"}}))


def _read(path):
    with open(path) as fh:
        return fh.read()


def _transcript(path, items):
    """items: list of ("user", text) | ("bash", cmd) | ("tool", name) | ("text", text) | ("result", "")."""
    with open(path, "w") as fh:
        for kind, val in items:
            if kind == "user":
                e = {"type": "user", "message": {"role": "user", "content": val}}
            elif kind == "result":
                e = {"type": "user", "message": {"role": "user",
                                                 "content": [{"type": "tool_result", "tool_use_id": "t",
                                                              "content": val}]}}
            elif kind == "bash":
                e = {"type": "assistant", "message": {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t", "name": "Bash", "input": {"command": val}}]}}
            elif kind == "tool":
                e = {"type": "assistant", "message": {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t", "name": val, "input": {}}]}}
            else:
                e = {"type": "assistant", "message": {"role": "assistant",
                                                      "content": [{"type": "text", "text": val}]}}
            fh.write(json.dumps(e) + "\n")


class StopHook(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="guards-stop-")
        self.path = os.path.join(self.dir, "t.jsonl")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_stop(self, items, active=False, last=None):
        _transcript(self.path, items)
        payload = {"hook_event_name": "Stop", "transcript_path": self.path, "stop_hook_active": active,
                   "cwd": self.dir}
        if last is not None:
            payload["last_assistant_message"] = last
        return guards.stop_hook(payload)

    def test_blocks_unverified_done_claim(self):
        out = self.run_stop([("user", "deploy it"), ("bash", "ssh prod 'git pull && systemctl restart app'"),
                             ("result", "ok"), ("text", "Deployed SUCCESS, all done.")])
        self.assertEqual(out["decision"], "block")
        self.assertIn("done-needs-proof", out["reason"])

    def test_russian_claim(self):
        out = self.run_stop([("user", "выкати"), ("bash", "./deploy.sh"), ("result", ""),
                             ("text", "Готово, задеплоено.")])
        self.assertEqual(out["decision"], "block")

    def test_stop_hook_active_prevents_loop(self):
        out = self.run_stop([("user", "deploy"), ("bash", "./deploy.sh"), ("text", "Done.")], active=True)
        self.assertIsNone(out)

    def test_verification_after_deploy_allows(self):
        for verify in ("curl -fsS https://app.example.com/health", "journalctl -u app --since -5min",
                       "systemctl status app", "docker ps"):
            with self.subTest(verify=verify):
                out = self.run_stop([("user", "deploy"), ("bash", "./deploy.sh"), ("result", ""),
                                     ("bash", verify), ("result", ""), ("text", "Deployed and verified.")])
                self.assertIsNone(out)

    def test_webfetch_counts_as_verification(self):
        out = self.run_stop([("user", "deploy"), ("bash", "./deploy.sh"), ("tool", "WebFetch"),
                             ("text", "Done.")])
        self.assertIsNone(out)

    def test_verification_before_last_deploy_does_not_count(self):
        out = self.run_stop([("user", "deploy"), ("bash", "curl https://x/health"), ("bash", "./deploy.sh"),
                             ("text", "Done.")])
        self.assertEqual(out["decision"], "block")

    def test_previous_turn_deploy_ignored(self):
        # The deploy happened in an earlier turn; this turn only answered a question.
        out = self.run_stop([("user", "deploy"), ("bash", "./deploy.sh"), ("text", "Deployed, not verified."),
                             ("user", "what is 2+2?"), ("text", "4. Done.")])
        self.assertIsNone(out)

    def test_no_deploy_no_block(self):
        out = self.run_stop([("user", "fix the test"), ("bash", "bun run test"), ("text", "Done, tests pass.")])
        self.assertIsNone(out)

    def test_honest_unverified_message_allowed(self):
        out = self.run_stop([("user", "deploy"), ("bash", "./deploy.sh"),
                             ("text", "Deployed, but NOT verified: please check https://x.")])
        self.assertIsNone(out)

    def test_no_done_claim_allowed(self):
        out = self.run_stop([("user", "deploy"), ("bash", "./deploy.sh"),
                             ("text", "The deploy script exited 1; here is the error.")])
        self.assertIsNone(out)

    def test_last_assistant_message_field_preferred(self):
        out = self.run_stop([("user", "deploy"), ("bash", "./deploy.sh"), ("text", "working...")],
                            last="Shipped to prod.")
        self.assertEqual(out["decision"], "block")

    def test_missing_transcript(self):
        out = guards.stop_hook({"transcript_path": "/nonexistent/x.jsonl", "stop_hook_active": False})
        self.assertIsNone(out)


class HookProcess(unittest.TestCase):
    """End-to-end through stdin/stdout, as Claude Code runs the hook."""

    def run_hook(self, mode, stdin, env_extra=None):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GUARDS_")}
        # Isolated HOME: the pre hook reads (and may clean) ~/.companion/guards-allow.
        env["HOME"] = tempfile.mkdtemp(prefix="guards-hookproc-home-")
        self.addCleanup(shutil.rmtree, env["HOME"], True)
        env.update(env_extra or {})
        return subprocess.run([sys.executable, GUARDS_PY, mode], input=stdin, capture_output=True, text=True,
                              env=env, timeout=30)

    def test_pre_deny_json(self):
        p = self.run_hook("pre", json.dumps({"tool_name": "Bash", "tool_input": {"command": "pkill -f x"},
                                             "cwd": "/"}))
        self.assertEqual(p.returncode, 0)
        out = json.loads(p.stdout)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_pre_allow_is_silent(self):
        p = self.run_hook("pre", json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": "/"}))
        self.assertEqual((p.returncode, p.stdout), (0, ""))

    def test_env_disable(self):
        p = self.run_hook("pre", json.dumps({"tool_name": "Bash", "tool_input": {"command": "pkill -f x"},
                                             "cwd": "/"}), {"GUARDS_DISABLE": "pkill"})
        self.assertEqual(p.stdout, "")

    def test_project_file_disable(self):
        d = tempfile.mkdtemp(prefix="guards-proj-")
        try:
            os.mkdir(os.path.join(d, ".claude"))
            with open(os.path.join(d, ".claude", "guards.json"), "w") as fh:
                json.dump({"disable": ["service-restart"]}, fh)
            p = self.run_hook("pre", json.dumps({"tool_name": "Bash",
                                                 "tool_input": {"command": "systemctl restart x"}, "cwd": d}))
            self.assertEqual(p.stdout, "")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_fail_open_on_garbage(self):
        for mode in ("pre", "post", "stop"):
            p = self.run_hook(mode, "{not json")
            self.assertEqual((p.returncode, p.stdout), (0, ""))

    def test_internal_error_fails_open(self):
        with mock.patch.object(guards, "pre_tool_use", side_effect=RuntimeError("boom")), \
                mock.patch.object(sys, "stdin") as stdin, mock.patch.object(sys, "stdout") as stdout:
            stdin.read.return_value = "{}"
            self.assertEqual(guards.main(["guards.py", "pre"]), 0)
            stdout.write.assert_not_called()


class GuidanceText(unittest.TestCase):
    """The footer of every ask/deny reason. Before 2026-10 it said "Disable with GUARDS_DISABLE=<rule>",
    which agents read as "prefix the command with GUARDS_DISABLE=<rule>" - that never worked (the hook
    evaluates the command string before it runs and reads only its own env). The footer must now steer
    the agent to the user / Allow once / .claude/guards.json and say the inline prefix does not work."""

    def test_ask_footer(self):
        _, _, text = decision_for("systemctl restart api")
        self.assertNotIn("Disable with GUARDS_DISABLE", text)
        self.assertIn("(guards decision: ask.", text)  # machine-read by web/server/guard-denial.ts
        self.assertIn("Allow once", text)
        self.assertIn('{"disable": ["service-restart"]}', text)
        self.assertIn(".claude/guards.json", text)
        self.assertIn("does NOT work", text)

    def test_deny_footer_says_no_allow_once(self):
        _, _, text = decision_for("pkill -f bun && git push -f")
        self.assertIn("(guards decision: deny.", text)
        self.assertIn("cannot be approved once", text)
        self.assertIn('"pkill"', text)  # every blocking rule is listed for the project opt-out
        self.assertIn('"force-push"', text)

    def test_reason_starts_with_rule_tag(self):
        # web/server/guard-denial.ts reads the rule id from the leading `[guards:<rule>]`.
        _, _, text = decision_for("ssh h 'systemctl restart x'")
        self.assertTrue(text.startswith("[guards:service-restart] "), text[:80])


class AllowOnce(unittest.TestCase):
    """One-shot approvals written by the Aura server (web/server/guard-denial.ts) after the user
    pressed "Allow once". Every test uses a temporary HOME - never the real ~/.companion."""

    CMD = "ssh prod 'systemctl restart auraengine-bot.service'"

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="guards-home-")
        self.cwd = tempfile.mkdtemp(prefix="guards-cwd-")
        self.env = mock.patch.dict(os.environ, {"HOME": self.home})
        self.env.start()
        self.dir = guards.allow_dir()
        os.makedirs(self.dir, mode=0o700)
        self.key = b"0123456789abcdef0123456789abcdef"
        with open(os.path.join(self.dir, guards.ALLOW_KEY_NAME), "wb") as fh:
            fh.write(self.key)

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.cwd, ignore_errors=True)

    def write_entry(self, rules=("service-restart",), command=None, cwd=None, expires_in_ms=300_000,
                    name="a.json", key=None, sig=None):
        import hashlib
        import hmac as _hmac
        import time as _time
        command = self.CMD if command is None else command
        cwd = self.cwd if cwd is None else cwd
        exp = int(_time.time() * 1000) + expires_in_ms
        sha = guards.command_sha256(command)
        nonce = "n" + name
        signing = guards.allow_signing_string(rules, sha, cwd, exp, nonce)
        entry = {"v": 1, "rule": rules[0], "rules": list(rules), "commandSha256": sha, "cwd": cwd,
                 "expiresAt": exp, "nonce": nonce,
                 "sig": sig or _hmac.new(key or self.key, signing.encode(), hashlib.sha256).hexdigest()}
        path = os.path.join(self.dir, name)
        with open(path, "w") as fh:
            json.dump(entry, fh)
        return path

    def pre(self, command=None, cwd=None):
        out = guards.pre_tool_use({"tool_name": "Bash", "tool_input": {"command": command or self.CMD},
                                   "cwd": cwd or self.cwd})
        return (out or {}).get("hookSpecificOutput", {})

    def test_match_consumes_and_second_use_asks_again(self):
        path = self.write_entry()
        first = self.pre()
        self.assertNotIn("permissionDecision", first)          # allowed
        self.assertIn("Allowed once", first.get("additionalContext", ""))
        self.assertFalse(os.path.exists(path))                 # consumed (single use)
        self.assertEqual(os.listdir(self.dir), [guards.ALLOW_KEY_NAME])  # no leftover claim file
        self.assertEqual(self.pre().get("permissionDecision"), "ask")  # second use blocked again

    def test_mismatched_command_still_asks(self):
        path = self.write_entry()
        # Different whitespace is a different command: the approval is for the exact string.
        self.assertEqual(self.pre(self.CMD.replace("restart", "restart ")).get("permissionDecision"), "ask")
        self.assertEqual(self.pre("systemctl restart other").get("permissionDecision"), "ask")
        self.assertTrue(os.path.exists(path))                  # not consumed by a mismatch

    def test_expired_entry_ignored_and_cleaned(self):
        path = self.write_entry(expires_in_ms=-1)
        self.assertEqual(self.pre().get("permissionDecision"), "ask")
        self.assertFalse(os.path.exists(path))

    def test_far_future_entry_rejected(self):
        # The server only issues 5-minute approvals; a signed day-long one is not honoured.
        self.write_entry(expires_in_ms=24 * 3600 * 1000)
        self.assertEqual(self.pre().get("permissionDecision"), "ask")

    def test_deny_level_cannot_be_allowed_once(self):
        cmd = "ssh prod 'pkill -f bot && systemctl restart bot'"
        self.write_entry(rules=("pkill", "service-restart"), command=cmd)
        self.assertEqual(self.pre(cmd).get("permissionDecision"), "deny")
        self.assertEqual(len([n for n in os.listdir(self.dir) if n.endswith(".json")]), 1)  # untouched

    def test_unsigned_or_forged_entry_rejected(self):
        # An agent writing the JSON itself (without the server's key) must not approve itself.
        self.write_entry(sig="0" * 64)
        self.assertEqual(self.pre().get("permissionDecision"), "ask")
        self.write_entry(key=b"wrong-key", name="b.json")
        self.assertEqual(self.pre().get("permissionDecision"), "ask")

    def test_missing_key_fails_closed(self):
        self.write_entry()
        os.unlink(os.path.join(self.dir, guards.ALLOW_KEY_NAME))
        self.assertEqual(self.pre().get("permissionDecision"), "ask")

    def test_entry_must_cover_every_ask_rule(self):
        cmd = "git reset --hard && systemctl restart api"
        self.write_entry(rules=("service-restart",), command=cmd)
        self.assertEqual(self.pre(cmd).get("permissionDecision"), "ask")
        self.write_entry(rules=("git-reset-hard", "service-restart"), command=cmd, name="b.json")
        self.assertNotIn("permissionDecision", self.pre(cmd))

    def test_cwd_scoping(self):
        self.write_entry()
        other = tempfile.mkdtemp(prefix="guards-other-")
        try:
            self.assertEqual(self.pre(cwd=other).get("permissionDecision"), "ask")
        finally:
            shutil.rmtree(other, ignore_errors=True)
        sub = os.path.join(self.cwd, "sub")
        os.mkdir(sub)
        self.assertNotIn("permissionDecision", self.pre(cwd=sub))  # a subdir of the session cwd is fine

    def test_missing_dir_is_harmless(self):
        shutil.rmtree(self.dir)
        self.assertEqual(self.pre().get("permissionDecision"), "ask")

    def test_concurrent_consumers_only_one_wins(self):
        # Simulate the loser of the rename race: the file vanishes between listdir and rename.
        self.write_entry()
        real_rename = os.rename

        def racing_rename(src, dst):
            os.unlink(src)  # another hook consumed it first
            return real_rename(src, dst)

        with mock.patch.object(guards.os, "rename", side_effect=racing_rename):
            self.assertIsNone(guards.consume_allow_once({"service-restart"}, self.CMD, self.cwd))

    def test_check_mode_never_consumes(self):
        path = self.write_entry()
        guards.decide(guards.Analyzer(self.cwd).analyze(self.CMD), set())
        self.assertTrue(os.path.exists(path))

    def test_end_to_end_hook_process(self):
        path = self.write_entry()
        env = {k: v for k, v in os.environ.items() if not k.startswith("GUARDS_")}
        env["HOME"] = self.home
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": self.CMD}, "cwd": self.cwd})
        p = subprocess.run([sys.executable, GUARDS_PY, "pre"], input=payload, capture_output=True, text=True,
                           env=env, timeout=30)
        self.assertNotIn("permissionDecision", json.loads(p.stdout)["hookSpecificOutput"])
        self.assertFalse(os.path.exists(path))
        p = subprocess.run([sys.executable, GUARDS_PY, "pre"], input=payload, capture_output=True, text=True,
                           env=env, timeout=30)
        self.assertEqual(json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"], "ask")


class Installer(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="guards-install-")
        self.settings = os.path.join(self.dir, "settings.json")
        self.foreign = {"type": "command", "command": "echo mine"}
        with open(self.settings, "w") as fh:
            json.dump({"model": "x", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [self.foreign]}]}}, fh)
        os.chmod(self.settings, 0o600)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def sh(self, *args):
        p = subprocess.run(["sh", INSTALL_SH, "--settings", self.settings, *args], capture_output=True, text=True,
                           timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    def load(self):
        with open(self.settings) as fh:
            return json.load(fh)

    def backups(self):
        return [f for f in os.listdir(self.dir) if ".bak-guards-" in f]

    def ours(self, data):
        return [h["command"] for groups in data.get("hooks", {}).values() for g in groups for h in g["hooks"]
                if "guards.py" in h["command"]]

    def test_dry_run_changes_nothing(self):
        before = _read(self.settings)
        out = self.sh()
        self.assertIn("DRY RUN", out)
        self.assertEqual(_read(self.settings), before)
        self.assertEqual(self.backups(), [])

    def test_apply_idempotent_and_uninstall(self):
        self.sh("--apply")
        data = self.load()
        self.assertEqual(len(self.ours(data)), 3)
        self.assertEqual(data["model"], "x")
        self.assertIn(self.foreign, data["hooks"]["PreToolUse"][0]["hooks"])
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual(os.stat(self.settings).st_mode & 0o777, 0o600)

        out = self.sh("--apply")  # second run: no change, no new backup
        self.assertIn("nothing to do", out)
        self.assertEqual(len(self.ours(self.load())), 3)
        self.assertEqual(len(self.backups()), 1)

        self.sh("--uninstall", "--apply")
        data = self.load()
        self.assertEqual(self.ours(data), [])
        self.assertEqual(data["hooks"], {"PreToolUse": [{"matcher": "Bash", "hooks": [self.foreign]}]})
        self.assertIn("nothing to do", self.sh("--uninstall", "--apply"))

    def test_installed_commands_run(self):
        self.sh("--apply")
        pre = [c for c in self.ours(self.load()) if c.endswith(" pre")][0]
        p = subprocess.run(pre, shell=True, input=json.dumps(
            {"tool_name": "Bash", "tool_input": {"command": "killall node"}, "cwd": "/"}),
            capture_output=True, text=True, timeout=30)
        self.assertEqual(json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_missing_settings_created(self):
        os.remove(self.settings)
        self.sh("--apply")
        self.assertEqual(len(self.ours(self.load())), 3)

    def test_invalid_json_refused(self):
        with open(self.settings, "w") as fh:
            fh.write("{broken")
        p = subprocess.run(["sh", INSTALL_SH, "--settings", self.settings, "--apply"], capture_output=True,
                           text=True, timeout=30)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(_read(self.settings), "{broken")


if __name__ == "__main__":
    unittest.main()
