#!/usr/bin/env bash
#
# Package the MeshMonitor Helm chart and build a classic chart-repository
# index under docs/public/charts/. VitePress serves docs/public/ at the site
# root, so the result is published to https://meshmonitor.org/charts and users
# can `helm repo add meshmonitor https://meshmonitor.org/charts`.
#
# Run by the Deploy Documentation workflow (.github/workflows/deploy-docs.yml)
# before the VitePress build. Requires `helm` on PATH.
#
# See issue #3431.
set -euo pipefail

REPO_URL="${HELM_REPO_URL:-https://meshmonitor.org/charts}"
CHART_DIR="helm/meshmonitor"
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
# packaged above. Without merging in the index already live at $REPO_URL,
# `helm repo index` would overwrite the published index.yaml with a
# single-entry index, deleting every previously released version from the
# repo (#4335). Fetch the current published index, if any, and merge it in.
EXISTING_INDEX="$(mktemp)"
trap 'rm -f "$EXISTING_INDEX"' EXIT

#
# Distinguish "no index published yet" from "could not reach the index": both
# are non-2xx as far as `curl -f` is concerned, but only the first is safe to
# proceed from. Regenerating a fresh index after a transient DNS/5xx/TLS
# failure would silently reintroduce #4335 and drop every released version,
# while exiting 0. A failed deploy is recoverable by re-running; an
# overwritten index is visible to everyone running `helm repo update`, so we
# fail loudly instead.
echo "==> Generating repository index (url: $REPO_URL)"
# curl still writes %{http_code} (as 000) when it never got a response, so do
# not append a fallback code here — that would report a doubled "000000".
HTTP_CODE="$(curl -sSL -w '%{http_code}' -o "$EXISTING_INDEX" "$REPO_URL/index.yaml" || true)"
HTTP_CODE="${HTTP_CODE:-000}"

case "$HTTP_CODE" in
  200)
    echo "==> Merging with existing published index ($REPO_URL/index.yaml)"
    helm repo index "$OUT_DIR" --url "$REPO_URL" --merge "$EXISTING_INDEX"

    # $OUT_DIR only holds the .tgz just packaged above; the merged index.yaml
    # also references every previously released version's .tgz, which lives
    # nowhere in this checkout. actions/deploy-pages replaces the whole
    # published site with the uploaded artifact rather than adding to it, so
    # any referenced archive missing from $OUT_DIR silently disappears from
    # the live site even though the index still lists it (#5119, a follow-on
    # to the index-only fix in #4335). Re-fetch each previously published
    # archive that isn't already present so it survives this deploy too.
    echo "==> Fetching previously published chart archives referenced in the index"
    readarray -t EXISTING_CHART_URLS < <(grep -oE 'https?://[^"'"'"'[:space:]]+\.tgz' "$EXISTING_INDEX" | sort -u)
    for url in "${EXISTING_CHART_URLS[@]:-}"; do
      [[ -z "$url" ]] && continue
      filename="$(basename "$url")"
      dest="$OUT_DIR/$filename"
      if [[ -f "$dest" ]]; then
        continue
      fi
      echo "    -> downloading $filename"
      if ! curl -sSL -f -o "$dest" "$url"; then
        echo "error: failed to download previously published chart archive $url" >&2
        echo "       Refusing to publish an index that references an archive we could not fetch." >&2
        exit 1
      fi
    done
    ;;
  404)
    echo "==> No existing published index found at $REPO_URL/index.yaml; generating fresh index"
    helm repo index "$OUT_DIR" --url "$REPO_URL"
    ;;
  *)
    echo "error: could not fetch $REPO_URL/index.yaml (HTTP $HTTP_CODE)." >&2
    echo "       Refusing to publish an index that would drop already-released chart versions (#4335)." >&2
    echo "       Re-run the deploy once the chart repository is reachable again." >&2
    exit 1
    ;;
esac

echo "==> Helm repository contents:"
ls -la "$OUT_DIR"
