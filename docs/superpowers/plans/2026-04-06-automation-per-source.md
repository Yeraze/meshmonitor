# Automation Per-Source Scoping

**Goal:** Make all Automation page features per-source so each Source has independent
configuration, schedules, and state. Currently most automation settings are stored
globally and silently shared between sources.

## Phases

### Phase 1 — Frontend `/api/settings` thread-through (low risk)
Thread `?sourceId` and `useSource()` through the simple settings GET/POST in:
- AutoResponderSection.tsx
- AutoAcknowledgeSection.tsx
- AutoAnnounceSection.tsx
- AutoWelcomeSection.tsx
- AutoFavoriteSection.tsx
- AutoHeapManagementSection.tsx
- GeofenceTriggersSection.tsx
- TimerTriggersSection.tsx
- RemoteAdminScannerSection.tsx
- AutoTracerouteSection.tsx (interval write at line 461 only)
- AutoDeleteByDistanceSection.tsx (settings write at line 126 only)
- AutoKeyManagementSection.tsx (settings write at line 109 only)

Backend already supports per-source settings via `?sourceId=` on `/api/settings`.
**Outcome:** Settings stored in the generic settings KV store become per-source. PR-able.

### Phase 2 — Sub-route per-source support (backend + frontend)
Add `?sourceId` query support to dedicated sub-routes and refactor their backing
storage / manager state to be per-source:

2a. **Auto-Ping** (`/api/settings/auto-ping`)
  - `auto_ping_*` settings already in KV — easy if read via `getSourceSettings`
  - In-memory session map keyed by nodeNum → key by `${sourceId}:${nodeNum}`
  - Update `meshtasticManager.handleAutoPingDM` to pass sourceId

2b. **Traceroute scheduler** (`/api/settings/traceroute-nodes`, `/traceroute-log`)
  - `traceroute_nodes` table → add `sourceId` column (migration)
  - `traceroute_log` table → add `sourceId` column (migration)
  - Filter list/log queries by sourceId
  - Scheduler tick must iterate per-source

2c. **Time-Sync scheduler** (`/api/settings/time-sync-nodes`)
  - `time_sync_nodes` table → add `sourceId` column (migration)
  - Same pattern as traceroute

2d. **Distance-Delete** (`/api/settings/distance-delete/log`, `/run-now`)
  - `distance_delete_log` table → add `sourceId` column (migration)
  - `run-now` POST takes `sourceId` and only deletes from that source

2e. **Key-Repair log** (`/api/settings/key-repair-log`)
  - `key_repair_log` table → add `sourceId` column if not present (migration)

2f. **Mark-All-Welcomed** (`/api/settings/mark-all-welcomed`)
  - POST takes `sourceId` and only marks nodes from that source

Each sub-task is its own migration + route + frontend change. Likely one PR per
feature to keep review tractable.

### Phase 3 — Verification
- Build, deploy, manually verify each automation can be configured independently
  on Source 1 vs Source 2
- Add regression test stubs where feasible (per-source settings KV behavior)
- Update CLAUDE.md memory with the per-source pattern for automations

## Additional 4.0 TODOs (deferred — do not interrupt current Phase 1 work)
- Review **Remote Administration** for items needing `sourceId`
- Review **Security** for items needing `sourceId`
- Review **Notifications** for items needing `sourceId`
- Review **search** for items needing `sourceId`
- **Split the Settings page** into per-source and global:
  - Per-source: Solar Monitoring, Firmware Update, Danger Zone
  - Global: everything else, moved to a new top-level Global Settings page
- **Remove "Disconnect" button** from the per-source UI; relocate it to the
  3-dot popup menu on the main page, between Disable and Delete
- **Virtual Node**: come up with a solution for what a "Virtual Node" looks
  like in the multi-source world (cross-source aggregate identity? per-source
  proxy node? UI for managing it?). Design needed before implementation.

## Order of work
1. Phase 1 (single commit/PR)
2. Phase 2a — Auto-Ping
3. Phase 2b — Traceroute
4. Phase 2c — Time-Sync
5. Phase 2d — Distance-Delete
6. Phase 2e — Key-Repair log
7. Phase 2f — Mark-All-Welcomed
8. Phase 3 — Verify + memory update

Starting with Phase 1.
