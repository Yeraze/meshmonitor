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

echo "==> Generating repository index (url: $REPO_URL)"
if curl -fsSL "$REPO_URL/index.yaml" -o "$EXISTING_INDEX"; then
  echo "==> Merging with existing published index ($REPO_URL/index.yaml)"
  helm repo index "$OUT_DIR" --url "$REPO_URL" --merge "$EXISTING_INDEX"
else
  echo "==> No existing published index found at $REPO_URL/index.yaml; generating fresh index"
  helm repo index "$OUT_DIR" --url "$REPO_URL"
fi

echo "==> Helm repository contents:"
ls -la "$OUT_DIR"
