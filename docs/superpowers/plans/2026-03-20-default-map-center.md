# Default Map Center Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow instance operators to configure a default map center position via a minimap picker in Settings, replacing the hardcoded Miami fallback.

**Architecture:** Three new server-persisted settings (`defaultMapCenterLat`, `defaultMapCenterLon`, `defaultMapCenterZoom`) follow the existing settings pattern through constants, context, and settings tab. A new `DefaultMapCenterPicker` component provides a minimap UI. The `getMapCenter()` fallback chain is updated to use the configured default, and the absolute last resort changes from Miami to a world view.

**Tech Stack:** React, Leaflet (react-leaflet), TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-20-default-map-center-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/server/constants/settings.ts` | Modify | Add 3 keys to VALID_SETTINGS_KEYS |
| `src/contexts/SettingsContext.tsx` | Modify | State, setters, hydration for 3 new settings |
| `src/components/configuration/DefaultMapCenterPicker.tsx` | Create | Minimap picker component |
| `src/components/SettingsTab.tsx` | Modify | Local state, handleSave, resetChanges, UI section |
| `src/components/NodesTab.tsx` | Modify | Updated getMapCenter() fallback chain |
| `src/components/configuration/DefaultMapCenterPicker.test.tsx` | Create | Component tests |
| `src/components/NodesTab.test.tsx` | Modify (or create) | Tests for getMapCenter fallback chain |

---

## Task 1: Add Settings Keys

**Files:**
- Modify: `src/server/constants/settings.ts`

- [ ] **Step 1: Add keys to VALID_SETTINGS_KEYS**

Add the three new keys at the end of the array, before the closing `]`:

```typescript
  'defaultMapCenterLat',
  'defaultMapCenterLon',
  'defaultMapCenterZoom',
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/constants/settings.ts
git commit -m "feat(settings): add default map center keys to VALID_SETTINGS_KEYS"
```

---

## Task 2: Add Settings Context State

**Files:**
- Modify: `src/contexts/SettingsContext.tsx`

- [ ] **Step 1: Add to SettingsContextType interface**

Add near the other map-related fields (around line 64, after `neighborInfoMinZoom`):

```typescript
  defaultMapCenterLat: number | null;
  defaultMapCenterLon: number | null;
  defaultMapCenterZoom: number | null;
  setDefaultMapCenterLat: (lat: number | null) => void;
  setDefaultMapCenterLon: (lon: number | null) => void;
  setDefaultMapCenterZoom: (zoom: number | null) => void;
