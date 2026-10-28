"""Pack ``uiux`` — UI/UX and accessibility mistakes a line-and-tag scan can see.

Each rule cites a published guideline (``source``: ids from
``docs/research/uiux-sources/catalog.json``) instead of a project incident, and
each is tuned to stay quiet on the shapes a real React/Tailwind frontend uses
legitimately (backdrops, focus-visible rings, labelled icon buttons, spread
props). When the scan cannot know (spread props, ``{expr}`` children), it stays
quiet: these rules miss cases rather than guess. They do not replace a rendered
axe scan, which sees the computed accessibility tree.
"""
from __future__ import annotations

import re

from ..codeutil import JS_EXT, MARKUP_EXT, element_inner, is_test_path, markup_tags
from ..core import ERROR, WARN, Context, rule

PACK = "uiux"

FOCUSABLE_TAGS = {"button", "input", "select", "textarea", "summary", "iframe"}
NON_INTERACTIVE_TAGS = {"div", "span", "li", "p", "section", "article", "td", "tr", "img", "label",
                        "header", "footer", "main", "aside", "nav", "ul", "ol", "figure"}
KEY_HANDLER_RE = re.compile(r"(?<![\w-])on(key(down|up|press))(?![\w-])", re.I)
FOCUS_STYLE_RE = re.compile(r"(focus-visible|focus|focus-within|group-focus|peer-focus)(-visible)?:")
BACKDROP_RE = re.compile(r"(?<![\w-])inset-0(?![\w-])")
# `(e) => e.stopPropagation()` / `e => { e.stopPropagation(); }`: a dialog panel
# keeping the click from its backdrop, not an affordance.
PROPAGATION_ONLY_RE = re.compile(
    r"^\(?\s*(\w+)\s*(:\s*[\w.<>]+)?\s*\)?\s*=>\s*\{?\s*\1\.(stopPropagation|preventDefault)\(\)\s*;?\s*\}?$")


def _markup_files(ctx: Context):
    for path in ctx.files_with_ext(*MARKUP_EXT):
        if is_test_path(path):
            continue
        text = ctx.read(path)
        if text and "<" in text:
            yield path, text


def _truthy(value) -> bool:
    return value is not None and value.strip().lower() in ("", "true")


def _tabindex(tag):
    v = tag.value("tabindex")
    if v is None:
        return None
    try:
        return int(v.strip())
    except ValueError:
        return 0  # an expression: assume it can be tabbable


ALERT_RE = re.compile(r"(?<![\w.$])(window\.)?alert\s*\(")


@rule(
    id="uiux.native-alert", pack=PACK, severity=WARN,
    title="Native alert() for user feedback",
    source="nielsen-heuristics: #9 help users recognise, diagnose and recover from errors; "
           "telegram-webapps: showAlert / showPopup",
    evidence="A browser alert() blocks the page, cannot be styled or localised, carries no next step and "
             "is suppressed or ugly inside webviews (Telegram Mini Apps provide showAlert/showPopup).",
    hint="Show the message in the page: inline next to the field, a toast or a dialog component, and say "
         "what to do next. In a Telegram Mini App use WebApp.showAlert / showPopup.",
)
def native_alert(ctx: Context):
    for path in ctx.files_with_ext(*(JS_EXT + MARKUP_EXT)):
        if is_test_path(path):
            continue
        text = ctx.read(path) or ""
        if "alert" not in text:
            continue
        for n, line in ctx.scan_lines(path):
            code = re.sub(r"(['\"`])(?:\\.|(?!\1).)*\1", '""', line)
            code = code.split("//", 1)[0]
            if ALERT_RE.search(code):
                yield path, n, "alert() blocks the page and gives no next step"


