#!/bin/bash
# watch-release.sh — Poll release workflow status.
#
# Blocks until every release-triggered workflow completes, exits early on
# the first failure, and exits 0 only when every workflow ended in
# `success` or `skipped`. Filters to runs triggered by `release` events
# (release.yml, docker-publish.yml, desktop-release.yml — not the docs
# deploy, which fires on `push`).
#
# Usage: ./scripts/watch-release.sh [-q] [TAG]
#
# Examples:
#   ./scripts/watch-release.sh -q v4.1.1
#   ./scripts/watch-release.sh                  # watches latest release
#
# The TAG argument is informational only — it appears in log lines and
# notifications. Workflow filtering is by `--event release`, so any release
# you publish will be monitored regardless of which tag you pass.
#
# Exit codes:
#   0 — all release workflows completed and none failed
#   1 — at least one release workflow failed / cancelled / timed_out
#       (returns as soon as that's observed — does not wait for the rest)
#   2 — usage / GitHub API error
#
# Flags:
#   -q   quiet — suppress per-cycle status output. Only the final summary
#        line is printed. Use this for programmatic exit-code consumption
#        (e.g. an LLM-driven release monitor) so the polling output
#        doesn't flood the consumer's context.
#
# Tunables (env vars):
#   WATCH_RELEASE_INTERVAL   poll interval in seconds (default 60)
#   WATCH_RELEASE_LIMIT      number of recent release-event runs to inspect
#                            (default 10)

set -euo pipefail

QUIET=false
if [[ "${1:-}" == "-q" || "${1:-}" == "--quiet" ]]; then
  QUIET=true
  shift
fi

TAG="${1:-}"
INTERVAL="${WATCH_RELEASE_INTERVAL:-60}"
LIMIT="${WATCH_RELEASE_LIMIT:-10}"

log() { $QUIET || echo "$@"; }

if [ -n "$TAG" ]; then
  log "Watching release workflows for tag: $TAG"
else
  log "Watching latest release workflows"
fi

log "Polling every ${INTERVAL}s (limit ${LIMIT})..."
log ""

# Treat anything other than `success` or `skipped` as a failure once a workflow
# is in `completed` state.
is_terminal_failure() {
  case "$1" in
    success|skipped) return 1 ;;
    *)               return 0 ;;
  esac
}

last_summary=""

while true; do
  TIMESTAMP=$(date '+%H:%M:%S')

  if ! RESULTS=$(gh run list --limit "$LIMIT" --event release \
                   --json databaseId,name,conclusion,status,createdAt \
                   -q '.[] | "\(.databaseId)|\(.name)|\(.status)|\(.conclusion)"' 2>&1); then
    echo "✗ gh run list failed: $RESULTS" >&2
    exit 2
  fi

  if [ -z "$RESULTS" ]; then
    log "[$TIMESTAMP] No release workflows found yet — waiting..."
    sleep "$INTERVAL"
    continue
  fi

  ALL_COMPLETE=true
  FAILED_NAME=""
  FAILED_CONCLUSION=""
  FAILED_ID=""
  summary=""

  while IFS='|' read -r ID NAME STATUS CONCLUSION; do
    [ -z "$NAME" ] && continue
    if [ "$STATUS" = "completed" ]; then
      if [ "$CONCLUSION" = "success" ]; then
        summary+=$'\n'"  ✓ $NAME"
      elif [ "$CONCLUSION" = "skipped" ]; then
        summary+=$'\n'"  ⊘ $NAME (skipped)"
      else
        summary+=$'\n'"  ✗ $NAME ($CONCLUSION) — gh run view $ID --log-failed"
        if [ -z "$FAILED_NAME" ] && is_terminal_failure "$CONCLUSION"; then
          FAILED_NAME="$NAME"
          FAILED_CONCLUSION="$CONCLUSION"
          FAILED_ID="$ID"
        fi
      fi
    else
      summary+=$'\n'"  ⏳ $NAME ($STATUS)"
      ALL_COMPLETE=false
    fi
  done <<< "$RESULTS"

  # Only print when the picture changes — keeps -q paths silent and
  # reduces noise for verbose paths too.
  if [ "$summary" != "$last_summary" ]; then
    log "[$TIMESTAMP] Release Workflows:$summary"
    log ""
    last_summary="$summary"
  fi

  # Fail fast — don't wait for the remaining workflows once one has failed.
  if [ -n "$FAILED_NAME" ]; then
    echo "✗ RELEASE FAILED — $FAILED_NAME ($FAILED_CONCLUSION). Inspect: gh run view $FAILED_ID --log-failed"
    if command -v notify-send &>/dev/null; then
      notify-send "Release Failed" "${TAG:-latest} — $FAILED_NAME" --urgency=critical 2>/dev/null || true
    fi
    exit 1
  fi

  if $ALL_COMPLETE; then
    echo "✓ RELEASE PASSED — all release workflows green${TAG:+ for $TAG}"
    if command -v notify-send &>/dev/null; then
      notify-send "Release Passed" "${TAG:-latest}" --urgency=normal 2>/dev/null || true
    fi
    exit 0
  fi

  sleep "$INTERVAL"
done
