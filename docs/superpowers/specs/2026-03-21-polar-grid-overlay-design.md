# Polar Grid Leaflet Overlay — Design Spec

**Issue:** #2307
**Date:** 2026-03-21
**Status:** Approved

## Overview

Add a switchable polar coordinates grid overlay to the Leaflet map, centered on the user's own node position. The grid displays concentric range rings, 30-degree sector (azimuth) lines, and labels for distance and bearing — providing at-a-glance range and direction information for surrounding nodes.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Grid style | Full sector grid | Range rings + 30-degree azimuth lines + degree/distance labels (closest to issue screenshot) |
| Ring distances | Auto-scale to zoom | Keeps the grid useful at any zoom level without user configuration |
| Toggle location | Map layer controls checkbox | Consistent with existing overlays (showPaths, showAccuracyRegions, etc.) |
| Distance units | Follow `distanceUnit` setting | Existing km/mi preference in SettingsContext |
| Colors | Theme-aware via overlayColors.ts | Light/dark scheme variants, matching existing overlay color pattern |
| Implementation | React-Leaflet components | Follows existing codebase patterns; no new dependencies |

## Architecture

### 1. State & Toggle — MapContext.tsx

New `showPolarGrid` boolean following the existing overlay toggle pattern:

- State + setter pair: `showPolarGrid` / `setShowPolarGrid`
- Persisted via `savePreferenceToServer({ showPolarGrid: value })`
- Loaded from server preferences on init
- Default: `false`

Checkbox in the map overlay controls panel alongside existing toggles. **Disabled with tooltip** ("Requires own node position") when own node has no position. Becomes enabled reactively when position is available.

### 2. Color Configuration — overlayColors.ts

New `polarGrid` entry in both light and dark schemes:

```typescript
polarGrid: {
  rings: 'rgba(0, 200, 255, 0.3)',
  sectors: 'rgba(0, 200, 255, 0.2)',
  cardinalSectors: 'rgba(0, 200, 255, 0.3)',
  labels: 'rgba(0, 200, 255, 0.7)',
}
```

Light scheme uses darker tones (e.g., `rgba(0, 80, 120, ...)`) tuned to match existing overlay color style.

### 3. Auto-Scale Ring Logic

Utility function: `getPolarGridRings(zoom: number, distanceUnit: DistanceUnit)`

- Maps zoom levels to ring intervals (e.g., zoom 15 → 200m, zoom 12 → 2km, zoom 8 → 50km)
- Always produces 4–6 rings for consistent visual density
- Returns `Array<{ radiusMeters: number, label: string }>`
- Labels formatted per `distanceUnit` (km or mi)
- Internal calculations always in meters (Leaflet's native unit)

Example at zoom 13, metric:
```
[
  { radiusMeters: 1000, label: "1 km" },
  { radiusMeters: 2000, label: "2 km" },
  { radiusMeters: 3000, label: "3 km" },
  { radiusMeters: 4000, label: "4 km" },
  { radiusMeters: 5000, label: "5 km" },
]
```

### 4. PolarGridOverlay Component

New file: `src/components/map/PolarGridOverlay.tsx`

**Context/props consumed:**
- Own node position: DataContext `currentNodeId` → node lookup → `{ lat, lng }`
- `distanceUnit` from SettingsContext
- Overlay colors from `getOverlayColors(scheme)`
- Current map zoom via react-leaflet `useMap()` hook

**Rendered elements:**
- **Range rings**: 4–6 react-leaflet `<Circle>` components (stroke only, no fill)
- **Sector lines**: 12 `<Polyline>` components at 30-degree intervals from center to outermost ring radius. Cardinal directions (0°/90°/180°/270°) use brighter `cardinalSectors` color
- **Distance labels**: Leaflet `DivIcon` markers along the north axis at each ring, showing "1 km", "2 km", etc.
- **Degree labels**: Small `DivIcon` markers at the outer ring edge at each 30-degree mark (0°, 30°, 60°, ... 330°)

**Behavior:**
- Listens to `zoomend` map event to recalculate ring intervals
- Centers on own node position; hidden if own node has no position
- Re-centers reactively if own node position changes

**Integration in NodesTab.tsx:**
```tsx
{showPolarGrid && ownNodePosition && (
  <PolarGridOverlay center={ownNodePosition} />
)}
```

### 5. Edge Cases & Constraints

| Scenario | Behavior |
|----------|----------|
| No own node position | Checkbox disabled with tooltip hint. Overlay not rendered. |
| Own node gains position | Checkbox becomes enabled reactively. |
| Own node moves | Grid re-centers (position from DataContext updates on mesh packets). |
| Very high zoom (street level) | Smallest interval ~50–100m rings. |
| Very low zoom (continental) | Largest interval ~100–200km rings. |
| Map panning | Leaflet handles repositioning natively — elements are geo-anchored. |

**Performance:** Max ~36 lightweight DOM elements (6 circles + 12 polylines + ~18 text markers). Well within react-leaflet's comfort zone.

## Files Modified

| File | Change |
|------|--------|
| `src/contexts/MapContext.tsx` | Add `showPolarGrid` state, setter, persistence |
| `src/config/overlayColors.ts` | Add `polarGrid` color entries for light/dark |
| `src/components/map/PolarGridOverlay.tsx` | **New** — overlay component |
| `src/components/NodesTab.tsx` | Render `PolarGridOverlay`, add checkbox toggle |

## Testing

- Unit tests for `getPolarGridRings()` — verify ring counts, intervals, and unit formatting across zoom levels
- Component test for `PolarGridOverlay` — verify renders circles/polylines when position available, renders nothing when not
- Toggle test — verify checkbox disabled state when no own node position
