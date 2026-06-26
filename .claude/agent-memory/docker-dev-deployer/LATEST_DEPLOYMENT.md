---
name: latest-deployment-2026-06-24
description: Latest successful dev container deployment from worktree feat/automation-token-hints
metadata:
  type: project
---

# Deployment Report — 2026-06-24 20:02 UTC

## Build & Deploy
- **Branch**: feat/automation-token-hints (token-highlighting feature)
- **Working Dir**: /home/yeraze/Development/meshmonitor/.claude/worktrees/automation-geofence-map
- **Version**: 4.12.0-rc1
- **Compose Files**: docker-compose.dev.yml + docker-compose.dev.local.yml (USB override)
- **Build Status**: ✅ SUCCESS (Vite frontend recompiled, 83 modules, server TS compiled)
- **Redeploy Status**: ✅ SUCCESS (container recreated and started)

## Container Status
- **Name**: meshmonitor-sqlite
- **State**: running (PID 300958, RestartCount=0)
- **Port Binding**: 0.0.0.0:8081→3001/tcp (IPv4+IPv6)
- **Uptime**: 70+ seconds at report time
- **HTTP Endpoint**: http://localhost:8081/meshmonitor/ → 200 OK

## Verification
- ✅ Build completed without errors
- ✅ Container in running state (no restarts)
- ✅ HTTP 200 response at /meshmonitor/
- ✅ Backend health API responding: status=ok, version=4.12.0-rc1
- ✅ Database type: sqlite
- ✅ All core services initialized (config capture, schedulers started)
- ✅ No fatal errors in startup logs

## Volumes
Preserved (not recreated):
- meshmonitor_meshmonitor-backup-source-test-data
- meshmonitor_meshmonitor-data
- meshmonitor_meshmonitor-sqlite-data

## Notes
- Tileserver has permission issues on mbtiles file (non-critical for feature testing)
- Feature under test: token-highlighting ({{ }}) in Automation Engine builder
- Ready for visual testing of token-highlighting UI
