#!/bin/bash
# watch-release.sh — Poll release workflow status.
#
# Blocks until every release-triggered workflow for TAG completes, exits early
# on the first failure, and exits 0 only when every workflow ended in
# `success` or `skipped`.
#
# Usage: ./scripts/watch-release.sh [-q] [TAG]
#
# Examples:
#   ./scripts/watch-release.sh -q v4.1.1
#   ./scripts/watch-release.sh                  # watches the latest release
#
# Runs are matched to TAG by COMMIT, not by workflow name. The tag is resolved
# to its commit SHA, runs are listed with `gh run list --commit <sha>`, and only
# `release`-event runs are kept, newest per workflow name (a re-created release
# leaves an older run of the same workflow on the same commit).
#
# Why: the old version listed the last N `--event release` runs across ALL
# releases and ignored TAG. Right after `gh release create`, the new tag's runs
# had not registered yet, so the previous release's finished runs were read as
# "all green" (v4.16.2-rc2 and rc3 both reported a false pass). `gh run list
# --event release` was also observed returning stale pages that omitted recent
# releases entirely.
#
# A PASS also requires every expected workflow to have registered a run. The
# expected set is every workflow in .github/workflows whose `on:` block has a
# `release:` trigger (override with WATCH_RELEASE_EXPECTED="Name A,Name B"), so
# a PASS can't be declared while some release workflows haven't started yet.
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
#   WATCH_RELEASE_LIMIT      runs to list for the tag's commit (default 50)
#   WATCH_RELEASE_EXPECTED   comma-separated workflow names that must all
#                            register before a PASS (default: parsed from
#                            .github/workflows `on: release` triggers)
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
LIMIT="${WATCH_RELEASE_LIMIT:-50}"
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

if [ -z "$TAG" ]; then
  if ! TAG=$(retry_api gh release list --limit 1 --json tagName -q '.[0].tagName') || [ -z "$TAG" ]; then
    echo "✗ Could not determine the latest release tag" >&2
    exit 2
  fi
fi

if ! SHA=$(retry_api gh api "repos/{owner}/{repo}/commits/$TAG" -q .sha) || [ -z "$SHA" ]; then
  echo "✗ Could not resolve tag $TAG to a commit (does the release/tag exist?)" >&2
  exit 2
fi

# Workflows that must each register a run before a PASS can be declared.
EXPECTED=()
if [ -n "${WATCH_RELEASE_EXPECTED:-}" ]; then
  IFS=',' read -r -a EXPECTED <<< "$WATCH_RELEASE_EXPECTED"
else
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo .)
  for wf in "$REPO_ROOT"/.github/workflows/*.yml "$REPO_ROOT"/.github/workflows/*.yaml; do
    [ -f "$wf" ] || continue
    # `release:` as a direct child of the top-level `on:` block.
    if awk '/^on:/{on=1;next} on&&/^[^[:space:]#]/{on=0} on&&/^  release:/{found=1} END{exit !found}' "$wf"; then
      name=$(awk -F': *' '/^name:/{sub(/^name: */,""); gsub(/^["\x27]|["\x27]$/,""); print; exit}' "$wf")
      [ -n "$name" ] && EXPECTED+=("$name")
    fi
  done
fi

log "Watching release workflows for tag: $TAG (commit ${SHA:0:8})"
if [ "${#EXPECTED[@]}" -gt 0 ]; then
  log "Expecting: $(IFS=', '; echo "${EXPECTED[*]}")"
else
  log "No expected workflow list found — will pass once every registered run is green"
fi
log "Polling every ${INTERVAL}s..."
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
last_missing=""

while true; do
  TIMESTAMP=$(date '+%H:%M:%S')

  # Retried rather than fatal-on-first-error: release builds (multi-arch Docker,
  # Desktop, LXC) run long enough that a single network blip is expected, and
  # losing the watch to it is what pushes callers into hand-rolling their own.
  # Newest release-event run per workflow name, for this tag's commit only.
  if ! RESULTS=$(retry_api gh run list --commit "$SHA" --limit "$LIMIT" \
                   --json databaseId,name,event,conclusion,status,createdAt \
                   -q '[.[] | select(.event == "release")] | group_by(.name) | map(max_by(.createdAt)) | .[] | "\(.databaseId)|\(.name)|\(.status)|\(.conclusion)"'); then
    echo "✗ gh run list failed after $RETRIES attempts — giving up" >&2
    exit 2
  fi

  if [ -z "$RESULTS" ]; then
    log "[$TIMESTAMP] No release workflows for ${SHA:0:8} yet — waiting..."
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

  # A workflow that hasn't registered a run yet is not complete.
  MISSING=()
  for exp in "${EXPECTED[@]}"; do
    grep -qF "|$exp|" <<< "$RESULTS" || MISSING+=("$exp")
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    ALL_COMPLETE=false
    missing_note="  … not started yet: $(IFS=', '; echo "${MISSING[*]}")"
    if [ "$missing_note" != "${last_missing:-}" ]; then
      log "[$TIMESTAMP]$missing_note"
      last_missing="$missing_note"
    fi
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
