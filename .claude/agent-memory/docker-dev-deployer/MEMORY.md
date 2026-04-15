# Docker Dev Deployer Memory

## Latest Deployment (2026-04-13 13:47 UTC)

- **Branch**: `main` (commit 97cb424b)
- **Version**: `4.0.0-beta.1`
- **Profile**: `sqlite`
- **Port**: 8081 (internal 3001)
- **Status**: ✅ RUNNING AND HEALTHY

### Container Details
- Container: `meshmonitor-sqlite`
- Image: `meshmonitor-meshmonitor-sqlite` (sha256: 3d8985eb3efb...)
- Uptime: 20+ seconds, no restarts
- HTTP Endpoint: `http://localhost:8081/meshmonitor/` responding with HTTP 200 OK
- Port binding: `0.0.0.0:8081->3001/tcp` (both IPv4 and IPv6)

### Startup Health
- ✅ Database ready, HTTP server started
- ✅ All 22 migrations completed successfully
- ✅ Backup scheduler initialized
- ✅ Security scanner initialized
- ✅ Protobuf definitions loaded
- ✅ Push notification service configured
- ✅ Solar monitoring service initialized
- ✅ Database maintenance service initialized
- ✅ Inactive node notification service started
- ✅ Config capture complete
- Note: Non-critical news service fetch failed (external dependency, does not block startup)

### Verification Checklist
- ✅ Build completed without errors
- ✅ Container in `Running` state (RestartCount: 0)
- ✅ HTTP 200 response at `/meshmonitor/`
- ✅ Deployed version matches 4.0.0-beta.1
- ✅ No async/await or fatal errors in logs
- ✅ All core services initialized
- ✅ Database migrations clean (no failures)

### Local Modifications Status
Note: User has uncommitted changes on main branch (not deployed in this build):
- scripts/README.md, setup-dev-config.sh
- Multiple component files (ChannelsTab, HopCountDisplay, MessagesTab, etc.)
- db/migrations.ts, migrations.test.ts, repositories/messages.ts

Container built from clean HEAD (97cb424b).

## Docker Compose Command Pattern
```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d
```
Always use env var, not `--profile` flag. Always build before up.

## Quick Verification Commands
- Status: `docker ps --filter 'name=meshmonitor-sqlite'`
- Version: `docker exec meshmonitor-sqlite cat /app/package.json | grep '"version"'`
- HTTP: `curl -s -I http://localhost:8081/meshmonitor/`
- Logs: `docker logs meshmonitor-sqlite 2>&1 | tail -50`
- Errors: `docker logs meshmonitor-sqlite 2>&1 | grep -E "ERROR|FATAL"`