```

- [ ] **Step 2: Add state initialization**

Follow the `neighborInfoMinZoom` pattern (around line 229). Add after it:

```typescript
const [defaultMapCenterLat, setDefaultMapCenterLatState] = useState<number | null>(() => {
    const saved = localStorage.getItem('defaultMapCenterLat');
    return saved ? parseFloat(saved) : null;
});
const [defaultMapCenterLon, setDefaultMapCenterLonState] = useState<number | null>(() => {
    const saved = localStorage.getItem('defaultMapCenterLon');
    return saved ? parseFloat(saved) : null;
});
const [defaultMapCenterZoom, setDefaultMapCenterZoomState] = useState<number | null>(() => {
    const saved = localStorage.getItem('defaultMapCenterZoom');
    return saved ? parseInt(saved, 10) : null;
});
```

- [ ] **Step 3: Add setter functions**

Follow the `setNeighborInfoMinZoom` pattern (around line 440). Add after it:

```typescript
const setDefaultMapCenterLat = (lat: number | null) => {
    setDefaultMapCenterLatState(lat);
    if (lat !== null) {
        localStorage.setItem('defaultMapCenterLat', String(lat));
    } else {
        localStorage.removeItem('defaultMapCenterLat');
    }
};
const setDefaultMapCenterLon = (lon: number | null) => {
    setDefaultMapCenterLonState(lon);
    if (lon !== null) {
        localStorage.setItem('defaultMapCenterLon', String(lon));
    } else {
        localStorage.removeItem('defaultMapCenterLon');
    }
};
const setDefaultMapCenterZoom = (zoom: number | null) => {
    setDefaultMapCenterZoomState(zoom);
    if (zoom !== null) {
        localStorage.setItem('defaultMapCenterZoom', String(zoom));
    } else {
        localStorage.removeItem('defaultMapCenterZoom');
    }
};
```

- [ ] **Step 4: Add hydration in loadServerSettings**

Follow the `neighborInfoMinZoom` hydration pattern (around line 877). Add after it:

```typescript
if (settings.defaultMapCenterLat !== undefined) {
    const lat = parseFloat(settings.defaultMapCenterLat);
    if (!isNaN(lat) && lat >= -90 && lat <= 90) {
        setDefaultMapCenterLatState(lat);
        localStorage.setItem('defaultMapCenterLat', String(lat));
    } else {
        setDefaultMapCenterLatState(null);
        localStorage.removeItem('defaultMapCenterLat');
    }
}
if (settings.defaultMapCenterLon !== undefined) {
    const lon = parseFloat(settings.defaultMapCenterLon);
    if (!isNaN(lon) && lon >= -180 && lon <= 180) {
        setDefaultMapCenterLonState(lon);
        localStorage.setItem('defaultMapCenterLon', String(lon));
    } else {
        setDefaultMapCenterLonState(null);
        localStorage.removeItem('defaultMapCenterLon');
    }
}
if (settings.defaultMapCenterZoom !== undefined) {
    const zoom = parseInt(settings.defaultMapCenterZoom, 10);
    if (!isNaN(zoom) && zoom >= 1 && zoom <= 18) {
        setDefaultMapCenterZoomState(zoom);
        localStorage.setItem('defaultMapCenterZoom', String(zoom));
    } else {
        setDefaultMapCenterZoomState(null);
        localStorage.removeItem('defaultMapCenterZoom');
    }
}
```

- [ ] **Step 5: Add to provider value object**

Add the six new entries (3 state values + 3 setters) to the `value` object in the provider's `useMemo`:

```typescript
defaultMapCenterLat,
defaultMapCenterLon,
defaultMapCenterZoom,
setDefaultMapCenterLat,
setDefaultMapCenterLon,
setDefaultMapCenterZoom,
```

- [ ] **Step 6: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/contexts/SettingsContext.tsx
git commit -m "feat(settings): add default map center state to SettingsContext"
```

---

## Task 3: Create DefaultMapCenterPicker Component

**Files:**
- Create: `src/components/configuration/DefaultMapCenterPicker.tsx`
- Create: `src/components/configuration/DefaultMapCenterPicker.test.tsx`

- [ ] **Step 1: Write the component test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DefaultMapCenterPicker } from './DefaultMapCenterPicker';

// Mock react-leaflet to avoid Leaflet DOM issues in tests
vi.mock('react-leaflet', () => ({
    MapContainer: ({ children }: any) => <div data-testid="minimap">{children}</div>,
    TileLayer: () => null,
    useMap: () => ({
        getCenter: () => ({ lat: 40.0, lng: -74.0 }),
        getZoom: () => 10,
    }),
    useMapEvents: () => null,
}));

