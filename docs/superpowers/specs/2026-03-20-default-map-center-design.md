# Default Map Center Configuration

**Issue:** #2317
**Date:** 2026-03-20
**Status:** Approved

## Problem

When no prior session exists (e.g., anonymous/shared links), the map defaults to hardcoded Miami coordinates `[25.7617, -80.1918]`. Instance operators want to configure a default center relevant to their deployment area.

Additionally, the absolute last-resort fallback (no configured default, no nodes with positions, no prior session) should show a world view rather than Miami.

## Design

### New Settings

Three new keys in `VALID_SETTINGS_KEYS`:
- `defaultMapCenterLat` (number, nullable)
- `defaultMapCenterLon` (number, nullable)
- `defaultMapCenterZoom` (number, nullable)

Server-persisted via the existing `/api/settings` endpoint. Available to anonymous users.

### Settings UI

A "Default Map Center" section in SettingsTab, near existing map settings:

- **Minimap**: ~300px tall embedded Leaflet MapContainer using basic OSM tileset
- **Initial state (unconfigured)**: World view at zoom ~2, center [20, 0]
- **Initial state (configured)**: Shows the saved center and zoom
- **Interaction**: User pans and zooms freely
- **Buttons**: "Save as Default" (captures current minimap center + zoom), "Clear" (removes configured default)
- **Status text**: Shows saved coordinates or "No default center configured"

### New Component

`src/components/configuration/DefaultMapCenterPicker.tsx`
- Self-contained Leaflet minimap component
- Props: `lat`, `lon`, `zoom` (current saved values or null), `onSave(lat, lon, zoom)`, `onClear()`
- Internal state tracks minimap position as user pans/zooms
- Renders buttons and status text below the map

### Fallback Chain

Updated `getMapCenter()` in `NodesTab.tsx`:

1. Saved localStorage position (logged-in user's last session)
2. **Configured default center** (from server settings — available to anonymous users)
3. Calculated from visible nodes
4. **World view** `[20, 0]` at zoom ~2 (replaces Miami hardcode)

The configured default zoom is only applied when the configured default center is used (step 2). Other fallback paths keep their existing zoom behavior.

## Files Modified

| File | Change |
|------|--------|
| `src/server/constants/settings.ts` | Add three keys to `VALID_SETTINGS_KEYS` |
| `src/contexts/SettingsContext.tsx` | Add state + setters for three new settings |
| `src/components/SettingsTab.tsx` | Add minimap section, wire local state + dependency arrays |
| `src/components/configuration/DefaultMapCenterPicker.tsx` | New component |
| `src/components/NodesTab.tsx` | Update `getMapCenter()` fallback chain |

## Out of Scope

- The second part of issue #2317 (clicking a ROUTER_LATE node not moving the map) is a separate bug, not addressed here.
- No changes to MapCenterController or node click behavior.
