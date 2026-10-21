#!/usr/bin/env bash
set -euo pipefail

unit=aura-companion.service

systemctl is-enabled --quiet "$unit" || exit 0
state=$(systemctl show "$unit" --property=ActiveState --value)
[[ "$state" == failed ]] || exit 0
result=$(systemctl show "$unit" --property=Result --value)
printf '[aura-recover] recovering failed service (result=%s)\n' "$result"
systemctl reset-failed "$unit"
systemctl start "$unit"
