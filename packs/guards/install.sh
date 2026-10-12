#!/bin/sh
# Install / uninstall the Aura guards pack into a Claude Code settings.json.
#
#   packs/guards/install.sh                       # dry-run: print the merged settings, change nothing
#   packs/guards/install.sh --apply               # write ~/.claude/settings.json (backup first)
#   packs/guards/install.sh --settings PATH --apply
#   packs/guards/install.sh --uninstall [--apply] # remove only the guards hooks
#
# Idempotent: guards entries are recognised by the path of guards.py, so re-running replaces
# them in place instead of duplicating; other hooks and settings are preserved untouched.
# A timestamped backup (settings.json.bak-guards-YYYYmmddHHMMSS) is written before any change.
# Claude Code only - Codex has no equivalent hooks API (see README.md).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
GUARDS_PY="$SCRIPT_DIR/guards.py"
SETTINGS="${HOME}/.claude/settings.json"
APPLY=0
ACTION=install

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --uninstall) ACTION=uninstall ;;
    --settings) shift; [ $# -gt 0 ] || { echo "install.sh: --settings needs a path" >&2; exit 2; }; SETTINGS="$1" ;;
    --settings=*) SETTINGS="${1#--settings=}" ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v python3 >/dev/null 2>&1 || { echo "install.sh: python3 is required" >&2; exit 1; }

exec python3 - "$ACTION" "$APPLY" "$SETTINGS" "$GUARDS_PY" <<'PY'
import json, os, shlex, shutil, sys, time

action, apply, settings_path, guards_py = sys.argv[1], sys.argv[2] == "1", sys.argv[3], sys.argv[4]
MARK = "guards.py"

def cmd(mode):
    return f"python3 {shlex.quote(guards_py)} {mode}"

WANT = {
    "PreToolUse": {"matcher": "Bash", "hooks": [{"type": "command", "command": cmd("pre"), "timeout": 10}]},
    "PostToolUse": {"matcher": "Bash", "hooks": [{"type": "command", "command": cmd("post"), "timeout": 10}]},
    "Stop": {"hooks": [{"type": "command", "command": cmd("stop"), "timeout": 15}]},
}

def is_ours(hook):
    c = hook.get("command", "") if isinstance(hook, dict) else ""
    return MARK in c and any(c.rstrip().endswith(" " + m) for m in ("pre", "post", "stop"))

def strip_ours(settings):
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return
    for event in list(hooks.keys()):
        groups = hooks[event]
        if not isinstance(groups, list):
            continue
        kept = []
        for g in groups:
            if isinstance(g, dict) and isinstance(g.get("hooks"), list):
                g = dict(g)
                g["hooks"] = [h for h in g["hooks"] if not is_ours(h)]
                if not g["hooks"]:
                    continue
            kept.append(g)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not hooks:
        del settings["hooks"]

original_text = None
if os.path.exists(settings_path):
    with open(settings_path, "r", encoding="utf-8") as fh:
        original_text = fh.read()
try:
    settings = json.loads(original_text) if original_text and original_text.strip() else {}
except ValueError as exc:
    sys.stderr.write(f"install.sh: {settings_path} is not valid JSON ({exc}); refusing to touch it\n")
    sys.exit(1)
if not isinstance(settings, dict):
    sys.stderr.write(f"install.sh: {settings_path} is not a JSON object; refusing to touch it\n")
    sys.exit(1)

before = json.dumps(settings, sort_keys=True)
strip_ours(settings)
if action == "install":
    hooks = settings.setdefault("hooks", {})
    for event, group in WANT.items():
        hooks.setdefault(event, []).append(group)
after = json.dumps(settings, sort_keys=True)
new_text = json.dumps(settings, indent=2, ensure_ascii=False) + "\n"

if before == after:
    print(f"guards: {settings_path} already {'has the guards hooks' if action == 'install' else 'has no guards hooks'}; nothing to do")
    sys.exit(0)

if not apply:
    print(f"# DRY RUN - {action} into {settings_path} would produce:\n")
    print(new_text)
    print("# Re-run with --apply to write it (a backup is made first).")
    sys.exit(0)

os.makedirs(os.path.dirname(os.path.abspath(settings_path)), exist_ok=True)
if original_text is not None:
    backup = f"{settings_path}.bak-guards-{time.strftime('%Y%m%d%H%M%S')}"
    n = 1
    while os.path.exists(backup):
        backup = f"{settings_path}.bak-guards-{time.strftime('%Y%m%d%H%M%S')}-{n}"
        n += 1
    shutil.copy2(settings_path, backup)
    print(f"guards: backup -> {backup}")
tmp = settings_path + ".tmp-guards"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write(new_text)
if original_text is not None:
    shutil.copymode(settings_path, tmp)  # keep e.g. 0600 on a settings file holding env secrets
os.replace(tmp, settings_path)
print(f"guards: {action} applied to {settings_path}")
PY
