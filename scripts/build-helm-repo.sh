#!/usr/bin/env bash
#
# Package the MeshMonitor Helm chart and build a classic chart-repository
# index under docs/public/charts/. VitePress serves docs/public/ at the site
# root, so the result is published to https://meshmonitor.org/charts and users
# can `helm repo add meshmonitor https://meshmonitor.org/charts`.
#
# Run by the Deploy Documentation workflow (.github/workflows/deploy-docs.yml)
# before the VitePress build. Requires `helm` and `git` on PATH, and a checkout
# with full history + tags (the workflow uses fetch-depth: 0).
#
# See issues #3431, #4335, #5119.
set -euo pipefail

REPO_URL="${HELM_REPO_URL:-https://meshmonitor.org/charts}"
CHART_DIR="helm/meshmonitor"
CHART_NAME="meshmonitor"
OUT_DIR="docs/public/charts"

if ! command -v helm >/dev/null 2>&1; then
  echo "error: helm is not installed (needed to build the chart repository)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "==> Linting chart"
helm lint "$CHART_DIR"

echo "==> Packaging chart into $OUT_DIR"
helm package "$CHART_DIR" --destination "$OUT_DIR"

# $OUT_DIR (docs/public/charts/) is gitignored and rebuilt from a clean
# checkout on every run, so it only ever contains the chart version just
# packaged above — while actions/deploy-pages REPLACES the whole published site
# with the uploaded artifact rather than adding to it.
#
# #4335 fixed half of this by merging the published index.yaml so previously
# released versions kept being listed. But the archives those entries point at
# were never re-uploaded, so every one of them 404'd while the index went on
# advertising them (#5119). Listing a chart you cannot download is worse than
# not listing it: `helm repo add` succeeds and `helm install` then fails.
#
# The fix is to make the published directory self-consistent — every version the
# index names must be a file we are about to upload — and then generate the
# index straight from that directory. So, for each archive the currently
# published index references:
#
#   * fetch it from the live site (the common case; byte-identical, so its
#     digest is unchanged),
#   * or, if it is genuinely gone (404), rebuild it from its release tag,
#   * or, failing both, drop it — the index simply stops advertising a file
#     nobody can download.
#
# Anything other than 200/404 is treated as "cannot reach the site", not "gone",
# and fails the run: quietly dropping every released version because of a
# transient 5xx is the #4335 regression, and a failed deploy is recoverable in a
# way an overwritten index is not.
EXISTING_INDEX="$(mktemp)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$EXISTING_INDEX" "$WORK_DIR"' EXIT

#
# Distinguish "no index published yet" from "could not reach the index": both
# are non-2xx as far as `curl -f` is concerned, but only the first is safe to
# proceed from. See the note above on why a transient failure must not become a
# fresh, single-entry index.
echo "==> Fetching the currently published index ($REPO_URL/index.yaml)"
# curl still writes %{http_code} (as 000) when it never got a response, so do
# not append a fallback code here — that would report a doubled "000000".
HTTP_CODE="$(curl -sSL -w '%{http_code}' -o "$EXISTING_INDEX" "$REPO_URL/index.yaml" || true)"
HTTP_CODE="${HTTP_CODE:-000}"

case "$HTTP_CODE" in
  200)
    echo "==> Reconciling previously published chart archives"
    ;;
  404)
    echo "==> No existing published index found; nothing to reconcile"
    : > "$EXISTING_INDEX"
    ;;
  *)
    echo "error: could not fetch $REPO_URL/index.yaml (HTTP $HTTP_CODE)." >&2
    echo "       Refusing to publish an index that would drop already-released chart versions (#4335)." >&2
    echo "       Re-run the deploy once the chart repository is reachable again." >&2
    exit 1
    ;;
esac

