"""python-alembic pack: revision id length/uniqueness and model change without migration."""
from tests.helpers import RepoTestCase


def migration(rev: str, down: str = "None") -> str:
    down_s = down if down == "None" else repr(down)
    return f'"""m"""\nrevision = {rev!r}\ndown_revision = {down_s}\n\ndef upgrade():\n    pass\n'


MODEL = ("from sqlalchemy import Column, Integer, String\n\n"
         "class User(Base):\n    id = Column(Integer, primary_key=True)\n    name = Column(String(50))\n")


class RevisionIdTest(RepoTestCase):
    def test_33_char_id_is_an_error_32_is_fine(self):
        self.repo.write("alembic/versions/a.py", migration("a" * 33))
        self.repo.write("alembic/versions/b.py", migration("b" * 32, "a" * 33))
        findings = self.repo.findings(["python-alembic"])
        self.assertEqual([(f.rule_id, f.path, f.line) for f in findings],
                         [("alembic.revision-id-too-long", "alembic/versions/a.py", 2)])

    def test_typed_revision_assignment_is_parsed(self):
        # Newer alembic templates write `revision: str = "..."`.
        self.repo.write("migrations/versions/a.py",
                        'revision: str = "x_add_a_very_long_descriptive_name_1"\ndown_revision = None\n')
        self.assertEqual(self.repo.ids(["python-alembic"]), ["alembic.revision-id-too-long"])

    def test_duplicate_ids_flag_both_files(self):
        self.repo.write("alembic/versions/a.py", migration("0042abcd"))
        self.repo.write("alembic/versions/b.py", migration("0042abcd", "0001"))
        paths = sorted(f.path for f in self.repo.findings(["python-alembic"]))
        self.assertEqual(paths, ["alembic/versions/a.py", "alembic/versions/b.py"])

    def test_non_migration_files_are_ignored(self):
        self.repo.write("app/settings.py", f"revision = {'z' * 40!r}\n")
        self.assertEqual(self.repo.ids(["python-alembic"]), [])


class ModelWithoutMigrationTest(RepoTestCase):
    def setUp(self):
        super().setUp()
        self.repo.write("alembic.ini", "[alembic]\n")
        self.repo.write("alembic/versions/0001.py", migration("0001"))
        self.repo.write("app/models.py", MODEL)
        self.repo.commit()

    def test_column_type_change_without_migration_warns(self):
        self.repo.write("app/models.py", MODEL.replace("String(50)", "String(255)"))
        self.repo.add()
        findings = self.repo.findings(["python-alembic"], changed=True)
        self.assertEqual([(f.rule_id, f.line) for f in findings],
                         [("alembic.model-change-without-migration", 5)])
        self.assertIn("'name' changed", findings[0].message)

    def test_new_column_in_mapped_style_warns(self):
        self.repo.write("app/models.py", MODEL + "    age: Mapped[int] = mapped_column(Integer)\n")
        self.repo.add()
        self.assertEqual(self.repo.ids(["python-alembic"], changed=True),
                         ["alembic.model-change-without-migration"])

    def test_change_with_new_migration_is_fine(self):
        self.repo.write("app/models.py", MODEL.replace("String(50)", "String(255)"))
        self.repo.write("alembic/versions/0002.py", migration("0002", "0001"))
        self.repo.add()
        self.assertEqual(self.repo.ids(["python-alembic"], changed=True), [])

    def test_non_column_edit_is_fine(self):
        self.repo.write("app/models.py", MODEL + "\n    def __repr__(self):\n        return self.name\n")
        self.repo.add()
        self.assertEqual(self.repo.ids(["python-alembic"], changed=True), [])
