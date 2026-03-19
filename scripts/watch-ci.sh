#!/bin/bash
# watch-ci.sh — Poll CI pipeline status for a PR or branch
# Usage: ./scripts/watch-ci.sh [PR_NUMBER|BRANCH_NAME]

set -euo pipefail

TARGET="${1:?Usage: watch-ci.sh <PR_NUMBER|BRANCH_NAME>}"
INTERVAL=60

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
  RESULTS=$(gh run list --branch "$BRANCH" --limit 4 --json name,conclusion,status \
    -q '.[] | "\(.name)|\(.status)|\(.conclusion)"' 2>/dev/null)

  if [ -z "$RESULTS" ]; then
    echo "[$TIMESTAMP] No CI runs found for branch $BRANCH"
    sleep "$INTERVAL"
    continue
  fi

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

  if $ALL_COMPLETE; then
    echo "═══════════════════════════════════"
    if $ANY_FAILED; then
      echo "✗ CI FAILED — check logs with: gh run list --branch $BRANCH"
    else
      echo "✓ CI PASSED — all checks green"
    fi
    echo "═══════════════════════════════════"

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