describe('DefaultMapCenterPicker', () => {
    it('renders with unconfigured state', () => {
        render(
            <DefaultMapCenterPicker
                lat={null}
                lon={null}
                zoom={null}
                onSave={vi.fn()}
                onClear={vi.fn()}
            />
        );
        expect(screen.getByText(/no default center configured/i)).toBeInTheDocument();
        expect(screen.getByText(/save as default/i)).toBeInTheDocument();
    });

    it('renders with configured state', () => {
        render(
            <DefaultMapCenterPicker
                lat={40.7128}
                lon={-74.006}
                zoom={12}
                onSave={vi.fn()}
                onClear={vi.fn()}
            />
        );
        expect(screen.getByText(/40\.7128/)).toBeInTheDocument();
        expect(screen.getByText(/-74\.006/)).toBeInTheDocument();
    });

    it('calls onClear when Clear button is clicked', () => {
        const onClear = vi.fn();
        render(
            <DefaultMapCenterPicker
                lat={40.7128}
                lon={-74.006}
                zoom={12}
                onSave={vi.fn()}
                onClear={onClear}
            />
        );
        fireEvent.click(screen.getByText(/clear/i));
        expect(onClear).toHaveBeenCalledOnce();
    });

    it('calls onSave when Save as Default is clicked', () => {
        const onSave = vi.fn();
        render(
            <DefaultMapCenterPicker
                lat={null}
                lon={null}
                zoom={null}
                onSave={onSave}
                onClear={vi.fn()}
            />
        );
        fireEvent.click(screen.getByText(/save as default/i));
        expect(onSave).toHaveBeenCalledOnce();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/configuration/DefaultMapCenterPicker.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write the component**

```typescript
import React, { useCallback, useRef, useEffect } from 'react';
import { MapContainer, TileLayer, useMapEvents, useMap } from 'react-leaflet';
import type { Map as LeafletMap } from 'leaflet';

interface DefaultMapCenterPickerProps {
    lat: number | null;
    lon: number | null;
    zoom: number | null;
    onSave: (lat: number, lon: number, zoom: number) => void;
    onClear: () => void;
}

const WORLD_CENTER: [number, number] = [20, 0];
const WORLD_ZOOM = 2;
const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function MapPositionTracker({ onMove }: { onMove: (lat: number, lon: number, zoom: number) => void }) {
    useMapEvents({
        moveend: (e) => {
            const map = e.target;
            const center = map.getCenter();
            onMove(center.lat, center.lng, map.getZoom());
        },
    });
    return null;
}

function MapInitializer({ lat, lon, zoom }: { lat: number | null; lon: number | null; zoom: number | null }) {
    const map = useMap();
    const initialized = useRef(false);

    useEffect(() => {
        if (!initialized.current) {
            initialized.current = true;
            if (lat !== null && lon !== null && zoom !== null) {
                map.setView([lat, lon], zoom);
            }
        }
    }, [map, lat, lon, zoom]);

    return null;
}

export const DefaultMapCenterPicker: React.FC<DefaultMapCenterPickerProps> = ({
    lat,
    lon,
    zoom,
    onSave,
    onClear,
}) => {
    const currentPosition = useRef<{ lat: number; lon: number; zoom: number }>({
        lat: lat ?? WORLD_CENTER[0],
        lon: lon ?? WORLD_CENTER[1],
        zoom: zoom ?? WORLD_ZOOM,
    });

    const handleMove = useCallback((newLat: number, newLon: number, newZoom: number) => {
        currentPosition.current = { lat: newLat, lon: newLon, zoom: newZoom };
    }, []);

    const handleSave = useCallback(() => {
        const { lat, lon, zoom } = currentPosition.current;
        onSave(lat, lon, zoom);
    }, [onSave]);

    const isConfigured = lat !== null && lon !== null && zoom !== null;
    const initialCenter: [number, number] = isConfigured ? [lat, lon] : WORLD_CENTER;
    const initialZoom = isConfigured ? zoom : WORLD_ZOOM;

    return (
        <div>
            <div style={{ height: '300px', width: '100%', marginBottom: '8px' }}>
                <MapContainer
                    center={initialCenter}
                    zoom={initialZoom}
                    style={{ height: '100%', width: '100%' }}
                >
                    <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} />
                    <MapPositionTracker onMove={handleMove} />
                    <MapInitializer lat={lat} lon={lon} zoom={zoom} />
                </MapContainer>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button onClick={handleSave} className="btn btn-primary btn-sm">
                    Save as Default
                </button>
                {isConfigured && (
                    <button onClick={onClear} className="btn btn-outline-secondary btn-sm">
                        Clear
                    </button>
                )}
                <span style={{ marginLeft: '8px', fontSize: '0.85em', color: '#888' }}>
                    {isConfigured
                        ? `Default: ${lat.toFixed(4)}, ${lon.toFixed(4)} (zoom ${zoom})`
                        : 'No default center configured'}
                </span>
            </div>
        </div>
    );
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/configuration/DefaultMapCenterPicker.test.tsx`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/configuration/DefaultMapCenterPicker.tsx src/components/configuration/DefaultMapCenterPicker.test.tsx
git commit -m "feat(ui): add DefaultMapCenterPicker minimap component"
```

---

## Task 4: Wire Into SettingsTab

**Files:**
- Modify: `src/components/SettingsTab.tsx`

- [ ] **Step 1: Add local state**

Near the other local state declarations (around line 174, after `localNeighborInfoMinZoom`):

```typescript
const [localDefaultMapCenterLat, setLocalDefaultMapCenterLat] = useState<number | null>(defaultMapCenterLat);
const [localDefaultMapCenterLon, setLocalDefaultMapCenterLon] = useState<number | null>(defaultMapCenterLon);
const [localDefaultMapCenterZoom, setLocalDefaultMapCenterZoom] = useState<number | null>(defaultMapCenterZoom);
```

Also destructure from useSettings at the top:
```typescript
const {
    // ... existing destructuring ...
    defaultMapCenterLat, defaultMapCenterLon, defaultMapCenterZoom,
    setDefaultMapCenterLat, setDefaultMapCenterLon, setDefaultMapCenterZoom,
} = useSettings();
```

- [ ] **Step 2: Add to hasChanges detection**

In the `hasChanges` useMemo (around line 356), add:

```typescript
localDefaultMapCenterLat !== defaultMapCenterLat ||
localDefaultMapCenterLon !== defaultMapCenterLon ||
localDefaultMapCenterZoom !== defaultMapCenterZoom
```

Add `localDefaultMapCenterLat`, `localDefaultMapCenterLon`, `localDefaultMapCenterZoom`, `defaultMapCenterLat`, `defaultMapCenterLon`, `defaultMapCenterZoom` to its dependency array.

- [ ] **Step 3: Add to handleSave**

In `handleSave` (around line 450), add to the settings object sent to the server:

```typescript
defaultMapCenterLat: localDefaultMapCenterLat !== null ? localDefaultMapCenterLat.toString() : '',
defaultMapCenterLon: localDefaultMapCenterLon !== null ? localDefaultMapCenterLon.toString() : '',
defaultMapCenterZoom: localDefaultMapCenterZoom !== null ? localDefaultMapCenterZoom.toString() : '',
```

After the server call succeeds, update context:

```typescript
setDefaultMapCenterLat(localDefaultMapCenterLat);
setDefaultMapCenterLon(localDefaultMapCenterLon);
setDefaultMapCenterZoom(localDefaultMapCenterZoom);
```

Add `localDefaultMapCenterLat`, `localDefaultMapCenterLon`, `localDefaultMapCenterZoom`, `setDefaultMapCenterLat`, `setDefaultMapCenterLon`, `setDefaultMapCenterZoom` to the `handleSave` dependency array.

- [ ] **Step 4: Add to resetChanges**

In `resetChanges` (around line 405), add:

```typescript
setLocalDefaultMapCenterLat(defaultMapCenterLat);
setLocalDefaultMapCenterLon(defaultMapCenterLon);
setLocalDefaultMapCenterZoom(defaultMapCenterZoom);
```

Add `defaultMapCenterLat`, `defaultMapCenterLon`, `defaultMapCenterZoom` to the `resetChanges` dependency array.

- [ ] **Step 5: Add minimap UI section**

Import the component:
```typescript
import { DefaultMapCenterPicker } from './configuration/DefaultMapCenterPicker';
```

Add a "Default Map Center" section near the existing map settings (after the map tileset/pin style section). Wire the callbacks:

```tsx
<h5>Default Map Center</h5>
<p className="text-muted small">
    Set the default map position for new visitors and shared links.
</p>
<DefaultMapCenterPicker
    lat={localDefaultMapCenterLat}
    lon={localDefaultMapCenterLon}
    zoom={localDefaultMapCenterZoom}
    onSave={(lat, lon, zoom) => {
        setLocalDefaultMapCenterLat(lat);
        setLocalDefaultMapCenterLon(lon);
        setLocalDefaultMapCenterZoom(zoom);
    }}
    onClear={() => {
        setLocalDefaultMapCenterLat(null);
        setLocalDefaultMapCenterLon(null);
        setLocalDefaultMapCenterZoom(null);
    }}
/>
```

- [ ] **Step 6: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/components/SettingsTab.tsx
git commit -m "feat(settings): wire default map center picker into SettingsTab"
```

---

## Task 5: Update Map Fallback Chain

**Files:**
- Modify: `src/components/NodesTab.tsx`

- [ ] **Step 1: Write tests for the new fallback chain**

The `getMapCenter` function is internal to the NodesTab component. Test the behavior by verifying the fallback priority. If a standalone test file for getMapCenter doesn't exist, add tests to an existing NodesTab test or create a focused one. Key test scenarios:

1. When localStorage mapCenter exists → uses it (existing behavior)
2. When no localStorage but configured default exists → uses configured default
3. When no localStorage, no configured default, but nodes exist → uses node average (existing behavior)
4. When nothing configured and no nodes → world view [20, 0] at zoom 2

- [ ] **Step 2: Import settings in NodesTab**

Add `defaultMapCenterLat`, `defaultMapCenterLon`, `defaultMapCenterZoom` to the useSettings destructuring in NodesTab.

- [ ] **Step 3: Update getMapCenter()**

Change the return type and logic (currently at lines 1058-1091):

```typescript
const getMapCenter = (): { center: [number, number]; zoom: number } => {
    // 1. Saved localStorage position (last session)
    if (mapCenter) {
        return { center: mapCenter, zoom: mapZoom };
    }

    // 2. Configured default center (from server settings)
    if (
        defaultMapCenterLat !== null &&
        defaultMapCenterLon !== null &&
        defaultMapCenterZoom !== null
    ) {
        return {
            center: [defaultMapCenterLat, defaultMapCenterLon],
            zoom: defaultMapCenterZoom,
        };
    }

    // 3. Calculated from visible nodes
    if (nodesWithPosition.length > 0) {
        if (currentNodeId) {
            const localNode = nodesWithPosition.find(node => node.user?.id === currentNodeId);
            if (localNode) {
                const effectivePos = getEffectivePosition(localNode);
                if (effectivePos.latitude != null && effectivePos.longitude != null) {
                    return { center: [effectivePos.latitude, effectivePos.longitude], zoom: mapZoom };
                }
            }
        }
        const avgLat = nodesWithPosition.reduce((sum, node) => {
            const pos = getEffectivePosition(node);
            return sum + (pos.latitude ?? 0);
        }, 0) / nodesWithPosition.length;
        const avgLng = nodesWithPosition.reduce((sum, node) => {
            const pos = getEffectivePosition(node);
            return sum + (pos.longitude ?? 0);
        }, 0) / nodesWithPosition.length;
        return { center: [avgLat, avgLng], zoom: mapZoom };
    }

    // 4. World view (absolute last resort)
    return { center: [20, 0], zoom: 2 };
};
```

- [ ] **Step 4: Update MapContainer usage**

Change the MapContainer to use the new return type (around line 1710):

```tsx
const mapDefaults = getMapCenter();
// ...
<MapContainer
    center={mapDefaults.center}
    zoom={mapDefaults.zoom}
    style={{ height: '100%', width: '100%' }}
>
```

`getMapCenter()` is only called once (line ~1711 in NodesTab.tsx). Confirm with a grep before proceeding — if any new callers have been added, update them too.

- [ ] **Step 5: Verify build and run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: Build succeeds, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/components/NodesTab.tsx
git commit -m "feat(map): update fallback chain with configured default center and world view"
```

---

## Task 6: Integration Testing

- [ ] **Step 1: Build and deploy locally**

```bash
docker compose -f docker-compose.dev.yml --profile sqlite build meshmonitor
docker compose -f docker-compose.dev.yml --profile sqlite up -d meshmonitor
```

- [ ] **Step 2: Verify settings UI**

1. Navigate to http://localhost:8081/meshmonitor
2. Log in as admin/changeme1
3. Go to Settings tab
4. Find "Default Map Center" section
5. Verify minimap shows world view (unconfigured state)
6. Pan to a location, click "Save as Default"
7. Verify status text updates with coordinates
8. Click general Save button
9. Refresh page — verify minimap shows saved location

- [ ] **Step 3: Verify fallback behavior**

1. Open an incognito window (no localStorage)
2. Navigate to http://localhost:8081/meshmonitor
3. Verify map starts at the configured default center, not Miami

- [ ] **Step 4: Verify clear behavior**

1. Go to Settings, click "Clear" on the minimap
2. Save settings
3. Open incognito window again
4. Verify map shows world view (if no nodes) or node-calculated center (if nodes exist)

- [ ] **Step 5: Run system tests**

```bash
tests/system-tests.sh
```

- [ ] **Step 6: Commit any fixes**

If any issues were found during integration testing, fix and commit them.
