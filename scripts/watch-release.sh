#!/bin/bash
# watch-release.sh — Poll release workflow status
# Usage: ./scripts/watch-release.sh [TAG]
#
# Examples:
#   ./scripts/watch-release.sh v3.10.0-RC1
#   ./scripts/watch-release.sh              # watches latest release workflows

set -euo pipefail

TAG="${1:-}"
INTERVAL=60

if [ -n "$TAG" ]; then
  echo "Watching release workflows for tag: $TAG"
else
  echo "Watching latest release workflows"
fi

echo "Polling every ${INTERVAL}s..."
echo ""

while true; do
  TIMESTAMP=$(date '+%H:%M:%S')

  RESULTS=$(gh run list --limit 6 --event release --json name,conclusion,status,databaseId,createdAt \
    -q '.[:3] | .[] | "\(.databaseId)|\(.name)|\(.status)|\(.conclusion)"' 2>/dev/null)

  if [ -z "$RESULTS" ]; then
    echo "[$TIMESTAMP] No release workflows found"
    sleep "$INTERVAL"
    continue
  fi

  ALL_COMPLETE=true
  ANY_FAILED=false
  SUMMARY=""

  echo "[$TIMESTAMP] Release Workflows:"
  while IFS='|' read -r ID NAME STATUS CONCLUSION; do
    if [ "$STATUS" = "completed" ]; then
      if [ "$CONCLUSION" = "success" ]; then
        echo "  ✓ $NAME"
        SUMMARY="$SUMMARY ✓"
      elif [ "$CONCLUSION" = "skipped" ]; then
        echo "  ⊘ $NAME (skipped)"
      else
        echo "  ✗ $NAME ($CONCLUSION) — gh run view $ID --log-failed"
        ANY_FAILED=true
        SUMMARY="$SUMMARY ✗"
      fi
    else
      echo "  ⏳ $NAME ($STATUS)"
      ALL_COMPLETE=false
      SUMMARY="$SUMMARY ⏳"
    fi
  done <<< "$RESULTS"
  echo ""

  if $ALL_COMPLETE; then
    echo "═══════════════════════════════════"
    if $ANY_FAILED; then
      echo "✗ RELEASE WORKFLOWS FAILED"
      echo ""
      echo "Check failures with:"
      gh run list --limit 3 --event release --json name,conclusion,databaseId \
        -q '.[] | select(.conclusion == "failure") | "  gh run view \(.databaseId) --log-failed  # \(.name)"' 2>/dev/null
    else
      echo "✓ ALL RELEASE WORKFLOWS PASSED"
    fi
    echo "═══════════════════════════════════"

    if command -v notify-send &>/dev/null; then
      if $ANY_FAILED; then
        notify-send "Release Failed" "${TAG:-latest}" --urgency=critical 2>/dev/null || true
      else
        notify-send "Release Passed" "${TAG:-latest}" --urgency=normal 2>/dev/null || true
      fi
    fi

    exit $($ANY_FAILED && echo 1 || echo 0)
  fi

  sleep "$INTERVAL"
done
