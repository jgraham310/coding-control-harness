#!/bin/sh
# Install, inspect, or remove the cron entry that runs one CTO cycle.
#
#   scripts/schedule.sh install          every two hours, using `claude -p`
#   SCHEDULE="*/30 * * * *" ... install  a different cadence
#   AGENT="codex exec -" ... install     a different agent runner
#
# Idempotent: the marker comment is filtered out before the new line is added,
# so installing twice leaves one entry.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
SCHEDULE=${SCHEDULE:-"0 */2 * * *"}
AGENT=${AGENT:-"claude -p \"\$(cat $REPO/prompts/cycle.md)\""}
MARKER="# coding-control-harness:$REPO"
LINE="$SCHEDULE cd $REPO && $AGENT >> $REPO/ops/coding-control/cycle.log 2>&1 $MARKER"

case "${1:-install}" in
  plan)
    echo "$LINE"
    ;;
  install)
    { crontab -l 2>/dev/null | grep -vF "$MARKER" || true; echo "$LINE"; } | sed '/^$/d' | crontab -
    echo "installed: $LINE"
    ;;
  remove)
    { crontab -l 2>/dev/null | grep -vF "$MARKER" || true; } | sed '/^$/d' | crontab -
    echo "removed any entry marked $MARKER"
    ;;
  show)
    crontab -l 2>/dev/null | grep -F "$MARKER" || echo "not installed"
    ;;
  *)
    echo "usage: $0 [plan|install|show|remove]" >&2
    exit 1
    ;;
esac
