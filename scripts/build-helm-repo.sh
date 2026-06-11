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

echo "==> Generating repository index (url: $REPO_URL)"
helm repo index "$OUT_DIR" --url "$REPO_URL"

echo "==> Helm repository contents:"
ls -la "$OUT_DIR"
