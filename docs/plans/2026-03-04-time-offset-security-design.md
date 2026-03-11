# Time Offset Security Detection

**Date:** 2026-03-04
**Status:** Approved

## Problem

Nodes with clocks significantly out of sync can cause issues in the mesh network (message ordering, duplicate detection, etc.) and may indicate misconfigured or compromised devices. Currently there is no way to identify these nodes in the Security tab.

## Solution

Add a "Time Offset" security check that flags nodes whose clock is more than a configurable threshold (default: 30 minutes) off from the server's time. Uses existing `timeOffset` telemetry data (server time minus `rxTime`).

## Design Decisions

- **Time source:** rxTime-based offset (already collected as `timeOffset` telemetry every 5 minutes)
- **Check frequency:** Part of the existing 24-hour security scanner cycle
- **Storage:** New boolean flag + offset value on the nodes table (migration 078)
- **Threshold:** Configurable via `TIME_OFFSET_THRESHOLD_MINUTES` env var (default: 30)

## Database Changes (Migration 078)

Add to `nodes` table (all 3 backends):
- `isTimeOffsetIssue` BOOLEAN DEFAULT false
- `timeOffsetSeconds` INTEGER NULL

## Backend Changes

### DuplicateKeySchedulerService
- New `runTimeOffsetDetection()` method (follows `runSpamDetection()` pattern)
- Queries latest `timeOffset` telemetry per node
- Flags nodes where `abs(offset) > threshold`
- Clears flags when nodes come back within threshold
- Called from `runScan()` alongside `runSpamDetection()`

### Database Layer
- `updateNodeTimeOffsetFlags(nodeNum, isIssue, offsetSeconds)` in nodes repository
- `getNodesWithTimeOffsetIssuesAsync()` in nodes repository
- Expose through DatabaseService facade

### Security Routes
- Include time offset nodes in `GET /api/security/issues` response
- Add `timeOffsetCount` to response
- Include in `GET /api/security/export`
- Clear time offset flags in `POST /api/security/nodes/:nodeNum/clear`

## Frontend Changes

### SecurityTab.tsx
- Update `SecurityNode` interface: add `isTimeOffsetIssue`, `timeOffsetSeconds`
- Update `SecurityIssuesResponse`: add `timeOffsetCount`
- New "Time Offset" section between Excessive Packets and Top Broadcasters
- Display offset as human-readable duration (e.g., "+2h 15m", "-45m")

### i18n
- Add translation keys for section header, descriptions, offset formatting
