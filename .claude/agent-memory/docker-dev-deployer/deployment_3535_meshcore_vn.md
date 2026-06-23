---
name: feat-3535-meshcore-vn-deployment
description: Successful deployment of MeshCore Virtual Node (Phase 0) branch with port 5000 exposed
metadata:
  type: project
---

## Deployment Summary
**Date:** 2026-06-18 15:24 UTC
**Branch:** `feat/3535-meshcore-virtual-node-phase0`
**Status:** ✅ RUNNING AND HEALTHY

## Build & Deploy Results
- **Build:** ✅ COMPLETE — image `meshmonitor-meshmonitor-sqlite` built from current branch
- **Deploy:** ✅ COMPLETE — container `meshmonitor-sqlite` running
- **Uptime:** 57 seconds (no restarts, RestartCount: 0)
- **Image SHA:** sha256:df39902bf8d124bd2f51c425c6b523626085664e7fc66f23fc673c67a666ad78

## Port Mappings Verified
- **8081→3001/tcp:** Main app HTTP (BASE_URL=/meshmonitor) — HTTP 200 OK ✅
- **5000→5000/tcp:** MeshCore Virtual Node server — PUBLISHED ✅ (both IPv4 and IPv6)
- **1883:** MQTT broker
- **4503-4505:** MeshCore serial emulation ports
- **4405→4404:** MeshCore CLI console

## Code Verification
- ✅ Deployed version: `4.11.0-rc1`
- ✅ MeshCore Virtual Node server compiled: `/app/dist/server/meshcoreVirtualNodeServer.js` (11.4 KB, built 11:24 UTC)
- ✅ Related MeshCore files present:
  - meshcoreManager.js (180.8 KB)
  - meshcoreNativeBackend.js (58.5 KB)
  - meshcoreRegistry.js (4.4 KB)
  - meshcoreCompanionCodec.js (9.4 KB)

## Startup Health
- ✅ 0 errors, 36 warnings (expected — low-entropy test keys, telemetry timestamp drift)
- ✅ HTTP endpoint responding at `/meshmonitor/`
- ✅ Database ready (volumes preserved from pre-flight snapshot)
- ✅ No fatal errors, no crash loop

## Volumes Preserved
All three volumes unchanged from pre-flight:
- meshmonitor_meshmonitor-backup-source-test-data
- meshmonitor_meshmonitor-data
- meshmonitor_meshmonitor-sqlite-data

## Command Reference
```bash
# Deploy this branch:
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml up -d --build

# Check status:
docker ps --filter 'name=meshmonitor-sqlite'
docker logs meshmonitor-sqlite 2>&1 | tail -40

# Verify port 5000:
ss -tuln | grep 5000
curl -v telnet://localhost:5000

# Stop (preserve volumes):
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml down
```

## Next Steps
- MeshCore Virtual Node server is listening on port 5000
- App is ready for testing at http://localhost:8081/meshmonitor
- Do NOT run system-tests.sh (CI-only); do NOT shutdown tileserver
