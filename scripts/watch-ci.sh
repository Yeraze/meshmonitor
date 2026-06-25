#!/bin/bash
# watch-ci.sh — Poll CI pipeline status for a PR or branch.
#
# Blocks until every workflow completes, exits early on the first failure
# (so an automated runner can stop waiting), and exits 0 only when every
# workflow ended in `success` or `skipped`.
#
# Only runs for the target's CURRENT head commit are inspected. The tip SHA is
# re-resolved every poll cycle (so a push mid-watch is picked up), and runs for
# superseded commits are ignored. Without this, a fixed-and-repushed branch
# keeps reporting the OLD commit's failure forever, because `gh run list
# --branch` returns runs for every commit ever pushed to the branch.
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

PR_NUMBER=""
if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  PR_NUMBER="$TARGET"
  if ! BRANCH=$(gh pr view "$TARGET" --json headRefName -q .headRefName 2>/dev/null); then
    echo "✗ Could not resolve PR #$TARGET" >&2
    exit 2
  fi
  log "Watching CI for PR #$TARGET (branch: $BRANCH)"
else
  BRANCH="$TARGET"
  log "Watching CI for branch: $BRANCH"
fi

# Repo (owner/name) is needed to resolve a plain branch's tip commit via the API
# (a PR resolves its tip from headRefOid instead, so REPO is optional there).
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
if [[ -z "$PR_NUMBER" && -z "$REPO" ]]; then
  echo "✗ Could not resolve repository for branch $BRANCH" >&2
  exit 2
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

# Resolve the target's CURRENT head commit SHA, so only runs for the tip are
# inspected (not stale runs from superseded commits). A PR reports its tip
# directly via headRefOid (fork-safe); a plain branch is resolved through the
# commits API. Prints nothing and returns non-zero on failure so the caller can
# fall back to the last known tip during a transient API hiccup.
resolve_sha() {
  if [ -n "$PR_NUMBER" ]; then
    gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid 2>/dev/null
  else
    gh api "repos/$REPO/commits/$BRANCH" -q .sha 2>/dev/null
  fi
}

last_summary=""
LAST_SHA=""

while true; do
  TIMESTAMP=$(date '+%H:%M:%S')

  # Re-resolve the tip each cycle so a new push is tracked automatically. On a
  # transient resolution failure, reuse the last known tip rather than crashing.
  HEAD_SHA=$(resolve_sha || true)
  if [ -z "$HEAD_SHA" ]; then
    if [ -n "$LAST_SHA" ]; then
      HEAD_SHA="$LAST_SHA"
    else
      log "[$TIMESTAMP] Could not resolve head SHA for $BRANCH yet — waiting..."
      sleep "$INTERVAL"
      continue
    fi
  fi
  LAST_SHA="$HEAD_SHA"

  # Only consider runs whose headSha matches the current tip. (gh run list has
  # no commit filter, so filter in jq. HEAD_SHA is a hex OID — safe to splice.)
  if ! RESULTS=$(gh run list --branch "$BRANCH" --limit "$LIMIT" \
                   --json name,conclusion,status,headSha \
                   -q ".[] | select(.headSha == \"$HEAD_SHA\") | \"\(.name)|\(.status)|\(.conclusion)\"" 2>&1); then
    echo "✗ gh run list failed: $RESULTS" >&2
    exit 2
  fi

  if [ -z "$RESULTS" ]; then
    log "[$TIMESTAMP] No CI runs for $BRANCH @ ${HEAD_SHA:0:8} yet — waiting..."
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
    echo "✗ CI FAILED — $FAILED_NAME ($FAILED_CONCLUSION) on $BRANCH @ ${HEAD_SHA:0:8}. Inspect with: gh run list --branch $BRANCH (then: gh run view <id> --log-failed)"
    if command -v notify-send &>/dev/null; then
      notify-send "CI Failed" "$FAILED_NAME on $BRANCH" --urgency=critical 2>/dev/null || true
    fi
    exit 1
  fi

  if $ALL_COMPLETE; then
    echo "✓ CI PASSED — all checks green on $BRANCH @ ${HEAD_SHA:0:8}"
    if command -v notify-send &>/dev/null; then
      notify-send "CI Passed" "Branch: $BRANCH" --urgency=normal 2>/dev/null || true
    fi
    exit 0
  fi

  sleep "$INTERVAL"
done
