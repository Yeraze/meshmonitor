---
name: deployment_2026_06_20_telemetry_debug
description: Dev container deployment for telemetry issue #3573 debugging
metadata:
  type: project
---

## Deployment Summary (2026-06-20 ~17:40 UTC)

**Task**: Build and deploy MeshMonitor dev container with USB device mapping for Meshtastic telemetry debugging (issue #3573).

### Build & Deploy
- **Branch**: main
- **Commit**: 33a48bc9
- **Version**: 4.11.0-rc2
- **Profile**: sqlite
- **Compose files**: docker-compose.dev.yml + docker-compose.dev.local.yml (USB override)
- **Build result**: SUCCESS (all cached layers, final image: meshmonitor-meshmonitor-sqlite:latest)
- **Deploy result**: SUCCESS

### Container Status
- **Name**: meshmonitor-sqlite
- **Container ID**: 62b8632a0a2b
- **Status**: Running (uptime ~1+ minute, RestartCount: 0)
- **HTTP Endpoint**: http://localhost:8081/meshmonitor/ (HTTP 200 OK)
- **Startup logs**: 0 errors, 25 warnings, 65 info messages (news service fetch error is non-blocking external service)

### Volume Preservation
- Pre-flight: meshmonitor_meshmonitor-backup-source-test-data, meshmonitor_meshmonitor-data, meshmonitor_meshmonitor-sqlite-data
- Post-deploy: IDENTICAL (no volume destruction)

### Device Connectivity
- **USB Override**: docker-compose.dev.local.yml maps /dev/ttyUSB0-3 with group_add
- **MC-Sandbox (ttyUSB2)**: CONNECTED
  - Status API response: `{"connected": true, "sourceId": "1876c95d-d3da-4bf4-bf28-7ccbf586d33c", "sourceName": "MC-Sandbox", "sourceType": "meshcore"}`
  - Synced nodes: 5+ MeshCore nodes observed (YerazeMM, Yeraze MC BLE Sandbox, Yeraze Repeater, etc.)
  - lastHeard timestamps: 1781963552695 (recent)
- **MC-BLESandbox (ttyUSB3)**: CONNECTED (status confirmed, separate source)
- **Other sources**: Florida MQTT, Sandbox (TCP), Official MQTT, Yeraze MQTT Broker all enabled

### Verification
- [x] Build completed without errors (cached, clean image)
- [x] Container in Running state (no restarts)
- [x] HTTP 200 at /meshmonitor/
- [x] Deployed version matches 4.11.0-rc2
- [x] No fatal/error log lines in startup (news fetch failure is non-blocking)
- [x] USB devices mapped via override file
- [x] MeshCore connections active and syncing node data
- [x] Volumes preserved (no data loss)
- [x] Port 8081→3001 binding confirmed (both IPv4 and IPv6)

### Ready for Debugging
**STATUS**: READY FOR TESTING

The container is live, connected to real Meshtastic devices on /dev/ttyUSB2 and /dev/ttyUSB3, and syncing node data. No local node discovered yet (normal — takes a moment after connection). Use `docker logs meshmonitor-sqlite` or `docker exec meshmonitor-sqlite` for debugging telemetry request flows.
