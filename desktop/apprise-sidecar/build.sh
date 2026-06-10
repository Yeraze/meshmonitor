#!/usr/bin/env bash
#
# Build the frozen Apprise sidecar binary for the MeshMonitor desktop bundle.
#
# Produces a single self-contained executable (no system Python required) and
# copies it into desktop/resources/binaries/ where the Tauri bundle picks it up
# alongside the Node sidecar. Run on the target platform — PyInstaller does not
# cross-compile, so macOS/Windows/Linux each build their own binary in CI.
#
# Usage:  ./build.sh            (from anywhere; paths are resolved relative to this script)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
DEST_DIR="${SCRIPT_DIR}/../resources/binaries"

echo "==> Creating build venv at ${VENV_DIR}"
python3 -m venv "${VENV_DIR}"
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

echo "==> Installing build dependencies (apprise + pyinstaller)"
python3 -m pip install --upgrade pip >/dev/null
python3 -m pip install -r "${SCRIPT_DIR}/requirements.txt"

echo "==> Freezing apprise-api.py with PyInstaller"
cd "${SCRIPT_DIR}"
rm -rf build dist
pyinstaller --clean --noconfirm apprise-api.spec

mkdir -p "${DEST_DIR}"
cp "dist/apprise-api" "${DEST_DIR}/apprise-api"
chmod +x "${DEST_DIR}/apprise-api"

SIZE="$(du -h "${DEST_DIR}/apprise-api" | cut -f1)"
echo "==> Done. apprise-api (${SIZE}) -> ${DEST_DIR}/apprise-api"
