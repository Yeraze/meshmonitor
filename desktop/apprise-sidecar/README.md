# Desktop Apprise Sidecar

The desktop (Tauri) bundle ships the Node backend but no system Python, so the
[Apprise](https://github.com/caronc/apprise) notification engine — which the
Docker image runs as a Python sidecar — isn't available out of the box. This
directory builds Apprise into a **single self-contained executable** (via
PyInstaller) that the desktop app launches alongside the Node backend, giving
desktop users full Apprise notification support with no Python install.

## How it fits together

```
┌─────────────────────────── MeshMonitor.app ───────────────────────────┐
│  Tauri (Rust)                                                          │
│    ├─ spawns  binaries/node  ── runs ──►  dist/server/server.js        │
│    │            ▲ env: APPRISE_URL=http://127.0.0.1:<port>             │
│    └─ spawns  binaries/apprise-api  (frozen Apprise HTTP API)          │
│                 listening on 127.0.0.1:<random free port>             │
└───────────────────────────────────────────────────────────────────────┘
```

1. **Build** — `build.sh` / `build.ps1` freeze `../../docker/apprise-api.py`
   (stdlib `http.server` + `apprise`) into `apprise-api[.exe]` and drop it into
   `../resources/binaries/`, next to the bundled `node` binary.
2. **Launch** — `desktop/src-tauri/src/lib.rs::start_apprise()` finds the binary
   in the Tauri resource dir, picks a free loopback port, and spawns it with
   `APPRISE_HOST=127.0.0.1` (loopback only — never exposed to the LAN).
3. **Wire** — the chosen `http://127.0.0.1:<port>` URL is stored in
   `BackendState` and injected into the Node backend as `APPRISE_URL`, which the
   server's `appriseNotificationService` already honors. The sidecar is started
   once and kept alive across Node backend restarts.

The HTTP contract the Node side depends on is tiny: `GET /health`,
`GET /urls`, `POST /config`, `POST /notify {title, body, type, urls}`. The same
`docker/apprise-api.py` serves both the Docker container and the frozen desktop
sidecar, so notification behavior stays identical across deployments.

## Building locally

Requires Python 3.10+ on the target platform (PyInstaller does **not**
cross-compile — build each OS/arch on its own machine).

```bash
# Linux / macOS
./build.sh

# Windows (PowerShell)
./build.ps1
```

Output: `desktop/resources/binaries/apprise-api[.exe]`
(`desktop/resources/` is gitignored — the binary is produced fresh per build).

Approximate frozen size: **~18 MB** (Linux x64, Python 3.14). Windows and macOS
are in the same ballpark.

## CI integration

Both `desktop-ci.yml` and `desktop-release.yml` run a **Setup Python** +
**Build Apprise sidecar** step before the Tauri build, on the platforms where
PyInstaller can produce a native binary:

| Job              | Runner          | Apprise bundled? |
|------------------|-----------------|------------------|
| `build-windows`  | windows-latest  | ✅ (win x64)     |
| `build-macos`    | macos-latest    | ✅ (arm64)       |
| `build-macos-x64`| macos-14 (arm64, cross-compiles Rust → x64) | ❌ — see below |

### macOS x86_64 gap

The Intel-Mac build cross-compiles Rust to `x86_64-apple-darwin` on an Apple
Silicon runner. PyInstaller can't cross-compile, so it would emit an arm64
binary. Rather than ship a mismatched executable, the x64 build omits the
sidecar. The Rust launcher treats a missing `apprise-api` binary as non-fatal,
and Intel users can still point at a remote Apprise API via the
`appriseApiServerUrl` global setting. Closing this gap would require building an
x86_64 Python under Rosetta 2 — deferred.

### macOS code signing

The frozen binary is a Mach-O executable embedded in
`Contents/Resources/binaries/`, so the release workflow signs it with the
hardened runtime (`desktop/src-tauri/apprise.entitlements`) before notarization —
otherwise notarization rejects the embedded executable and Gatekeeper blocks it.
The entitlements disable library validation because the PyInstaller one-file
bootloader `dlopen()`s ad-hoc-signed libraries it unpacks at runtime.

## Files

| File              | Purpose                                                        |
|-------------------|----------------------------------------------------------------|
| `apprise-api.spec`| PyInstaller spec; `collect_all('apprise')` pulls every plugin. |
| `requirements.txt`| Build deps: `apprise` (unpinned, matches Dockerfile) + PyInstaller. |
| `build.sh`        | POSIX build (Linux/macOS).                                     |
| `build.ps1`       | Windows build.                                                 |
| `.gitignore`      | Excludes `.venv/`, `build/`, `dist/` build artifacts.         |
