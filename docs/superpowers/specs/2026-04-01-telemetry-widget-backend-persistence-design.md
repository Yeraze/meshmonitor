# Telemetry Widget Display Options Backend Persistence

**Issue:** MM-80  
**Date:** 2026-04-01  
**Status:** Approved

## Problem

`useWidgetMode` and `useWidgetRange` store telemetry widget display preferences (chart/gauge/numeric mode and gauge min/max limits) in `localStorage` only. As a result:

1. Settings are per-browser — anonymous users always see the default chart view regardless of admin configuration.
2. Any user can change their local view (no permission enforcement).
3. The gauge SVG is unconstrained in width, making it visually too large.

## Solution

### 1. Backend Settings Keys

Add to `src/server/constants/settings.ts` `VALID_SETTINGS_KEYS`:

- `telemetryWidgetModes` — JSON-serialized `Record<string, WidgetMode>` keyed by `${nodeId}_${type}`
- `telemetryWidgetRanges` — JSON-serialized `Record<string, {min: number, max: number}>` keyed by `${nodeId}_${type}`

### 2. Backend-Synced Hooks

Rewrite `useWidgetMode.ts` using TanStack Query (same pattern as `useFavorites`):

- `useWidgetMode(nodeId, type)` returns `[mode, setMode]`
- On mount: fetches `/api/settings`, reads `telemetryWidgetModes`, falls back to `'chart'`
- `setMode(m)`: updates optimistic cache and POSTs to `/api/settings` via CSRF fetch
- QueryKey: `['widgetModes']` (shared across all widgets, avoids per-widget fetches)

Rewrite `useWidgetRange.ts` the same way:

- QueryKey: `['widgetRanges']`
- Falls back to `DEFAULT_GAUGE_RANGES[type]` then `{min:0, max:100}`

### 3. Permission Enforcement

`TelemetryGraphWidget` calls `useAuth()`:

- Mode toggle buttons (`~`, `⊙`, `#`) are only rendered if `hasPermission('settings', 'write')` is true
- Gauge range inputs are passed through a `canEditRange` prop to `TelemetryGauge`
- `TelemetryGauge` only renders the `gauge-range-row` when `canEditRange` is true

Anonymous users and read-only users see the persisted display mode (set by an admin) but cannot change it.

### 4. Gauge Size Fix

Add `max-width: 200px` to `.telemetry-gauge` in `TelemetryGraphs.css`. The SVG uses `width="100%"` which causes it to expand beyond its natural size in wide containers.

## Files Changed

| File | Change |
|------|--------|
| `src/server/constants/settings.ts` | Add `telemetryWidgetModes`, `telemetryWidgetRanges` |
| `src/hooks/useWidgetMode.ts` | Rewrite with TanStack Query backend sync |
| `src/hooks/useWidgetRange.ts` | Rewrite with TanStack Query backend sync |
| `src/hooks/useWidgetMode.test.ts` | Update tests for new async implementation |
| `src/hooks/useWidgetRange.test.ts` | Update tests for new async implementation |
| `src/components/TelemetryGraphs.tsx` | Add `useAuth()`, hide mode toggles for non-writers, pass `canEditRange` |
| `src/components/TelemetryGauge.tsx` | Accept `canEditRange` prop, hide range row |
| `src/components/TelemetryGraphs.css` | Add `max-width: 200px` to `.telemetry-gauge` |

## Non-Goals

- No migration needed: new settings keys default to empty (widgets fall back to `'chart'` mode)
- No database schema change: settings are stored as JSON in the existing settings table
- localStorage is removed from both hooks (backend is the source of truth)
