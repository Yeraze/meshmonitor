# Polar Grid Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a switchable polar grid overlay (range rings + 30-degree azimuth sector lines + labels) centered on the user's own node position, toggled via map controls.

**Architecture:** New `PolarGridOverlay` component using react-leaflet primitives (Circle, Polyline, Marker with DivIcon), driven by a `showPolarGrid` toggle in MapContext. Ring distances auto-scale based on map zoom. Colors are theme-aware via overlayColors.ts.

**Tech Stack:** React, react-leaflet, Leaflet, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-polar-grid-overlay-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/utils/polarGrid.ts` | Create | Ring calculation logic (`getPolarGridRings`) and sector endpoint calculation (`getSectorEndpoint`) |
| `src/utils/polarGrid.test.ts` | Create | Unit tests for ring/sector calculations |
| `src/config/overlayColors.ts` | Modify | Add `polarGrid` to `OverlayColors` interface + both scheme objects |
| `src/config/overlayColors.test.ts` | Modify | Update "same keys" test (auto-passes) |
| `src/contexts/MapContext.tsx` | Modify | Add `showPolarGrid` state, setter, persistence, loading |
| `src/components/PolarGridOverlay.tsx` | Create | React-leaflet overlay component |
| `src/components/PolarGridOverlay.test.tsx` | Create | Component rendering tests |
| `src/components/NodesTab.tsx` | Modify | Add checkbox toggle, conditional render, i18n for all overlay labels |
| `public/locales/en.json` | Modify | Add translation keys for all map overlay checkbox labels |

---

### Task 1: Polar Grid Ring Calculation Utility

**Files:**
- Create: `src/utils/polarGrid.ts`
- Create: `src/utils/polarGrid.test.ts`

- [ ] **Step 1: Write failing tests for `getPolarGridRings`**

Create `src/utils/polarGrid.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getPolarGridRings } from './polarGrid';

