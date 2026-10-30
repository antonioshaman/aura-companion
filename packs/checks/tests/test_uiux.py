"""uiux pack: one planted defect (must fire) and one near miss (must stay quiet) per rule.

The near misses are the shapes Aura's own frontend really uses (labelled icon
buttons, backdrops, focus-visible rings, justified axe exclusions), so a rule
that fires on them would be noise on its first real repository. Every rule must
also name a source that exists in the UI/UX source catalog.
"""
import json
from pathlib import Path

from aura_check import core
from tests.helpers import RepoTestCase

PACK = ["uiux"]
CATALOG = Path(__file__).resolve().parents[3] / "docs" / "research" / "uiux-sources" / "catalog.json"


def hits(repo, rule_id=None):
    return [(f.rule_id, f.path, f.line) for f in repo.findings(PACK)
            if rule_id is None or f.rule_id == rule_id]


class RuleMetadataTest(RepoTestCase):
    def test_at_least_five_rules_each_with_source_severity_and_hint(self):
        rules = [r for r in core.select_rules(PACK, runtime=True)]
        self.assertGreaterEqual(len(rules), 5)
        for r in rules:
            self.assertTrue(r.id.startswith("uiux."), r.id)
            self.assertIn(r.severity, (core.ERROR, core.WARN), r.id)
            self.assertGreater(len(r.hint), 40, r.id)
            self.assertTrue(r.source, f"{r.id} has no source")

    def test_every_source_id_is_in_the_catalog(self):
        # A source is "catalog-id: criterion". The id must be a catalog entry
        # that is not excluded, so a rule cannot cite something we rejected.
        entries = {e["id"]: e for e in json.loads(CATALOG.read_text())["entries"]}
        for r in core.select_rules(PACK, runtime=True):
            for part in r.source.split(";"):
                cid = part.strip().split(":", 1)[0].strip()
                self.assertIn(cid, entries, f"{r.id}: unknown source {cid!r}")
                self.assertNotEqual(entries[cid].get("verdict"), "excluded", f"{r.id}: {cid} is excluded")

    def test_list_shows_the_source(self):
        _, out, _ = self.repo.cli("--list", "--pack", "uiux")
        self.assertIn("[uiux]", out)
        self.assertIn("source: wcag-22", out)


class NativeAlertTest(RepoTestCase):
    def test_window_alert_and_bare_alert_fire(self):
        self.repo.write("web/src/Form.tsx",
                        "export function save() {\n  alert('Saved');\n  window.alert(`x`);\n}\n")
        self.assertEqual(hits(self.repo), [("uiux.native-alert", "web/src/Form.tsx", 2),
                                           ("uiux.native-alert", "web/src/Form.tsx", 3)])

    def test_platform_dialogs_and_lookalikes_are_quiet(self):
        # Telegram's showAlert, React Native's Alert.alert, a method named
        # alert on our own object, a string and a comment are not browser alert().
        self.repo.write("web/src/Ok.tsx",
                        "WebApp.showAlert('ok');\nAlert.alert('t');\nlogger.alert('x');\n"
                        "const s = 'call alert() later';\n// alert(1) was removed\nfunction isAlert() {}\n")
        self.repo.write("web/src/Ok.test.tsx", "alert('in a test');\n")
        self.assertEqual(hits(self.repo), [])


class FocusableAriaHiddenTest(RepoTestCase):
    def test_hidden_button_and_tabbable_div_fire(self):
        self.repo.write("web/src/A.tsx",
                        'const a = <button aria-hidden="true" onClick={go}>Go</button>;\n'
                        "const b = (\n  <div\n    aria-hidden={true}\n    tabIndex={0}\n  >x</div>\n);\n")
        self.assertEqual(hits(self.repo), [("uiux.focusable-aria-hidden", "web/src/A.tsx", 1),
                                           ("uiux.focusable-aria-hidden", "web/src/A.tsx", 3)])

    def test_hidden_decoration_and_untabbable_are_quiet(self):
        self.repo.write("web/src/A.tsx",
                        '<svg aria-hidden="true" />\n<span aria-hidden>•</span>\n'
                        '<div aria-hidden="true" tabIndex={-1} />\n<button aria-hidden="false">x</button>\n')
        self.assertEqual(hits(self.repo), [])

    def test_html_files_are_scanned(self):
        self.repo.write("site/index.html", '<a href="/x" aria-hidden="true">x</a>\n')
        self.assertEqual(hits(self.repo), [("uiux.focusable-aria-hidden", "site/index.html", 1)])


