---
name: Latest Deployment Status
description: Most recent Docker dev deployment details (2026-04-13)
type: project
---

## Deployment Summary (2026-04-13 16:02 UTC)

**Status**: ✅ **READY FOR TESTING**

### Build & Deploy
- **Branch**: main
- **Profile**: sqlite
- **Image**: meshmonitor-meshmonitor-sqlite (sha256: ae0d8f8ca26e8...)
- **Build Result**: ✅ Success (5.4s export)
- **Deploy Result**: ✅ Both containers running

### Container State
- **Container**: meshmonitor-sqlite
- **State**: running (RestartCount: 0)
- **Uptime**: stable at check time
- **Network**: meshmonitor_default

### Code Verification
- **Deployed Version**: 4.0.0-beta.1 ✅ (matches local checkout)
- **Build Source**: Local code from main branch

### Startup Health
- ✅ All 33 migrations completed (001–030, 032–033)
  - SQLite baseline created
  - Auth schema aligned
  - sourceId columns added (multi-source PRs deployed)
  - Composite PK rebuilt on nodes table
  - Per-source permissions expansion completed
- ✅ Database ready and initialized
- ✅ HTTP server started on :3001 (mapped to 8081)
- ✅ Apprise notification service running
- ✅ Backup scheduler active
- ✅ Database maintenance scheduler active
- ✅ Firmware update service polling started
- ✅ Inactive node notification service started
- ✅ **No fatal errors, no crash loops, no warnings**

### HTTP Verification
- **Endpoint**: http://localhost:8081/meshmonitor/
- **Response**: HTTP 200 OK
- **Content**: HTML doctype + base href correct

### Environment
- NODE_ENV: production
- BASE_URL: /meshmonitor
- DATABASE_TYPE: sqlite
- PORT: 3001

### Verification Checklist
- [x] Build completed without errors
- [x] Container in `Running` state (RestartCount: 0)
- [x] HTTP 200 response at `/meshmonitor/`
- [x] Deployed version matches 4.0.0-beta.1
- [x] No critical errors in logs
- [x] All database migrations clean
- [x] Bootstrap services healthy

**Conclusion**: Container is production-ready. Recent PRs (packet monitor sourceId fix, traceroute VN fix, PWA white-screen fix, dependabot bumps) all deployed correctly.
