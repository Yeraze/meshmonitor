# Daily Security Digest via Apprise

**Issue:** #2468
**Date:** 2026-03-27

## Overview

A scheduled daily report that summarizes active security issues and delivers them via Apprise. This is a standalone reporting feature on the Security page, independent from the per-user notification preferences system.

## UI: Security Page — "Security Digest" Section

Located on the Security tab, below the existing scanner configuration:

- **Enable toggle** — on/off for the daily digest
- **Apprise URL field** — dedicated URL(s) for digest delivery (independent from notification system)
- **Time picker** — "Send digest at [HH:MM]" for daily schedule (default: 06:00)
- **Report type dropdown** — "Summary" or "Detailed"
- **Suppress if no issues toggle** — skip sending when zero security issues found (default: on)
- **"Send Now" button** — immediate manual trigger

## Report Types

### Summary
Concise counts and statistics. Good for phone/quick-glance destinations.

```
MeshMonitor Security Digest — 2026-03-27

2 issue types detected across 5 nodes

Duplicate PSK: 2 groups (5 nodes)
Low-Entropy Key: 1 node
Excessive Packets: 0 nodes
Time Offset: 0 nodes

View details: https://your-meshmonitor/security
```

### Detailed
Full breakdown with node names and specifics. Good for email/Slack for action.

```
MeshMonitor Security Digest — 2026-03-27

2 issue types detected across 5 nodes

--- Duplicate PSK ---
Group 1 (3 nodes): NodeA, NodeB, NodeC
Group 2 (2 nodes): NodeX, NodeY

--- Low-Entropy Key ---
NodeZ (!abcd1234) — key: AQ==

--- Excessive Packets ---
None

--- Time Offset ---
None

View details: https://your-meshmonitor/security
```

## Backend

### Settings Keys
- `security_digest_enabled` — "true"/"false" (default: "false")
- `security_digest_apprise_url` — Apprise URL string
- `security_digest_time` — "HH:MM" format (default: "06:00")
- `security_digest_report_type` — "summary"/"detailed" (default: "summary")
- `security_digest_suppress_empty` — "true"/"false" (default: "true")

All keys must be added to `VALID_SETTINGS_KEYS` in `src/server/constants/settings.ts`.

### New Service: `securityDigestService.ts`
- Scheduled via croner using `cronScheduler.ts`
- On startup: reads settings, schedules cron job at configured time
- On settings change: reschedules cron job
- Generates digest from existing security scanner data (`getNodesWithKeySecurityIssuesAsync`, `getTopBroadcastersAsync`, etc.)
- Sends directly to configured Apprise URL using HTTP POST to Apprise API (`http://localhost:8000/notify`)
- Does NOT use the notification preferences system

### API Endpoints
- `POST /api/security/digest/send` — manual trigger ("Send Now"), admin-only
- No separate GET endpoint needed — settings are read/written via existing `/api/settings` endpoints

### Data Sources (all existing)
- `databaseService.getNodesWithKeySecurityIssuesAsync()` — duplicate keys, low-entropy keys
- `databaseService.getTopBroadcastersAsync()` — excessive packet senders
- `duplicateKeySchedulerService` — time offset issues
- Security route handler at `/api/security/issues` already aggregates all of this

## Architecture Notes

- The digest service calls the same data-gathering functions as the Security page API endpoint
- Apprise communication goes directly to `http://localhost:8000/notify` (the bundled Apprise API), not through appriseNotificationService — keeps it independent
- Schedule uses croner via `cronScheduler.ts` for missed-execution recovery
- The "Send Now" button calls the same `sendDigest()` method as the cron job

## Files to Create/Modify

### New Files
- `src/server/services/securityDigestService.ts` — digest service with scheduling and message generation

### Modified Files
- `src/server/constants/settings.ts` — add 5 new keys to `VALID_SETTINGS_KEYS`
- `src/server/routes/securityRoutes.ts` — add `POST /api/security/digest/send` endpoint
- `src/server/server.ts` — initialize and start the digest service
- `src/components/SecurityTab.tsx` — add "Security Digest" UI section
- `src/styles/SecurityTab.css` — styles for the new section
