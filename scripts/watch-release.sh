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
#   WATCH_RELEASE_RETRIES    attempts per GitHub API call before giving up
#                            (default 3)
#   WATCH_RELEASE_BACKOFF    base seconds between retries, multiplied by attempt
#                            number for linear backoff (default 5)
#
# Transient API errors are retried rather than fatal. A single TLS handshake
# timeout killed a v4.13.3-rc3 release watch outright with exit 2; now only
# WATCH_RELEASE_RETRIES *consecutive* failures do. Retry notices go to stderr,
# so the stdout contract is unchanged for -q consumers — but a failing call is
# never silent.

set -euo pipefail

QUIET=false
if [[ "${1:-}" == "-q" || "${1:-}" == "--quiet" ]]; then
  QUIET=true
  shift
fi

TAG="${1:-}"
INTERVAL="${WATCH_RELEASE_INTERVAL:-60}"
LIMIT="${WATCH_RELEASE_LIMIT:-10}"
RETRIES="${WATCH_RELEASE_RETRIES:-3}"
BACKOFF="${WATCH_RELEASE_BACKOFF:-5}"

log() { $QUIET || echo "$@"; }

# Run a gh command, retrying transient failures with linear backoff. Prints the
# command's stdout on success (empty output is a valid success). On the final
# failure, reports the last error to stderr and returns 1.
#
# Progress and error notices go to STDERR deliberately: this runs inside a
# command substitution, so anything on stdout would be captured as data — and a
# retry that logged to stdout would silently corrupt the caller's results.
retry_api() {
  local attempt=1 out
  while :; do
    if out=$("$@" 2>&1); then
      printf '%s' "$out"
      return 0
    fi
    if [ "$attempt" -ge "$RETRIES" ]; then
      echo "✗ API call failed after $RETRIES attempts: $out" >&2
      return 1
    fi
    echo "[$(date '+%H:%M:%S')] transient API error (attempt $attempt/$RETRIES), retrying in $((attempt * BACKOFF))s: $out" >&2
    sleep "$((attempt * BACKOFF))"
    attempt=$((attempt + 1))
  done
}

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

  # Retried rather than fatal-on-first-error: release builds (multi-arch Docker,
  # Desktop, LXC) run long enough that a single network blip is expected, and
  # losing the watch to it is what pushes callers into hand-rolling their own.
  if ! RESULTS=$(retry_api gh run list --limit "$LIMIT" --event release \
                   --json databaseId,name,conclusion,status,createdAt \
                   -q '.[] | "\(.databaseId)|\(.name)|\(.status)|\(.conclusion)"'); then
    echo "✗ gh run list failed after $RETRIES attempts — giving up" >&2
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