# Rebuild one released version's archive from its git tag. Used when the live
# site no longer serves it. The regenerated tarball is byte-for-byte unrelated
# to the original, so its digest differs from the one the old index recorded —
# which is fine, because the index is regenerated from these files rather than
# merged from the stale one.
repackage_from_tag() {
  local version="$1" tag="v$1" dest="$2"
  if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    return 1
  fi
  local src="$WORK_DIR/$version"
  rm -rf "$src"
  mkdir -p "$src"
  # Only the chart directory — a full worktree checkout is unnecessary and slow.
  if ! git archive "$tag" "$CHART_DIR" 2>/dev/null | tar -x -C "$src"; then
    return 1
  fi
  [[ -f "$src/$CHART_DIR/Chart.yaml" ]] || return 1
  helm package "$src/$CHART_DIR" --destination "$OUT_DIR" >/dev/null || return 1
  # helm names the file from Chart.yaml's own version; if the tag and the chart
  # version ever disagreed, we did not produce the file the index asked for.
  [[ -f "$dest" ]]
}

RECOVERED=0
REBUILT=0
DROPPED=()

if [[ -s "$EXISTING_INDEX" ]]; then
  # One URL per referenced archive. `sort -u` because a version can legitimately
  # be listed with several mirror URLs.
  readarray -t EXISTING_CHART_URLS < <(grep -oE 'https?://[^"'"'"'[:space:]]+\.tgz' "$EXISTING_INDEX" | sort -u)
  for url in "${EXISTING_CHART_URLS[@]:-}"; do
    [[ -z "$url" ]] && continue
    filename="$(basename "$url")"
    dest="$OUT_DIR/$filename"
    # The version just packaged above is already here.
    [[ -f "$dest" ]] && continue

    # Download to a temp file first and only rename it into place on success,
    # so an interrupted run can never leave a truncated .tgz at $dest. The temp
    # file lives in $WORK_DIR, not $OUT_DIR, so it's covered by the EXIT trap
    # above even if the script dies before reaching the case statement below —
    # $OUT_DIR is uploaded wholesale, so nothing must land there but on success.
    tmp_dest="$(mktemp "$WORK_DIR/download.XXXXXX")"
    code="$(curl -sSL -w '%{http_code}' -o "$tmp_dest" "$url" || true)"
    code="${code:-000}"
    case "$code" in
      200)
        mv "$tmp_dest" "$dest"
        RECOVERED=$((RECOVERED + 1))
        continue
        ;;
      404)
        rm -f "$tmp_dest"
        ;;
      *)
        rm -f "$tmp_dest"
        echo "error: fetching $url returned HTTP $code (neither 200 nor 404)." >&2
        echo "       Treating that as 'cannot reach the site', not 'archive is gone' — dropping" >&2
        echo "       released versions on a transient failure is exactly the #4335 regression." >&2
        exit 1
        ;;
    esac

    # 404: the archive really is missing from the published site. Rebuild it
    # from its release tag so the version stays installable.
    version="${filename#${CHART_NAME}-}"
    version="${version%.tgz}"
    if repackage_from_tag "$version" "$dest"; then
      echo "    -> rebuilt $filename from tag v$version"
      REBUILT=$((REBUILT + 1))
    else
      rm -f "$dest"
      DROPPED+=("$version")
    fi
  done
fi

echo "==> Archives: $RECOVERED re-fetched, $REBUILT rebuilt from tags"
if [[ ${#DROPPED[@]} -gt 0 ]]; then
  echo "warning: dropping ${#DROPPED[@]} version(s) with no downloadable archive and no usable release tag:" >&2
  printf '           %s\n' "${DROPPED[@]}" >&2
  echo "         They will no longer be listed in index.yaml. This is deliberate — an index" >&2
  echo "         entry whose .tgz 404s breaks 'helm install' for anyone who selects it." >&2
fi

# Generate the index from the directory rather than merging the published one.
# $OUT_DIR now holds every archive that should be downloadable, so a
# directory-derived index cannot reference a file the upload does not contain —
# the invariant #5119 was about. Digests are recomputed from the actual bytes,
# so a re-fetched archive keeps its original digest and a rebuilt one gets a
# correct new digest instead of the stale one the old index recorded.
echo "==> Generating repository index (url: $REPO_URL)"
helm repo index "$OUT_DIR" --url "$REPO_URL"

echo "==> Helm repository contents:"
ls -la "$OUT_DIR"