class OutlineNoneTest(RepoTestCase):
    def test_outline_none_without_any_focus_style_fires(self):
        self.repo.write("web/src/A.tsx", '<input className="px-2 outline-none" />\n')
        self.assertEqual(hits(self.repo), [("uiux.outline-none-without-focus-style", "web/src/A.tsx", 1)])

    def test_focus_replacements_are_quiet(self):
        self.repo.write("web/src/A.tsx",
                        '<input className="outline-none focus-visible:ring-2" />\n'
                        '<input className="focus:outline-none focus:border-cc-primary" />\n'
                        '<button className={cn("outline-none", "focus-visible:outline-2")} />\n'
                        '<div className="outline-none" tabIndex={-1} />\n')
        self.assertEqual(hits(self.repo), [])


class ClickableNonInteractiveTest(RepoTestCase):
    def test_div_with_click_only_fires(self):
        self.repo.write("web/src/A.tsx",
                        '<div className="card" onClick={open}>Open</div>\n'
                        "<span\n  onClick={() => pick(1)}\n>1</span>\n")
        self.assertEqual(hits(self.repo), [("uiux.clickable-non-interactive", "web/src/A.tsx", 1),
                                           ("uiux.clickable-non-interactive", "web/src/A.tsx", 2)])

    def test_keyboard_reachable_backdrop_and_spread_are_quiet(self):
        # role + tabIndex + key handler = a real widget; a full-viewport
        # backdrop is a pointer shortcut for Escape (APG dialog); spread props
        # may carry the role, so the rule cannot know and stays quiet.
        self.repo.write("web/src/A.tsx",
                        '<div role="button" tabIndex={0} onClick={a} onKeyDown={k}>a</div>\n'
                        '<div className="fixed inset-0 bg-black/50" onClick={onClose} />\n'
                        "<div {...rowProps} onClick={a}>x</div>\n"
                        '<div aria-hidden="true" onClick={a} />\n'
                        "<button onClick={a}>b</button>\n")
        self.assertEqual(hits(self.repo), [])

    def test_propagation_stopper_inside_a_backdrop_is_quiet(self):
        # Found on Aura's main (CronManager, EnvManager, TerminalView): the
        # dialog panel only stops the click from reaching the backdrop. It
        # is not an affordance, so it needs no role or key handler.
        self.repo.write("web/src/A.tsx",
                        '<div className="panel"\n  onClick={(e) => e.stopPropagation()}\n>x</div>\n'
                        "<div onClick={e => { e.stopPropagation(); }}>y</div>\n")
        self.assertEqual(hits(self.repo), [])


class IconButtonNoNameTest(RepoTestCase):
    def test_svg_only_button_without_label_fires(self):
        self.repo.write("web/src/A.tsx",
                        '<button onClick={close}>\n  <svg viewBox="0 0 16 16"><path d="M1 1L15 15" /></svg>\n'
                        "</button>\n<button><XIcon /></button>\n")
        self.assertEqual(hits(self.repo), [("uiux.icon-button-no-name", "web/src/A.tsx", 1),
                                           ("uiux.icon-button-no-name", "web/src/A.tsx", 4)])

    def test_named_buttons_are_quiet(self):
        self.repo.write("web/src/A.tsx",
                        '<button aria-label="Close"><svg viewBox="0 0 1 1" /></button>\n'
                        '<button title="Close"><XIcon /></button>\n'
                        "<button><XIcon /> Close</button>\n"
                        "<button><XIcon />{label}</button>\n"
                        '<button><XIcon /><span className="sr-only">Close</span></button>\n'
                        "<button {...props}><XIcon /></button>\n"
                        '<button><svg><title>Close</title></svg></button>\n')
        self.assertEqual(hits(self.repo), [])


