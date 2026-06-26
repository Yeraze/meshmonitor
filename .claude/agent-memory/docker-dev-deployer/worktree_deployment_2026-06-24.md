---
name: worktree-deploy-2026-06-24
description: Successful worktree deployment after rebase onto origin/main
metadata:
  type: project
---

## Deployment Summary (2026-06-24 10:04 UTC)

**Branch**: worktree-automation-geofence-map
**Commit**: 98f68c143c9f92 (feat: visual map geofence editor + readability fix #3653)
**Base**: Rebased onto origin/main 0b293b23 on 2026-06-24

### Build Result
✅ **SUCCESS** — Fresh image built with both compose files

- Image: `meshmonitor-meshmonitor-sqlite:latest`
- Build timestamp: 2026-06-24T10:03:37.647713435-04:00 (UTC-4)
- Image SHA: `0e0f203e9ccdcbaf1eff5236f7859651816891d2e394cb858f87c72781af5cdc`
- No cache reuse on app code (full rebuild)

### Deploy Result
✅ **RUNNING** — Container healthy with no restart loop

- Container: `meshmonitor-sqlite`
- Status: `running` (RestartCount: 0)
- Port: `0.0.0.0:8081->3001/tcp` (both IPv4 and IPv6)
- Tileserver: Running on port 8082

### Volume Preservation
✅ **SAFE** — Named volumes unchanged

- `meshmonitor_meshmonitor-data` — preserved
- `meshmonitor_meshmonitor-sqlite-data` — preserved
- No `-v` or `--volumes` flags used in any docker command

### Startup Health
✅ **HEALTHY**

- HTTP 200 OK at `http://localhost:8081/meshmonitor/`
- App version: `4.12.0-rc1`
- Non-critical external fetch error (news service connection): does NOT block startup
- Low-entropy key warnings in test data: expected, non-fatal

### Feature Verification
✅ **DEPLOYED** — Geofence map editor feature from worktree included

Files deployed with build:
- `src/components/automations/GeofenceFieldInput.tsx` (new)
- `src/components/automations/AutomationBuilder.tsx` (modified)
- `src/components/automations/AutomationsPage.tsx` (modified)
- `src/components/automations/AutomationsPage.css` (readability fix)
- `src/server/services/automation/geo.ts` (new)

Compiled into `/app/dist/client` inside container; source not accessible (minified).

### Compose Command Used
```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml build
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml up -d
```

Both files included USB device mapping and development overrides.

### Working URL
```
http://localhost:8081/meshmonitor/
```

**Status**: ✅ READY FOR TESTING
