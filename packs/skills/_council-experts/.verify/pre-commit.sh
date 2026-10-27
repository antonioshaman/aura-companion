#!/usr/bin/env bash
# Tracked body of the repository's pre-commit gate.
#
# `.git/hooks/pre-commit` is a thin caller of this file. The split exists because
# `.git/hooks/` is outside version control: a hook that lives only there does not
# survive a re-clone and is not reviewable as code, so the gate configuration
# would be invisible in exactly the repository whose integrity it attests.
#
# Until this file existed, `verify-catalog.sh` had no enforcement point at all —
# no CI, no remote, and the one hook that did fire checked only the committer's
# email address. Every tamper-evidence guarantee in the catalog was therefore
# conditional on the person making the edit remembering to type the command.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

REQUIRED_EMAIL="anton@shmonin.ru"
CURRENT_EMAIL="$(git config user.email)"

if [ "$CURRENT_EMAIL" != "$REQUIRED_EMAIL" ]; then
  echo "❌ Wrong git user.email: $CURRENT_EMAIL"
  echo "✅ Required email: $REQUIRED_EMAIL"
  echo ""
  echo "Fix:"
  echo "git config user.email \"$REQUIRED_EMAIL\""
  exit 1
fi

if [ ! -x "$HERE/verify-catalog.sh" ]; then
  echo "❌ pre-commit: $HERE/verify-catalog.sh is missing or not executable."
  echo "   The catalog gate cannot run, so this commit is refused rather than"
  echo "   allowed through unverified."
  exit 1
fi

if ! "$HERE/verify-catalog.sh"; then
  echo ""
  echo "❌ pre-commit: catalog canaries failed (see ✗ lines above). Commit refused."
  echo "   To inspect: $HERE/verify-catalog.sh"
  exit 1
fi

exit 0