@rule(
    id="uiux.focusable-aria-hidden", pack=PACK, severity=ERROR,
    title="Focusable element hidden from assistive tech (aria-hidden)",
    source="wcag-22: 4.1.2 Name, Role, Value; aria-apg: aria-hidden must not be on focusable elements",
    evidence="Keyboard focus lands on an element that screen readers were told does not exist: the user "
             "hears nothing, or the previous announcement. axe reports it as aria-hidden-focus (serious).",
    hint="Remove aria-hidden from the focusable element, or make it unfocusable (tabIndex={-1}, `inert`, "
         "or disabled) when it is truly decorative or off-screen.",
)
def focusable_aria_hidden(ctx: Context):
    for path, text in _markup_files(ctx):
        if "aria-hidden" not in text:
            continue
        for tag in markup_tags(text):
            if not _truthy(tag.value("aria-hidden")):
                continue
            ti = _tabindex(tag)
            name = tag.name.lower()
            focusable = (ti is not None and ti >= 0) or (
                ti is None and (name in FOCUSABLE_TAGS or (name == "a" and tag.has("href"))))
            if focusable and not tag.has("disabled") and not tag.has("inert"):
                yield path, tag.line, f"<{tag.name}> is focusable but aria-hidden"


@rule(
    id="uiux.outline-none-without-focus-style", pack=PACK, severity=WARN,
    title="outline-none with no replacement focus style",
    source="wcag-22: 2.4.7 Focus Visible; wcag-22: 2.4.11 Focus Not Obscured / 1.4.11 Non-text Contrast",
    evidence="Tailwind's outline-none removes the browser focus ring; with no focus:/focus-visible: style on "
             "the same element, keyboard users cannot see where they are.",
    hint="Pair it with a visible replacement on the same element, e.g. `focus-visible:ring-2 "
         "focus-visible:ring-cc-primary`, or drop outline-none and keep the global :focus-visible ring.",
)
def outline_none_without_focus(ctx: Context):
    for path, text in _markup_files(ctx):
        if "outline-none" not in text and "outline-0" not in text:
            continue
        for tag in markup_tags(text):
            cls = tag.value("className")
            if cls is None:
                cls = tag.value("class")
            if not cls or not re.search(r"(?<![\w:-])outline-(none|0)(?![\w-])", cls):
                continue
            ti = _tabindex(tag)
            if ti is not None and ti < 0:
                continue  # programmatic focus target, not in the tab order
            if FOCUS_STYLE_RE.search(cls):
                continue
            yield path, tag.line, f"<{tag.name}> removes the focus outline and sets no focus style"


@rule(
    id="uiux.clickable-non-interactive", pack=PACK, severity=WARN,
    title="Click handler on a non-interactive element with no keyboard path",
    source="wcag-22: 2.1.1 Keyboard; wcag-22: 4.1.2 Name, Role, Value; eslint-plugin-jsx-a11y: "
           "click-events-have-key-events / no-static-element-interactions",
    evidence="A <div onClick> is invisible to the keyboard and to screen readers: it is not in the tab "
             "order, has no role and Enter/Space do nothing.",
    hint="Use a <button type=\"button\"> (or <a href> for navigation). If a div is unavoidable, add "
         "role, tabIndex={0} and an onKeyDown for Enter/Space.",
)
def clickable_non_interactive(ctx: Context):
    for path, text in _markup_files(ctx):
        if not re.search(r"onclick", text, re.I):
            continue
        for tag in markup_tags(text):
            if tag.name.lower() not in NON_INTERACTIVE_TAGS or not tag.has("onClick"):
                continue
            if tag.spread or tag.has("role") or tag.value("tabindex") is not None:
                continue
            if PROPAGATION_ONLY_RE.match((tag.value("onClick") or "").strip()):
                continue
            if KEY_HANDLER_RE.search(tag.top_level()) or _truthy(tag.value("aria-hidden")):
                continue
            cls = tag.value("className") or tag.value("class") or ""
            if BACKDROP_RE.search(cls):
                continue  # full-viewport backdrop: pointer shortcut for Escape/close (APG dialog)
            yield path, tag.line, f"<{tag.name} onClick> has no role, tabIndex or key handler"


ICON_CHILD_RE = re.compile(r"<(svg|img|[A-Z][\w.]*)\b")
NAME_CHILD_RE = re.compile(r"<title\b|sr-only|visually-hidden|aria-label", re.I)


