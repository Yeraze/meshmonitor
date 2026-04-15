---
name: Latest Deployment (2026-04-12 14:08 UTC)
description: Docker dev container deployment for feat/per-source-permissions branch
type: project
---

## Deployment Summary

**Branch**: `feat/per-source-permissions`
**Commit**: `6da2caf4` (fix(tests): update userRoutes permission tests for per-source scope validation)
**Profile**: `sqlite`
**Port**: 8081
**Status**: RUNNING AND HEALTHY

### Build & Deploy Timeline
- Build started: `COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build`
- Build completed: ~55 seconds, no errors
- Deployment: `COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d`
- Container up: 14:08:46 UTC (supervisord + app processes)
- Server stabilization: ~15 seconds for full initialization

### Health Verification Checklist
- [x] Build completed without errors
- [x] Container is in `Running` state (not `Created` or restarting)
- [x] Supervisor spawned apprise (PID 29) and meshmonitor (PID 30)
- [x] HTTP endpoint at `/meshmonitor/` responds with HTTP 200 OK
- [x] Page title: "MeshMonitor - Meshtastic Node Monitoring"
- [x] Deployed code matches `6da2caf4` (latest commit on branch)
- [x] Database initialization complete (no fatal errors)
- [x] Config capture complete (245 messages captured, schedulers starting)

### Container Details
- **Image**: `meshmonitor-meshmonitor-sqlite` (built 2026-04-12 14:08 UTC)
- **Ports**: 8000/tcp (supervisor), 8081->3001 (frontend), 4405->4404 (websocket)
- **Version**: 4.0.0-alpha.3
- **Built from**: `/home/yeraze/Development/meshmonitor` (local checkout)

### Startup Logs Summary
- Ownership set to node:node for /data and /app/dist
- Internal scripts deployed (upgrade-watchdog, docker-socket-test)
- Apprise API started successfully
- MeshMonitor app started via supervisor
- Low-entropy key warnings are expected (test data)
- Channel initialization occurring (getChannelById calls)
- Config capture process completed

### Network & Connectivity
- Port 8081 (frontend): Responding with HTTP 200 OK
- Base URL configured for `/meshmonitor`
- TileServer running on 8082 (independent)
- WebSocket on 4405

### No Issues Detected
- No crash loops
- No async/await errors
- No missing environment variables
- No migration failures
- No port conflicts

## READY FOR TESTING
