"""env pack: compose `$` interpolation, tracked and world-readable env files."""
from tests.helpers import RepoTestCase

COMPOSE = "services:\n  app:\n    env_file: .env\n"


class ComposeDollarTest(RepoTestCase):
    def test_unescaped_dollar_warns(self):
        self.repo.write(".gitignore", ".env\n")
        self.repo.write("docker-compose.yml", COMPOSE)
        self.repo.write(".env", "DB_PASSWORD=ab$cd9\n", mode=0o600)
        self.repo.commit()
        findings = self.repo.findings(["env"])
        self.assertEqual([(f.rule_id, f.path, f.line) for f in findings],
                         [("env.compose-dollar", ".env", 1)])

    def test_escaped_quoted_and_interpolated_values_are_quiet(self):
        self.repo.write(".gitignore", ".env\n")
        self.repo.write("compose.yaml", COMPOSE)
        self.repo.write(".env", "A=ab$$cd\nB='ab$cd'\nC=${HOME}/x\nD=${X:-def}\n# E=$comment\n", mode=0o600)
        self.repo.commit()
        self.assertEqual(self.repo.ids(["env"]), [])

    def test_without_compose_file_dollar_is_fine(self):
        # Plain dotenv loaders do not interpolate; the lesson is compose-specific.
        self.repo.write(".gitignore", ".env\n")
        self.repo.write(".env", "DB_PASSWORD=ab$cd\n", mode=0o600)
        self.assertEqual(self.repo.ids(["env"]), [])


class EnvFileTest(RepoTestCase):
    def test_tracked_env_and_bak_are_errors_but_example_is_not(self):
        self.repo.write(".env.bak", "X=1\n", mode=0o600)
        self.repo.write("bot/.env", "X=1\n", mode=0o600)
        self.repo.write(".env.example", "X=\n", mode=0o644)
        self.repo.commit()
        tracked = sorted(f.path for f in self.repo.findings(["env"]) if f.rule_id == "env.file-tracked")
        self.assertEqual(tracked, [".env.bak", "bot/.env"])

    def test_changed_mode_flags_only_newly_added_env_file(self):
        self.repo.write(".env", "X=1\n", mode=0o600)
        self.repo.add(".env")
        self.assertEqual(self.repo.ids(["env"], changed=True), ["env.file-tracked"])

    def test_untracked_world_readable_env_is_an_error(self):
        # Usually gitignored, so the check looks at disk, not the index.
        self.repo.write(".gitignore", ".env\n")
        self.repo.write(".env", "X=1\n", mode=0o644)
        self.repo.commit()
        findings = self.repo.findings(["env"])
        self.assertEqual([f.rule_id for f in findings], ["env.file-world-readable"])
        self.assertIn("644", findings[0].message)

    def test_mode_600_is_fine(self):
        self.repo.write(".gitignore", ".env\n")
        self.repo.write(".env", "X=1\n", mode=0o600)
        self.repo.commit()
        self.assertEqual(self.repo.ids(["env"]), [])
