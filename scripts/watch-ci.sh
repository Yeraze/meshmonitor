#!/bin/bash
# watch-ci.sh — Poll CI pipeline status for a PR or branch
# Usage: ./scripts/watch-ci.sh [PR_NUMBER|BRANCH_NAME]
#
# Examples:
#   ./scripts/watch-ci.sh 2325        # Watch PR #2325
#   ./scripts/watch-ci.sh main        # Watch latest run on main

set -euo pipefail

TARGET="${1:?Usage: watch-ci.sh <PR_NUMBER|BRANCH_NAME>}"
INTERVAL=60

# Determine if target is a PR number or branch name
if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  BRANCH=$(gh pr view "$TARGET" --json headRefName -q .headRefName)
  echo "Watching CI for PR #$TARGET (branch: $BRANCH)"
else
  BRANCH="$TARGET"
  echo "Watching CI for branch: $BRANCH"
fi

echo "Polling every ${INTERVAL}s..."
echo ""

while true; do
  TIMESTAMP=$(date '+%H:%M:%S')

  # Get all check runs for this branch
  RESULTS=$(gh run list --branch "$BRANCH" --limit 4 --json name,conclusion,status \
    -q '.[] | "\(.name)|\(.status)|\(.conclusion)"' 2>/dev/null)

  if [ -z "$RESULTS" ]; then
    echo "[$TIMESTAMP] No CI runs found for branch $BRANCH"
    sleep "$INTERVAL"
    continue
  fi

  # Parse results
  ALL_COMPLETE=true
  ANY_FAILED=false

  echo "[$TIMESTAMP] CI Status:"
  while IFS='|' read -r NAME STATUS CONCLUSION; do
    if [ "$STATUS" = "completed" ]; then
      if [ "$CONCLUSION" = "success" ]; then
        echo "  ✓ $NAME"
      elif [ "$CONCLUSION" = "skipped" ]; then
        echo "  ⊘ $NAME (skipped)"
      else
        echo "  ✗ $NAME ($CONCLUSION)"
        ANY_FAILED=true
      fi
    else
      echo "  ⏳ $NAME ($STATUS)"
      ALL_COMPLETE=false
    fi
  done <<< "$RESULTS"
  echo ""

  # If all complete, show summary and exit
  if $ALL_COMPLETE; then
    echo "═══════════════════════════════════"
    if $ANY_FAILED; then
      echo "✗ CI FAILED — check logs with: gh run list --branch $BRANCH"
    else
      echo "✓ CI PASSED — all checks green"
    fi
    echo "═══════════════════════════════════"

    # Desktop notification (if notify-send available)
    if command -v notify-send &>/dev/null; then
      if $ANY_FAILED; then
        notify-send "CI Failed" "Branch: $BRANCH" --urgency=critical
      else
        notify-send "CI Passed" "Branch: $BRANCH" --urgency=normal
      fi
    fi

    exit $($ANY_FAILED && echo 1 || echo 0)
  fi

  sleep "$INTERVAL"
done
