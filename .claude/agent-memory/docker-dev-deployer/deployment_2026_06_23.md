---
name: deployment_2026_06_23_automation_engine
description: Deployment of Automation Engine feature from main@789d269f to dev container
metadata:
  type: project
---

## Deployment Summary (2026-06-23 12:30 UTC)

**Branch:** main  
**Commit:** 789d269f541828436a7ed6b1369bbc0c9d6eebbb  
**Feature:** Automation Engine (merged from #3653)  
**Version:** 4.11.5  
**Profile:** sqlite  
**Status:** RUNNING & HEALTHY

## Build & Deployment Result

✅ **Build:** Successful (client + server TypeScript, PWA manifest, dist generated)
✅ **Deploy:** Container running, no restarts (RestartCount: 0)
✅ **Startup:** All 99 migrations completed, including automation tables (098, 099)
✅ **Code Verified:** Commit matches 789d269f (confirmed via git rev-parse HEAD)

## Container Status

- **Container ID:** meshmonitor-sqlite
- **Image:** meshmonitor-meshmonitor-sqlite (sha256: 323021f8)
- **Uptime:** 175+ seconds, stable
- **Ports:** 8081→3001 (HTTP), 1883 (MQTT), 4503-4505 (MeshCore CLI), 5000 (Apprise), etc.
- **Data Volume:** meshmonitor_meshmonitor-sqlite-data (624.6 MB, preserved from prior run)

## Feature Verification

1. ✅ **Frontend Automation UI:** "Test this workflow" string present in bundle
2. ✅ **System Events UI:** "Upgrade available (new release detected)" present in bundle
3. ✅ **Server Routes:** automationRoutes.js exists with simulateAutomation & notifyDirect
4. ✅ **Database:** Migrations 098 & 099 (automations table) completed
5. ✅ **API Endpoint:** /api/automations exists (returns FORBIDDEN when auth-required, proves endpoint working)

## HTTP Verification

- **GET /meshmonitor/** → HTTP 200 OK (SPA loads)
- **GET /meshmonitor/automations** → HTTP 200 OK (page loads)
- **GET /api/health** → {"status":"ok","version":"4.11.5",...}
- **GET /api/settings** → All migrations listed with "completed" status

## Data Preservation

✅ **Volumes intact:** meshmonitor_meshmonitor-data and meshmonitor_meshmonitor-sqlite-data unchanged  
✅ **DB unwiped:** 624.6 MB SQLite file with all prior backups, nodes, messages, sources intact

## Quick Access for Testing

**URL:** http://localhost:8081/meshmonitor/automations  
**Login:** admin / changeme (admin user still has default password set in this container)  
**Note:** Automations page requires "automations:read" permission (admin has it after login)

## Next Steps for User

1. Open http://localhost:8081/meshmonitor/automations in browser
2. Log in with admin/changeme
3. Test workflow creation, test panel, system event notifications
4. Verify Automation Engine service is stable (check logs for any WARN/ERROR related to automation scheduler)