describe('getPolarGridRings', () => {
  describe('metric units', () => {
    it('returns 5 rings at zoom 13 with km intervals', () => {
      const rings = getPolarGridRings(13, 'km');
      expect(rings).toHaveLength(5);
      expect(rings[0]).toEqual({ radiusMeters: 1000, label: '1 km' });
      expect(rings[4]).toEqual({ radiusMeters: 5000, label: '5 km' });
    });

    it('returns smaller intervals at high zoom', () => {
      const rings = getPolarGridRings(16, 'km');
      expect(rings.length).toBeGreaterThanOrEqual(4);
      expect(rings.length).toBeLessThanOrEqual(6);
      expect(rings[0].radiusMeters).toBeLessThan(500);
    });

    it('returns larger intervals at low zoom', () => {
      const rings = getPolarGridRings(8, 'km');
      expect(rings.length).toBeGreaterThanOrEqual(4);
      expect(rings.length).toBeLessThanOrEqual(6);
      expect(rings[0].radiusMeters).toBeGreaterThan(5000);
    });

    it('labels use m for sub-kilometer distances', () => {
      const rings = getPolarGridRings(16, 'km');
      expect(rings[0].label).toMatch(/\d+ m$/);
    });

    it('labels use km for kilometer+ distances', () => {
      const rings = getPolarGridRings(13, 'km');
      expect(rings[0].label).toMatch(/\d+ km$/);
    });
  });

  describe('imperial units', () => {
    it('returns rings with mi labels', () => {
      const rings = getPolarGridRings(13, 'mi');
      expect(rings[0].label).toMatch(/mi$/);
    });

    it('labels use ft for sub-mile distances', () => {
      const rings = getPolarGridRings(16, 'mi');
      expect(rings[0].label).toMatch(/\d+ ft$/);
    });
  });

  describe('all zoom levels produce valid output', () => {
    for (let zoom = 3; zoom <= 18; zoom++) {
      it(`zoom ${zoom} returns 4-6 rings`, () => {
        const rings = getPolarGridRings(zoom, 'km');
        expect(rings.length).toBeGreaterThanOrEqual(4);
        expect(rings.length).toBeLessThanOrEqual(6);
      });

      it(`zoom ${zoom} has monotonically increasing radii`, () => {
        const rings = getPolarGridRings(zoom, 'km');
        for (let i = 1; i < rings.length; i++) {
          expect(rings[i].radiusMeters).toBeGreaterThan(rings[i - 1].radiusMeters);
        }
      });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/polarGrid.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `getPolarGridRings` implementation**

Create `src/utils/polarGrid.ts`:

```typescript
import type { DistanceUnit } from '../contexts/SettingsContext.js';

export interface PolarGridRing {
  radiusMeters: number;
  label: string;
}

/**
 * Zoom-level to ring interval mapping.
 * Each entry: [intervalMeters, ringCount]
 * Tuned so rings are visually useful at each zoom level.
 */
const zoomIntervals: Record<number, [number, number]> = {
  3:  [500000, 5],   // 500 km intervals
  4:  [200000, 5],   // 200 km
  5:  [100000, 5],   // 100 km
  6:  [50000,  5],   // 50 km
  7:  [20000,  5],   // 20 km
  8:  [10000,  5],   // 10 km
  9:  [5000,   5],   // 5 km
  10: [5000,   5],   // 5 km
  11: [2000,   5],   // 2 km
  12: [1000,   5],   // 1 km
  13: [1000,   5],   // 1 km
  14: [500,    5],   // 500 m
  15: [200,    5],   // 200 m
  16: [100,    5],   // 100 m
  17: [50,     5],   // 50 m
  18: [20,     5],   // 20 m
};

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

function formatRingLabel(meters: number, unit: DistanceUnit): string {
  if (unit === 'mi') {
    const miles = meters / METERS_PER_MILE;
    if (miles < 0.1) {
      return `${Math.round(meters * FEET_PER_METER)} ft`;
    }
    if (miles < 10) {
      return `${parseFloat(miles.toFixed(1))} mi`;
    }
    return `${Math.round(miles)} mi`;
  }

  // Metric
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  const km = meters / 1000;
  if (km < 10) {
    return `${parseFloat(km.toFixed(1))} km`;
  }
  return `${Math.round(km)} km`;
}

/**
 * Calculate polar grid rings for a given zoom level and distance unit.
 * Returns 4-6 rings with monotonically increasing radii and formatted labels.
 */
export function getPolarGridRings(zoom: number, unit: DistanceUnit): PolarGridRing[] {
  // Clamp zoom to our table range
  const clampedZoom = Math.max(3, Math.min(18, Math.round(zoom)));
  const [interval, count] = zoomIntervals[clampedZoom];

  const rings: PolarGridRing[] = [];
  for (let i = 1; i <= count; i++) {
    const radiusMeters = interval * i;
    rings.push({
      radiusMeters,
      label: formatRingLabel(radiusMeters, unit),
    });
  }
  return rings;
}

/**
 * Calculate the lat/lng endpoint of a sector line at a given bearing and distance.
 * Uses the Haversine "destination point" formula for geodesic accuracy.
 */
export function getSectorEndpoint(
  center: { lat: number; lng: number },
  bearingDeg: number,
  distanceMeters: number
): { lat: number; lng: number } {
  const R = 6371000; // Earth radius in meters
  const lat1 = (center.lat * Math.PI) / 180;
  const lng1 = (center.lng * Math.PI) / 180;
  const bearing = (bearingDeg * Math.PI) / 180;
  const d = distanceMeters / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
    Math.cos(lat1) * Math.sin(d) * Math.cos(bearing)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );

  return {
    lat: (lat2 * 180) / Math.PI,
    lng: (lng2 * 180) / Math.PI,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/polarGrid.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Add tests for `getSectorEndpoint`**

Append to `src/utils/polarGrid.test.ts`:

```typescript
import { getSectorEndpoint } from './polarGrid';

describe('getSectorEndpoint', () => {
  const center = { lat: 40.0, lng: -74.0 };

  it('north bearing increases latitude', () => {
    const endpoint = getSectorEndpoint(center, 0, 1000);
    expect(endpoint.lat).toBeGreaterThan(center.lat);
    expect(endpoint.lng).toBeCloseTo(center.lng, 4);
  });

  it('east bearing increases longitude', () => {
    const endpoint = getSectorEndpoint(center, 90, 1000);
    expect(endpoint.lng).toBeGreaterThan(center.lng);
    expect(endpoint.lat).toBeCloseTo(center.lat, 4);
  });

  it('south bearing decreases latitude', () => {
    const endpoint = getSectorEndpoint(center, 180, 1000);
    expect(endpoint.lat).toBeLessThan(center.lat);
  });

  it('returns center when distance is zero', () => {
    const endpoint = getSectorEndpoint(center, 45, 0);
    expect(endpoint.lat).toBeCloseTo(center.lat, 10);
    expect(endpoint.lng).toBeCloseTo(center.lng, 10);
  });
});
```

- [ ] **Step 6: Run all polar grid tests**

Run: `npx vitest run src/utils/polarGrid.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/utils/polarGrid.ts src/utils/polarGrid.test.ts
git commit -m "feat(#2307): add polar grid ring and sector calculation utilities"
```

---

### Task 2: Overlay Colors Configuration

**Files:**
- Modify: `src/config/overlayColors.ts` (interface ~line 3, dark ~line 24, light ~line 45)
- Existing test: `src/config/overlayColors.test.ts` (auto-passes via "same keys" test)

- [ ] **Step 1: Add `polarGrid` to `OverlayColors` interface**

In `src/config/overlayColors.ts`, add to the `OverlayColors` interface (after the `snrColors` block):

```typescript
  polarGrid: {
    rings: string;
    sectors: string;
    cardinalSectors: string;
    labels: string;
  };
```

- [ ] **Step 2: Add dark scheme colors**

In the `darkOverlayColors` object, add:

```typescript
  polarGrid: {
    rings: 'rgba(0, 200, 255, 0.3)',
    sectors: 'rgba(0, 200, 255, 0.15)',
    cardinalSectors: 'rgba(0, 200, 255, 0.3)',
    labels: 'rgba(0, 200, 255, 0.7)',
  },
```

- [ ] **Step 3: Add light scheme colors**

In the `lightOverlayColors` object, add:

```typescript
  polarGrid: {
    rings: 'rgba(0, 80, 130, 0.3)',
    sectors: 'rgba(0, 80, 130, 0.15)',
    cardinalSectors: 'rgba(0, 80, 130, 0.3)',
    labels: 'rgba(0, 80, 130, 0.7)',
  },
```

- [ ] **Step 4: Run overlay colors tests**

Run: `npx vitest run src/config/overlayColors.test.ts`
Expected: All tests PASS (the "dark and light schemes have same keys" test validates both have `polarGrid`)

- [ ] **Step 5: Commit**

```bash
git add src/config/overlayColors.ts
git commit -m "feat(#2307): add polar grid colors to overlay color schemes"
```

---

### Task 3: MapContext Toggle State

**Files:**
- Modify: `src/contexts/MapContext.tsx`

- [ ] **Step 1: Add to `MapContextType` interface**

After the `showAccuracyRegions` / `setShowAccuracyRegions` pair (~line 56), add:

```typescript
  showPolarGrid: boolean;
  setShowPolarGrid: (show: boolean) => void;
```

- [ ] **Step 2: Add state declaration**

After the `showAccuracyRegions` state line (~line 102), add:

```typescript
  const [showPolarGrid, setShowPolarGridState] = useState<boolean>(false);
```

- [ ] **Step 3: Add setter with persistence**

After the `setShowAccuracyRegions` useCallback (~line 176), add:

```typescript
  const setShowPolarGrid = React.useCallback((value: boolean) => {
    setShowPolarGridState(value);
    savePreferenceToServer({ showPolarGrid: value });
  }, []);
```

- [ ] **Step 4: Add preference loading**

In the preference-loading block (after the `showAccuracyRegions` loading ~line 273), add:

```typescript
            if (preferences.showPolarGrid !== undefined) {
              setShowPolarGridState(preferences.showPolarGrid);
            }
```

- [ ] **Step 5: Add to context value**

In the context value object (after `showAccuracyRegions` / `setShowAccuracyRegions` ~line 339), add:

```typescript
        showPolarGrid,
        setShowPolarGrid,
```

- [ ] **Step 6: Run existing MapContext tests**

Run: `npx vitest run src/contexts/MapContext.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/contexts/MapContext.tsx
git commit -m "feat(#2307): add showPolarGrid toggle to MapContext"
```

---

### Task 4: PolarGridOverlay Component

**Files:**
- Create: `src/components/PolarGridOverlay.tsx`
- Create: `src/components/PolarGridOverlay.test.tsx`

- [ ] **Step 1: Write failing component test**

Create `src/components/PolarGridOverlay.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock react-leaflet before imports
vi.mock('react-leaflet', () => ({
  Circle: ({ center, radius, pathOptions }: any) => (
    <div data-testid="circle" data-radius={radius} data-lat={center[0]} data-lng={center[1]} />
  ),
  Polyline: ({ positions, pathOptions }: any) => (
    <div data-testid="polyline" />
  ),
  Marker: ({ position, icon }: any) => (
    <div data-testid="marker" data-lat={position[0]} data-lng={position[1]} />
  ),
  useMap: () => ({
    getZoom: () => 13,
    on: vi.fn(),
    off: vi.fn(),
  }),
}));

vi.mock('leaflet', () => ({
  divIcon: ({ html, className }: any) => ({ html, className }),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    distanceUnit: 'km' as const,
    selectedTileset: 'osm',
    customOverlayScheme: undefined,
  }),
}));

vi.mock('../config/overlayColors', () => ({
  getOverlayColors: () => ({
    polarGrid: {
      rings: 'rgba(0,200,255,0.3)',
      sectors: 'rgba(0,200,255,0.15)',
      cardinalSectors: 'rgba(0,200,255,0.3)',
      labels: 'rgba(0,200,255,0.7)',
    },
  }),
  getSchemeForTileset: () => 'dark',
}));

import { render, screen } from '@testing-library/react';
import PolarGridOverlay from './PolarGridOverlay';

describe('PolarGridOverlay', () => {
  it('renders circles for range rings', () => {
    const { container } = render(
      <PolarGridOverlay center={{ lat: 40, lng: -74 }} />
    );
    const circles = container.querySelectorAll('[data-testid="circle"]');
    expect(circles.length).toBeGreaterThanOrEqual(4);
    expect(circles.length).toBeLessThanOrEqual(6);
  });

  it('renders 12 sector polylines', () => {
    const { container } = render(
      <PolarGridOverlay center={{ lat: 40, lng: -74 }} />
    );
    const polylines = container.querySelectorAll('[data-testid="polyline"]');
    expect(polylines).toHaveLength(12);
  });

  it('renders distance and degree label markers', () => {
    const { container } = render(
      <PolarGridOverlay center={{ lat: 40, lng: -74 }} />
    );
    const markers = container.querySelectorAll('[data-testid="marker"]');
    // 5 distance labels + 12 degree labels = 17
    expect(markers.length).toBeGreaterThanOrEqual(16);
  });

  it('centers circles on provided position', () => {
    const { container } = render(
      <PolarGridOverlay center={{ lat: 35.5, lng: -120.3 }} />
    );
    const circle = container.querySelector('[data-testid="circle"]');
    expect(circle?.getAttribute('data-lat')).toBe('35.5');
    expect(circle?.getAttribute('data-lng')).toBe('-120.3');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/PolarGridOverlay.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write PolarGridOverlay component**

Create `src/components/PolarGridOverlay.tsx`:

```tsx
import React, { useMemo, useState, useEffect } from 'react';
import { Circle, Polyline, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useSettings } from '../contexts/SettingsContext.js';
import { getOverlayColors, getSchemeForTileset } from '../config/overlayColors.js';
import { getPolarGridRings, getSectorEndpoint } from '../utils/polarGrid.js';

interface PolarGridOverlayProps {
  center: { lat: number; lng: number };
}

const SECTOR_BEARINGS = Array.from({ length: 12 }, (_, i) => i * 30); // 0, 30, 60, ..., 330
const CARDINAL_BEARINGS = new Set([0, 90, 180, 270]);
const DEGREE_LABELS = ['0', '30', '60', '90', '120', '150', '180', '210', '240', '270', '300', '330'];

const PolarGridOverlay: React.FC<PolarGridOverlayProps> = ({ center }) => {
  const map = useMap();
  const { distanceUnit, selectedTileset, customOverlayScheme } = useSettings();
  const [zoom, setZoom] = useState(map.getZoom());

  useEffect(() => {
    const onZoomEnd = () => setZoom(map.getZoom());
    map.on('zoomend', onZoomEnd);
    return () => { map.off('zoomend', onZoomEnd); };
  }, [map]);

  const scheme = getSchemeForTileset(selectedTileset || 'osm', customOverlayScheme);
  const colors = getOverlayColors(scheme);
  const centerLatLng: [number, number] = [center.lat, center.lng];

  const rings = useMemo(
    () => getPolarGridRings(zoom, distanceUnit),
    [zoom, distanceUnit]
  );

  const outerRadius = rings.length > 0 ? rings[rings.length - 1].radiusMeters : 0;

  const sectorLines = useMemo(() => {
    if (outerRadius === 0) return [];
    return SECTOR_BEARINGS.map((bearing) => {
      const endpoint = getSectorEndpoint(center, bearing, outerRadius);
      return {
        bearing,
        positions: [centerLatLng, [endpoint.lat, endpoint.lng] as [number, number]],
        isCardinal: CARDINAL_BEARINGS.has(bearing),
      };
    });
  }, [center.lat, center.lng, outerRadius]);

  const distanceLabels = useMemo(() => {
    return rings.map((ring) => {
      // Place labels along north axis (bearing 0)
      const pos = getSectorEndpoint(center, 0, ring.radiusMeters);
      return {
        position: [pos.lat, pos.lng] as [number, number],
        label: ring.label,
      };
    });
  }, [center.lat, center.lng, rings]);

  const degreeLabels = useMemo(() => {
    if (outerRadius === 0) return [];
    return SECTOR_BEARINGS.map((bearing, i) => {
      const pos = getSectorEndpoint(center, bearing, outerRadius * 1.08);
      return {
        position: [pos.lat, pos.lng] as [number, number],
        label: DEGREE_LABELS[i] + '\u00B0',
      };
    });
  }, [center.lat, center.lng, outerRadius]);

  return (
    <>
      {/* Range rings */}
      {rings.map((ring) => (
        <Circle
          key={`polar-ring-${ring.radiusMeters}`}
          center={centerLatLng}
          radius={ring.radiusMeters}
          pathOptions={{
            color: colors.polarGrid.rings,
            weight: 1,
            fill: false,
            interactive: false,
          }}
        />
      ))}

      {/* Sector lines */}
      {sectorLines.map((sector) => (
        <Polyline
          key={`polar-sector-${sector.bearing}`}
          positions={sector.positions}
          pathOptions={{
            color: sector.isCardinal
              ? colors.polarGrid.cardinalSectors
              : colors.polarGrid.sectors,
            weight: 1,
            dashArray: sector.isCardinal ? undefined : '4 4',
            interactive: false,
          }}
        />
      ))}

      {/* Distance labels along north axis */}
      {distanceLabels.map((item) => (
        <Marker
          key={`polar-dist-${item.label}`}
          position={item.position}
          interactive={false}
          icon={L.divIcon({
            className: 'polar-grid-label',
            html: `<span style="color:${colors.polarGrid.labels};font-size:11px;font-family:monospace;white-space:nowrap;text-shadow:0 0 3px rgba(0,0,0,0.7)">${item.label}</span>`,
            iconSize: [0, 0],
            iconAnchor: [-4, 6],
          })}
        />
      ))}

      {/* Degree labels at outer ring */}
      {degreeLabels.map((item) => (
        <Marker
          key={`polar-deg-${item.label}`}
          position={item.position}
          interactive={false}
          icon={L.divIcon({
            className: 'polar-grid-label',
            html: `<span style="color:${colors.polarGrid.labels};font-size:10px;font-family:monospace;white-space:nowrap;text-shadow:0 0 3px rgba(0,0,0,0.7)">${item.label}</span>`,
            iconSize: [0, 0],
            iconAnchor: [8, 8],
          })}
        />
      ))}
    </>
  );
};

export default PolarGridOverlay;
```

- [ ] **Step 4: Run component tests**

Run: `npx vitest run src/components/PolarGridOverlay.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/PolarGridOverlay.tsx src/components/PolarGridOverlay.test.tsx
git commit -m "feat(#2307): add PolarGridOverlay component with tests"
```

---

### Task 5: Integrate into NodesTab + i18n for All Map Overlay Labels

**Files:**
- Modify: `src/components/NodesTab.tsx`
- Modify: `public/locales/en.json`

**Note:** Use pattern matching (search for existing label text) rather than relying on exact line numbers, as NodesTab is large and line numbers shift frequently.

- [ ] **Step 1: Add translation keys to `public/locales/en.json`**

Add a `map` section (or extend if one exists) with keys for all overlay checkbox labels:

```json
  "map": {
    "showRouteSegments": "Show Route Segments",
    "showNeighborInfo": "Show Neighbor Info",
    "showTraceroute": "Show Traceroute",
    "showMqtt": "Show MQTT",
    "showMeshCore": "Show MeshCore",
    "showPositionHistory": "Show Position History",
    "showAnimations": "Show Animations",
    "showEstimatedPositions": "Show Estimated Positions",
    "showAccuracyRegions": "Show Accuracy Regions",
    "showPolarGrid": "Show Polar Grid",
    "polarGridDisabledTooltip": "Requires own node position"
  }
```

- [ ] **Step 2: Add imports to NodesTab.tsx**

At the top of `NodesTab.tsx`, add the import (near other component imports):

```typescript
import PolarGridOverlay from './PolarGridOverlay.js';
```

- [ ] **Step 3: Destructure from MapContext**

Where other map context values are destructured (search for `setShowAccuracyRegions`), add:

```typescript
    showPolarGrid,
    setShowPolarGrid,
```

- [ ] **Step 4: Resolve own node position**

The `homeNode` variable already exists (search for `homeNode`). Derive the position for the overlay. Near that line, add:

```typescript
  const ownNodePosition = homeNode?.position?.latitude && homeNode?.position?.longitude
    ? { lat: homeNode.position.latitude, lng: homeNode.position.longitude }
    : null;
```

- [ ] **Step 5: Replace all hardcoded checkbox labels with `t()` calls**

The `t` function is already imported via `useTranslation()`. Replace each hardcoded `<span>` with `t()` calls. Search for each string and replace:

```tsx
// <span>Show Route Segments</span> →
<span>{t('map.showRouteSegments')}</span>

// <span>Show Neighbor Info</span> →
<span>{t('map.showNeighborInfo')}</span>

// <span>Show Traceroute</span> →
<span>{t('map.showTraceroute')}</span>

// <span>Show MQTT</span> →
<span>{t('map.showMqtt')}</span>

// <span>Show MeshCore</span> →
<span>{t('map.showMeshCore')}</span>

// <span>Show Position History</span> →
<span>{t('map.showPositionHistory')}</span>

// <span>Show Animations</span> →
<span>{t('map.showAnimations')}</span>

// <span>Show Estimated Positions</span> →
<span>{t('map.showEstimatedPositions')}</span>

// <span>Show Accuracy Regions</span> →
<span>{t('map.showAccuracyRegions')}</span>
```

- [ ] **Step 6: Add polar grid checkbox toggle**

After the "Show Accuracy Regions" `</label>` closing tag, and BEFORE the Packet Monitor conditional block (`{canViewPacketMonitor && ...}`), add:

```tsx
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showPolarGrid}
                      onChange={(e) => setShowPolarGrid(e.target.checked)}
                      disabled={!ownNodePosition}
                    />
                    <span title={!ownNodePosition ? t('map.polarGridDisabledTooltip') : undefined}>
                      {t('map.showPolarGrid')}
                    </span>
                  </label>
```

- [ ] **Step 7: Add conditional render in MapContainer**

Inside the `MapContainer`, after the accuracy regions conditional render block (search for `showAccuracyRegions &&`), add:

```tsx
              {showPolarGrid && ownNodePosition && (
                <PolarGridOverlay center={ownNodePosition} />
              )}
```

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (0 failures)

- [ ] **Step 9: Commit**

```bash
git add src/components/NodesTab.tsx public/locales/en.json
git commit -m "feat(#2307): integrate polar grid overlay and i18n for all map overlay labels"
```

---

### Task 7: Manual Verification & Cleanup

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: No TypeScript errors, clean build

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, 0 failures

- [ ] **Step 3: Run system tests**

Run: `tests/system-tests.sh`
Expected: All system tests pass

- [ ] **Step 4: Final commit if any cleanup needed**

Only if build/tests revealed issues requiring fixes.