@rule(
    id="uiux.icon-button-no-name", pack=PACK, severity=WARN,
    title="Icon-only button with no accessible name",
    source="wcag-22: 4.1.2 Name, Role, Value; wcag-22: 1.1.1 Non-text Content; aria-apg: button pattern",
    evidence="A button whose only child is an icon is announced as \"button\" with no name: screen-reader "
             "and voice-control users cannot tell what it does. axe reports it as button-name (critical).",
    hint="Add aria-label=\"<what it does>\" to the button (or visible text, or an sr-only span). A title "
         "alone is a weak name; prefer aria-label.",
)
def icon_button_no_name(ctx: Context):
    for path, text in _markup_files(ctx):
        if "<button" not in text:
            continue
        for tag in markup_tags(text):
            if tag.name != "button" or tag.spread:
                continue
            if any(tag.has(a) for a in ("aria-label", "aria-labelledby", "title")):
                continue
            inner = element_inner(text, tag)
            if inner is None or "{" in inner or not ICON_CHILD_RE.search(inner):
                continue
            if NAME_CHILD_RE.search(inner):
                continue
            visible = re.sub(r"<[^>]*>", "", inner).replace("&nbsp;", "").strip()
            if not visible:
                yield path, tag.line, "button has only an icon and no aria-label"


AXE_DISABLE_RE = re.compile(
    r"[\"']?([a-z][a-z0-9-]*)[\"']?\s*:\s*\{\s*enabled\s*:\s*false\s*\}|\.?disableRules\s*\(([^)]*)")
COMMENT_LINE_RE = re.compile(r"^\s*(//|/\*|\*)")
TRAILING_COMMENT_RE = re.compile(r"(^|\s)(//|/\*)")
TEST_OPEN_RE = re.compile(r"^\s*(it|test)(\.\w+)?\s*\(")
AXE_ANCHOR_LOOKBACK = 12  # lines from an override back to its axe(...) / axeRules / AxeBuilder
TEST_LOOKBACK = 40        # lines from an override back to the it()/test() that holds it


@rule(
    id="uiux.axe-rule-disabled-unjustified", pack=PACK, severity=WARN,
    title="axe rule disabled with no reason",
    source="axe-core: rules configuration (rules / disableRules); wcag-22: conformance — a skipped check "
           "is not a pass",
    evidence="Turning off an axe rule in a test makes the a11y assertion green by construction; without a "
             "written reason a real violation (e.g. button-name) is silently accepted forever.",
    hint="Fix the violation and drop the override. If the rule truly does not apply (a portal outside "
         "landmarks, a test-only mock), write the reason in a comment on the line or just above it.",
)
def axe_rule_disabled(ctx: Context):
    for path in ctx.files_with_ext(*JS_EXT):
        text = ctx.read(path) or ""
        if "axe" not in text.lower() or ("enabled" not in text and "disableRules" not in text):
            continue
        lines = text.splitlines()
        for n, line in ctx.scan_lines(path):
            m = AXE_DISABLE_RE.search(line)
            if not m:
                continue
            # The override belongs to the nearest axe call / config above it;
            # `x: { enabled: false }` with no axe anchor is app data, not axe.
            anchor = next((k for k in range(n, max(0, n - AXE_ANCHOR_LOOKBACK) - 1, -1)
                           if k >= 1 and "axe" in lines[k - 1].lower()), None)
            if anchor is None:
                continue
            if TRAILING_COMMENT_RE.search(line[m.end():]):
                continue
            # The reason may sit inside the same it()/test() (above the axe call
            # or between the overrides), or in the comment block right above a
            # shared config such as `const axeRules = {`. A comment above the
            # it() describes the test, not the override.
            test_open = next((k for k in range(n - 1, max(0, n - TEST_LOOKBACK), -1)
                              if TEST_OPEN_RE.match(lines[k - 1])), None)
            scope = list(range((test_open or anchor) + 1, n))
            k = anchor - 1
            while k >= 1 and COMMENT_LINE_RE.match(lines[k - 1]):
                scope.append(k)
                k -= 1
            if any(COMMENT_LINE_RE.match(lines[k - 1]) for k in scope):
                continue
            yield path, n, "an axe rule is switched off with no comment saying why"