class AxeRuleDisabledTest(RepoTestCase):
    def test_unexplained_disable_fires(self):
        self.repo.write("web/src/A.test.tsx",
                        'import { axe } from "vitest-axe";\n\n'
                        "it('a11y', async () => {\n  render(<A />);\n"
                        '  const r = await axe(container, {\n    rules: { "button-name": { enabled: false } },\n  });\n});\n'
                        "new AxeBuilder({ page }).disableRules(['color-contrast']);\n")
        self.assertEqual(hits(self.repo), [("uiux.axe-rule-disabled-unjustified", "web/src/A.test.tsx", 6),
                                           ("uiux.axe-rule-disabled-unjustified", "web/src/A.test.tsx", 9)])

    def test_disable_with_a_reason_comment_is_quiet(self):
        self.repo.write("web/src/A.test.tsx",
                        'import { axe } from "vitest-axe";\n'
                        "// The dialog portals outside landmarks, so `region` does not apply.\n"
                        "const r = await axe(document.body, { rules: { region: { enabled: false } } });\n"
                        "const s = await axe(c, {\n"
                        "  rules: { region: { enabled: false } }, // portal, see above\n});\n")
        # A settings object that is not an axe config must not trip the rule.
        self.repo.write("web/src/B.test.tsx", "const agent = { webhook: { enabled: false } };\n")
        self.assertEqual(hits(self.repo), [])

    def test_reason_is_tied_to_the_override_not_to_any_comment(self):
        # Shapes from Aura's main. A reason a few lines above the axe call
        # that names the rule counts (EnvManager). A nearby comment that says
        # nothing about the override does not (AgentCard: "Test 20 ... disabled
        # agent"). Every line of a multi-line rules object is checked, however far
        # it is from the `axe` token (AgentEditor's shared axeRules object).
        self.repo.write("web/src/A.test.tsx",
                        'import { axe } from "vitest-axe";\n'                       # 1
                        "it('modal', async () => {\n"                               # 2
                        "  // The modal portals into body; the region rule\n"       # 3
                        "  // does not apply outside landmarks.\n"                  # 4
                        "  render(<M />);\n"                                        # 5
                        "  await screen.findByText('x');\n"                         # 6
                        "  const r = await axe(document.body, {\n"                  # 7
                        "    rules: { region: { enabled: false } },\n"              # 8
                        "  });\n});\n"                                              # 9-10
                        "// Test 20: Accessibility scan - disabled agent\n"         # 11
                        "it('card', async () => {\n"                                # 12
                        "  const r = await axe(container, {\n"                      # 13
                        "    rules: {\n"                                            # 14
                        '      "heading-order": { enabled: false },\n'              # 15
                        "    },\n  });\n});\n"                                     # 16-18
                        "const axeRules = {\n"                                      # 19
                        "  rules: {\n"                                              # 20
                        "    label: { enabled: false },\n"                          # 21
                        '    "heading-order": { enabled: false },\n'                # 22
                        '    "button-name": { enabled: false },\n'                  # 23
                        "  },\n};\n")
        self.assertEqual([l for _, _, l in hits(self.repo, "uiux.axe-rule-disabled-unjustified")],
                         [15, 21, 22, 23])


    def test_an_unrelated_comment_inside_the_test_is_not_a_reason(self):
        # Observer WARN (checkpoint council-implement-189): "// Arrange" before
        # render() or "// Act" right above the axe call says nothing about the
        # override. A reason must sit on the override line, in the comment block
        # right above it, or in the block right above the axe call / shared config
        # and name the rule or give a reason ("because", "portal", "excluded" ...).
        self.repo.write("web/src/A.test.tsx",
                        'import { axe } from "vitest-axe";\n'          # 1
                        "it('a', async () => {\n"                      # 2
                        "  // Arrange\n"                               # 3
                        "  render(<A />);\n"                           # 4
                        "  // Act\n"                                   # 5
                        "  const r = await axe(container, {\n"         # 6
                        '    rules: { "button-name": { enabled: false } },\n'  # 7
                        "  });\n});\n"                                 # 8-9
                        "it('b', async () => {\n"                      # 10
                        "  const r = await axe(container, {\n"         # 11
                        "    rules: {\n"                               # 12
                        "      // the menu portals outside the container\n"  # 13
                        '      region: { enabled: false },\n'          # 14
                        "    },\n  });\n});\n")
        self.assertEqual([l for _, _, l in hits(self.repo, "uiux.axe-rule-disabled-unjustified")], [7])

    def test_a_label_above_an_it_whose_title_says_axe_is_not_a_reason(self):
        # Found while fixing the WARN above (AgentCard.test.tsx shape): the it()
        # title contains "axe" and the comment above it says "disabled agent".
        # Neither is about the override.
        self.repo.write("web/src/A.test.tsx",
                        'import { axe } from "vitest-axe";\n'                               # 1
                        "// Test 20: Accessibility scan - disabled agent\n"                 # 2
                        'it("passes axe accessibility checks for disabled agent", async () => {\n'  # 3
                        "  const r = await axe(container, {\n"                              # 4
                        '    rules: { "heading-order": { enabled: false } },\n'             # 5
                        "  });\n});\n")
        self.assertEqual([l for _, _, l in hits(self.repo, "uiux.axe-rule-disabled-unjustified")], [5])


