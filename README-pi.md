# MeshMonitor – Raspberry Pi / Multi-Arch Build Guide

This pack adds **Pi/ARM support** and a **multi-arch GHCR publish workflow** to your fork.

## Quick Start (Pi local build)

```bash
# clone with submodules (recommended)
git clone --recurse-submodules https://github.com/n30nex/meshmonitor.git
cd meshmonitor

# build ARM64 image (fetch protobufs if missing)
docker buildx build --platform linux/arm64 -t meshmonitor:arm64-v2 --load --build-arg FETCH_PROTOBUF=1 .

# run
docker run -d --name meshmonitor -p 8080:3001 -v meshmonitor-data:/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  meshmonitor:arm64-v2
```

## GHCR Multi-Arch CI (amd64 + arm64)

A workflow is included at `.github/workflows/docker-multiarch.yml`. On pushes to `main` or on tags like `v2.8.2`, it will:

- Build **linux/amd64** and **linux/arm64**
- Push to `ghcr.io/<OWNER>/meshmonitor`
- Tag as `latest` (for `main`), and `vX.Y.Z` for tags

> Make sure GHCR packages are enabled for your account/org and **visibility is set** as you prefer.

## docker-compose (Pi)

Use `docker-compose.pi.yml`:

```bash
GHCR_OWNER=n30nex docker compose -f docker-compose.pi.yml up -d
```

## Notes

- If you build from a **ZIP** download, submodules won’t be included. Either re-clone with `--recurse-submodules` or set `FETCH_PROTOBUF=1` so the Dockerfile fetches protobufs at build time.
- For HTTPS deployments, set `COOKIE_SECURE=true` and a strong `SESSION_SECRET`.
- If you *must* run amd64 on a Pi via emulation, set `platform: linux/amd64` in compose (slower).
