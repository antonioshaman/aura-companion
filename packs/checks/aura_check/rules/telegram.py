"""Pack ``telegram-miniapp`` — Mini App cache and aiogram FSM lessons."""
from __future__ import annotations

import re
from typing import Set

from ..codeutil import balanced_call, is_test_path
from ..core import WARN, Context, rule

PACK = "telegram-miniapp"

CONFIG_EXT = (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".yml", ".yaml", ".toml", ".env",
              ".sh", ".ini", ".cfg")
WEBAPP_CTX_RE = re.compile(
    r"(?i)(web_?app|webappinfo|menu_?button|setchatmenubutton|mini_?app|tma_?url|twa_?url)")
URL_RE = re.compile(r"https?://[^\s'\"`)\]>,]+")
VERSIONED_RE = re.compile(
    r"(?i)([?&](v|ver|version|build|rev|cb|_v|t)=[^&#\s]+)"   # query param
    r"|(/v?\d+(\.\d+)*/)"                                     # /v123/ or /1.2.3/ path segment
    r"|(/[0-9a-f]{7,40}/)"                                    # /<sha>/ path segment
)
SKIP_HOSTS = ("t.me/", "telegram.org/", "telegram.me/", "core.telegram.org")


@rule(
    id="telegram.miniapp-url-unversioned", pack=PACK, severity=WARN, diff_scoped=True,
    title="Mini App / menu-button URL without a cache-busting version",
    evidence="snowlevel: Telegram caches the Mini App by full URL; the `?v=` lesson was written 15.09 and "
             "the stale-bundle outage recurred 28.09 (05d175b, bot served ?v=8 for build 13), 29.09 "
             "(b8d2673), 01.10; Rapesha_shop_bot: MenuButton switched 6 times in 4 days. 5 projects.",
    hint="Derive a version from the bundle hash / git SHA at deploy time and put it in the URL the bot "
         "sends (`...?v=<sha>`), and restart the bot after each frontend deploy. If a query string "
         "breaks iOS initData for your app (rapesha_academy 57e33b4), version a path segment instead "
         "(`/app/<sha>/`).",
)
def miniapp_url_unversioned(ctx: Context):
    for path in ctx.files:
        if is_test_path(path) or not (path.endswith(CONFIG_EXT) or "/.env" in f"/{path}"):
            continue
        if not WEBAPP_CTX_RE.search(ctx.read(path) or ""):
            continue
        for n, line in ctx.scan_lines(path):
            if not WEBAPP_CTX_RE.search(line):
                continue
            for m in URL_RE.finditer(line):
                url = m.group(0)
                if any(h in url for h in SKIP_HOSTS):
                    continue
                if "{" in url or "${" in line[m.end():m.end() + 3] or line[m.end():m.end() + 1] in ("{", "$"):
                    continue  # templated: version may be interpolated
                if VERSIONED_RE.search(url):
                    continue
                yield path, n, f"Mini App URL has no version/cache-bust marker: {url}"


STATE_GROUP_RE = re.compile(r"^\s*class\s+(\w+)\s*\(\s*(?:\w+\.)?StatesGroup\s*\)", re.M)
MESSAGE_DECO_RE = re.compile(r"^\s*@\s*[\w.]+\.message\s*\(")
SAFE_FILTER_RE = re.compile(
    r"\bCommand\w*\s*\(|~\s*F\.text\.startswith|F\.text\.startswith|F\.text\.regexp|F\.text\.in_|"
    r"F\.text\s*==|F\.(photo|document|voice|video|video_note|sticker|contact|location|audio|animation|"
    r"successful_payment|web_app_data|dice|poll)\b|StateFilter\(\s*None\s*\)|\bText\(|lambda"
)
CATCH_ALL_CMD_RE = re.compile(r"Command\w*\(.*(StateFilter\(\s*['\"]\*['\"]\s*\)|any_state)")


def _state_groups(ctx: Context) -> Set[str]:
    names: Set[str] = set()
    for path in ctx.all_files:
        if not path.endswith(".py"):
            continue
        text = ctx.read(path) or ""
        if "StatesGroup" in text:
            names.update(STATE_GROUP_RE.findall(text))
    return names


@rule(
    id="telegram.fsm-swallows-commands", pack=PACK, severity=WARN, diff_scoped=True,
    title="aiogram state handler that would swallow /start and menu commands",
    evidence="razumai 202e8a1 (04-03), 40e796f (04-05, /admin intercepted) and >=4 repeats despite a memory "
             "note; snowlevel/SpiritMiner 5c0c1f6 (/start swallowed); 7 Telegram projects in the corpus.",
    hint="Exclude commands in the state handler (`~F.text.startswith('/')`, or a content filter), or "
         "register /start, /menu, /cancel with `StateFilter('*')` on a router included before the FSM router.",
)
def fsm_swallows_commands(ctx: Context):
    groups = None
    for path in ctx.files_with_ext(".py"):
        if is_test_path(path):
            continue
        text = ctx.read(path) or ""
        if "aiogram" not in text and "StatesGroup" not in text and ".message(" not in text:
            continue
        if groups is None:
            groups = _state_groups(ctx)
        lines = text.splitlines()
        catch_all_seen = False
        for i, line in enumerate(lines):
            m = MESSAGE_DECO_RE.match(line)
            if not m:
                continue
            args = balanced_call(lines, i, m.end() - 1)
            if CATCH_ALL_CMD_RE.search(args):
                catch_all_seen = True
                continue
            state_filter = (re.search(r"StateFilter\(\s*(?!None)", args)
                            or re.search(r"\bstate\s*=", args)
                            or any(re.search(r"\b" + re.escape(g) + r"\.\w+", args) for g in groups or ()))
            if not state_filter or SAFE_FILTER_RE.search(args) or catch_all_seen:
                continue
            yield path, i + 1, "state handler has no filter excluding commands; /start and menu buttons land here"
