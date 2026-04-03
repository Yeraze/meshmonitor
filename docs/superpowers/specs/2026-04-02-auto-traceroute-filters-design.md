# Auto-Traceroute Node Filtering

**Issue:** #2566
**Date:** 2026-04-02
**Status:** Approved

## Problem

Auto-traceroute wastes attempts on stale nodes that haven't been heard from recently, and on nodes that are too far away (high hop count) to produce useful results. Users want to keep old nodes in the database for history but not traceroute them.

## Solution

Add two new filters to the auto-traceroute "Limit to Specific Nodes" section:

1. **Last Heard Within** — skip nodes not heard within a configurable time window
2. **Hop Range** — skip nodes outside a min/max hop count range

Both follow the existing filter pattern: a toggle to enable/disable, plus configuration inputs.

## New Settings Keys

| Key | Type | Default | Enabled by Default |
|-----|------|---------|-------------------|
| `tracerouteFilterLastHeardEnabled` | boolean | `true` | Yes |
| `tracerouteFilterLastHeardHours` | number | `168` (7 days) | — |
| `tracerouteFilterHopsEnabled` | boolean | `false` | No |
| `tracerouteFilterHopsMin` | number | `0` | — |
| `tracerouteFilterHopsMax` | number | `10` | — |

## Changes by File

### `src/server/constants/settings.ts`

Add the 5 new keys to `VALID_SETTINGS_KEYS`.

### `src/services/database.ts`

Modify `getNodeNeedingTraceroute` (sync, SQLite) and `getNodeNeedingTracerouteAsync` (async, all backends):

- Read the 5 new settings from the database
- When last-heard filter is enabled: add `WHERE lastHeard >= (now_seconds - lastHeardHours * 3600)`. Nodes with NULL `lastHeard` are excluded.
- When hop filter is enabled: add `WHERE (COALESCE(hopsAway, 1) >= min AND COALESCE(hopsAway, 1) <= max)`. NULL `hopsAway` is treated as 1 (direct neighbor).
- These filters apply as AND conditions alongside the existing OR/UNION filter logic (channel, role, hardware model, name regex, specific nodes).

### `src/db/repositories/nodes.ts`

Update `getEligibleNodesForTraceroute` (used by PostgreSQL/MySQL async path) with the same filter logic. The function already receives filter parameters — extend its interface to accept `lastHeardMinTimestamp`, `hopsMin`, and `hopsMax`.

### `src/components/AutoTracerouteSection.tsx`

Add two new filter rows in the "Limit to Specific Nodes" section, matching the existing toggle + input pattern:

- **Last Heard Within** — checkbox toggle + numeric input labeled "hours". Positioned after the existing filters.
- **Hop Range** — checkbox toggle + two numeric inputs labeled "min" and "max". Positioned after the last-heard filter.

### `src/contexts/SettingsContext.tsx`

Add state variables and setters for all 5 new settings. Load from server on init. Include in the `handleSave` callback and its dependency array.

## Edge Cases

- `hopsAway` is NULL for nodes never relayed (direct neighbors). When hop filter is enabled, treat NULL as 1.
- `lastHeard` is NULL for nodes never heard. When last-heard filter is enabled, exclude them.
- `lastHeard` is stored in seconds (Unix timestamp), not milliseconds.
- Both new filters use AND logic with the existing filter set. A node must pass the last-heard AND hop range filters (when enabled) AND match at least one of the existing OR filters (when any are enabled).

## What This Does NOT Include

- Min/avg/max hop statistics from traceroute history (only the current `hopsAway` field is used)
- Priority weighting for newer nodes (the existing `tracerouteSortByHops` and `lastHeard DESC` ordering already provide reasonable prioritization)
- Any database migrations — all configuration uses the existing settings table
