#!/bin/bash
# watch-ci.sh — Poll CI pipeline status for a PR or branch.
#
# Blocks until every workflow completes, exits early on the first failure
# (so an automated runner can stop waiting), and exits 0 only when every
# workflow ended in `success` or `skipped`.
#
# Usage: ./scripts/watch-ci.sh [-q] <PR_NUMBER|BRANCH_NAME>
#
# Exit codes:
#   0 — all workflows completed and none failed
#   1 — at least one workflow concluded with failure / cancelled / timed_out
#       (the script returns as soon as the failing workflow is observed —
#        it does NOT wait for the rest to finish)
#   2 — usage / GitHub API error
#
# Flags:
#   -q   quiet — suppress per-cycle status output. Only the final summary
#        line is printed. Use this when you intend to consume the exit
#        code programmatically (e.g. an LLM-driven CI monitor) so the
#        polling output doesn't flood the consumer's context.
#
# Tunables (env vars):
#   WATCH_CI_INTERVAL   poll interval in seconds (default 60)
#   WATCH_CI_LIMIT      number of recent runs to inspect (default 20)

set -euo pipefail

QUIET=false
if [[ "${1:-}" == "-q" || "${1:-}" == "--quiet" ]]; then
  QUIET=true
  shift
fi

TARGET="${1:?Usage: watch-ci.sh [-q] <PR_NUMBER|BRANCH_NAME>}"
INTERVAL="${WATCH_CI_INTERVAL:-60}"
LIMIT="${WATCH_CI_LIMIT:-20}"

log() { $QUIET || echo "$@"; }

if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  if ! BRANCH=$(gh pr view "$TARGET" --json headRefName -q .headRefName 2>/dev/null); then
    echo "✗ Could not resolve PR #$TARGET" >&2
    exit 2
  fi
  log "Watching CI for PR #$TARGET (branch: $BRANCH)"
else
  BRANCH="$TARGET"
  log "Watching CI for branch: $BRANCH"
fi

log "Polling every ${INTERVAL}s (limit ${LIMIT})..."
log ""

# Treat anything other than `success` or `skipped` as a failure once a workflow
# is in `completed` state. `cancelled` / `timed_out` / `action_required` /
# `neutral` should all stop the wait — they need human attention.
is_terminal_failure() {
  case "$1" in
    success|skipped) return 1 ;;
    *)               return 0 ;;
  esac
}

last_summary=""

while true; do
  TIMESTAMP=$(date '+%H:%M:%S')

  if ! RESULTS=$(gh run list --branch "$BRANCH" --limit "$LIMIT" \
                   --json name,conclusion,status \
                   -q '.[] | "\(.name)|\(.status)|\(.conclusion)"' 2>&1); then
    echo "✗ gh run list failed: $RESULTS" >&2
    exit 2
  fi

  if [ -z "$RESULTS" ]; then
    log "[$TIMESTAMP] No CI runs found for branch $BRANCH yet — waiting..."
    sleep "$INTERVAL"
    continue
  fi

  ALL_COMPLETE=true
  FAILED_NAME=""
  FAILED_CONCLUSION=""
  summary=""

  while IFS='|' read -r NAME STATUS CONCLUSION; do
    [ -z "$NAME" ] && continue
    if [ "$STATUS" = "completed" ]; then
      if [ "$CONCLUSION" = "success" ]; then
        summary+=$'\n'"  ✓ $NAME"
      elif [ "$CONCLUSION" = "skipped" ]; then
        summary+=$'\n'"  ⊘ $NAME (skipped)"
      else
        summary+=$'\n'"  ✗ $NAME ($CONCLUSION)"
        if [ -z "$FAILED_NAME" ] && is_terminal_failure "$CONCLUSION"; then
          FAILED_NAME="$NAME"
          FAILED_CONCLUSION="$CONCLUSION"
        fi
      fi
    else
      summary+=$'\n'"  ⏳ $NAME ($STATUS)"
      ALL_COMPLETE=false
    fi
  done <<< "$RESULTS"

  # Only emit per-cycle output when the picture changes — keeps -q paths
  # silent and reduces noise for verbose paths too.
  if [ "$summary" != "$last_summary" ]; then
    log "[$TIMESTAMP] CI Status:$summary"
    log ""
    last_summary="$summary"
  fi

  # Fail fast — don't wait for the remaining workflows once one has failed.
  if [ -n "$FAILED_NAME" ]; then
    echo "✗ CI FAILED — $FAILED_NAME ($FAILED_CONCLUSION). Inspect with: gh run view --log-failed --branch $BRANCH"
    if command -v notify-send &>/dev/null; then
      notify-send "CI Failed" "$FAILED_NAME on $BRANCH" --urgency=critical 2>/dev/null || true
    fi
    exit 1
  fi

  if $ALL_COMPLETE; then
    echo "✓ CI PASSED — all checks green on $BRANCH"
    if command -v notify-send &>/dev/null; then
      notify-send "CI Passed" "Branch: $BRANCH" --urgency=normal 2>/dev/null || true
    fi
    exit 0
  fi

  sleep "$INTERVAL"
done