class FixtureDirsTest(RepoTestCase):
    def test_planted_defects_in_fixture_dirs_are_test_data(self):
        # web/scripts/__fixtures__/a11y-scan/planted.html holds a deliberate
        # icon-only button: the rendered scan's own test fixture.
        self.repo.write("web/scripts/__fixtures__/a11y-scan/planted.html",
                        '<button id="close"><svg width="12" height="12" aria-hidden="true"></svg></button>\n')
        self.assertEqual(hits(self.repo), [])


class ReviewRegressionTest(RepoTestCase):
    # Attribute expressions and JSX comments are not accessible button labels.
    def test_icon_attributes_and_comment_only_buttons(self):
        self.repo.write("web/src/A.tsx", '<button><XIcon size={12}/></button>\n<button><svg className={cls}/></button>\n<button>{/* close */}</button>\n')
        self.assertEqual(len(hits(self.repo, "uiux.icon-button-no-name")), 3)

    def test_generic_adjacent_comments_do_not_justify_axe_exclusions(self):
        self.repo.write("web/src/A.test.tsx", 'const result = axe(container, {\n// Arrange\nrules: { "button-name": { enabled: false } } // TODO\n});\n')
        self.assertEqual(len(hits(self.repo, "uiux.axe-rule-disabled-unjustified")), 1)

    def test_partial_keyboard_support_still_fires(self):
        self.repo.write("web/src/A.tsx", '<div role="button" onClick={open}/>\n<div tabIndex={0} onClick={open}/>\n<div role="button" tabIndex={0} onClick={open}/>\n')
        self.assertEqual(len(hits(self.repo, "uiux.clickable-non-interactive")), 3)

    def test_managed_options_and_keyboard_table_rows_are_quiet(self):
        # APG listboxes keep focus on the container, not each option.
        self.repo.write("web/src/A.tsx", '<div role="listbox" tabIndex={0} aria-activedescendant={active} onKeyDown={keys}><div role="option" onClick={pick}>Model</div></div>\n<tr tabIndex={0} onClick={pick} onKeyDown={keys}><td>Run</td></tr>\n')
        self.assertEqual(hits(self.repo, "uiux.clickable-non-interactive"), [])
