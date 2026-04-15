---
name: Latest Deployment
description: MeshMonitor dev container deployment status and verification results
type: project
---

# Latest Deployment (2026-04-10 23:10 UTC)

## Branch & Code
- **Branch**: `feature/mobile-collapsible-sidebar`
- **Commit**: `0a12fd17` (fix: seed-only channel writes from device NodeDB sync #2626)
- **Profile**: `sqlite`
- **Port**: `8081`

## Container Status
- **ID**: `1a94925b48a4`
- **Name**: `meshmonitor-sqlite`
- **Status**: UP (stable, no crashes)
- **Built**: Fresh rebuild with `--no-cache` (Apr 10 23:03 UTC)
- **Image**: `meshmonitor-meshmonitor-sqlite:latest`

## Verification Results
- ✅ **HTTP Endpoint**: `http://localhost:8081/meshmonitor/` responds with HTTP 200
- ✅ **Bundle Contains "dashboard-topbar-hamburger"**: Found in `/app/dist/assets/main-QMyg8Vlv.js` (1 occurrence)
- ✅ **Bundle Contains "mobile-open"**: Found in `/app/dist/assets/main-QMyg8Vlv.js` (1 occurrence)
- ✅ **Code Deployed**: Latest from current checkout (DashboardSidebar.tsx, dashboard.css changes included)
- ✅ **Startup Health**: Clean startup logs, no fatal errors, broadcasts/sync running normally

## Startup Logs Summary
- Database initialized successfully
- Background services running (broadcasts, push notifications, PKI sync)
- NodeInfo exchange functioning (public keys received from test nodes)
- No crash loops or missing dependencies

## Build Command Used
```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build --no-cache
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d
```

## Deployment: READY FOR TESTING
All verification checks passed. Container is healthy and contains the mobile collapsible sidebar CSS/component code.
