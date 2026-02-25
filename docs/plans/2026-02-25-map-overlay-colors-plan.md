# Map Overlay Color Schemes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define light and dark overlay color schemes for map elements (traceroutes, neighbor lines, position history, hop markers) and auto-switch based on the active tileset.

**Architecture:** A new `src/config/overlayColors.ts` exports two color scheme objects and a tileset→scheme mapping. SettingsContext derives the active scheme from the current tileset. Consumer components (`useTraceroutePaths`, `NodesTab`, `mapHelpers`, `mapIcons`) read the scheme and pick the right colors. Custom tilesets get an `overlayScheme` field.

**Tech Stack:** TypeScript, React, Vitest

**Design doc:** `docs/plans/2026-02-25-map-overlay-colors-design.md`

---

### Task 1: Create `overlayColors.ts` config module

**Files:**
- Create: `src/config/overlayColors.ts`
- Create: `src/config/overlayColors.test.ts`

**Step 1: Create the overlay colors config**

Create `src/config/overlayColors.ts`:

```typescript
export type OverlayScheme = 'light' | 'dark';

export interface OverlayColors {
  tracerouteForward: string;
  tracerouteReturn: string;
  mqttSegment: string;
  neighborLine: string;
  positionHistoryOld: { r: number; g: number; b: number };
  positionHistoryNew: { r: number; g: number; b: number };
  hopColors: {
    local: string;
    noData: string;
    max: string;
    gradient: string[];
  };
}

export const darkOverlayColors: OverlayColors = {
  tracerouteForward: '#89b4fa',
  tracerouteReturn: '#f38ba8',
  mqttSegment: '#9399b2',
  neighborLine: '#cba6f7',
  positionHistoryOld: { r: 0, g: 191, b: 255 },
  positionHistoryNew: { r: 255, g: 69, b: 0 },
  hopColors: {
    local: '#22c55e',
    noData: '#9ca3af',
    max: '#FF0000',
    gradient: ['#0000FF', '#3300CC', '#660099', '#990066', '#CC0033', '#FF0000'],
  },
};

export const lightOverlayColors: OverlayColors = {
  tracerouteForward: '#1e66f5',
  tracerouteReturn: '#d20f39',
  mqttSegment: '#7c7f93',
  neighborLine: '#8839ef',
  positionHistoryOld: { r: 0, g: 103, b: 165 },
  positionHistoryNew: { r: 196, g: 32, b: 10 },
  hopColors: {
    local: '#15803d',
    noData: '#6b7280',
    max: '#b91c1c',
    gradient: ['#1d4ed8', '#4338ca', '#6d28d9', '#a21caf', '#be123c', '#b91c1c'],
  },
};

export function getOverlayColors(scheme: OverlayScheme): OverlayColors {
  return scheme === 'light' ? lightOverlayColors : darkOverlayColors;
}

/** Maps each built-in tileset ID to its overlay scheme */
export const tilesetSchemeMap: Record<string, OverlayScheme> = {
  osm: 'light',
  osmHot: 'light',
  cartoDark: 'dark',
  cartoLight: 'light',
  openTopo: 'light',
  esriSatellite: 'dark',
};

/** Get the overlay scheme for a tileset ID. Custom tilesets default to 'dark'. */
export function getSchemeForTileset(tilesetId: string, customOverlayScheme?: OverlayScheme): OverlayScheme {
  if (customOverlayScheme) return customOverlayScheme;
  return tilesetSchemeMap[tilesetId] ?? 'dark';
}
```

**Step 2: Write tests**

Create `src/config/overlayColors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  getOverlayColors,
  getSchemeForTileset,
  darkOverlayColors,
  lightOverlayColors,
  tilesetSchemeMap,
} from './overlayColors';

describe('overlayColors', () => {
  describe('getOverlayColors', () => {
    it('returns dark colors for dark scheme', () => {
      expect(getOverlayColors('dark')).toBe(darkOverlayColors);
    });

    it('returns light colors for light scheme', () => {
      expect(getOverlayColors('light')).toBe(lightOverlayColors);
    });
  });

  describe('getSchemeForTileset', () => {
    it('returns light for OSM', () => {
      expect(getSchemeForTileset('osm')).toBe('light');
    });

    it('returns dark for cartoDark', () => {
      expect(getSchemeForTileset('cartoDark')).toBe('dark');
    });

    it('returns dark for esriSatellite', () => {
      expect(getSchemeForTileset('esriSatellite')).toBe('dark');
    });

    it('defaults to dark for unknown tileset IDs', () => {
      expect(getSchemeForTileset('custom-abc')).toBe('dark');
    });

    it('uses customOverlayScheme when provided', () => {
      expect(getSchemeForTileset('custom-abc', 'light')).toBe('light');
    });

    it('customOverlayScheme overrides built-in mapping', () => {
      expect(getSchemeForTileset('osm', 'dark')).toBe('dark');
    });
  });

  describe('tilesetSchemeMap completeness', () => {
    it('maps all 6 built-in tilesets', () => {
      expect(Object.keys(tilesetSchemeMap)).toHaveLength(6);
      expect(tilesetSchemeMap).toHaveProperty('osm');
      expect(tilesetSchemeMap).toHaveProperty('osmHot');
      expect(tilesetSchemeMap).toHaveProperty('cartoDark');
      expect(tilesetSchemeMap).toHaveProperty('cartoLight');
      expect(tilesetSchemeMap).toHaveProperty('openTopo');
      expect(tilesetSchemeMap).toHaveProperty('esriSatellite');
    });
  });

  describe('color scheme structure', () => {
    it('dark and light schemes have same keys', () => {
      expect(Object.keys(darkOverlayColors).sort()).toEqual(Object.keys(lightOverlayColors).sort());
    });

    it('dark and light schemes have different traceroute forward colors', () => {
      expect(darkOverlayColors.tracerouteForward).not.toBe(lightOverlayColors.tracerouteForward);
    });
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run src/config/overlayColors.test.ts`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/config/overlayColors.ts src/config/overlayColors.test.ts
git commit -m "feat: add overlay color scheme config with light/dark variants (#2020)"
```

---

### Task 2: Add `overlayScheme` to SettingsContext

**Files:**
- Modify: `src/contexts/SettingsContext.tsx` (SettingsContextType interface, SettingsProvider)

**Step 1: Add overlayScheme to context**

In `src/contexts/SettingsContext.tsx`:

1. Add import at top:

```typescript
import { OverlayScheme, getSchemeForTileset, getOverlayColors, OverlayColors } from '../config/overlayColors';
```

2. Add to the `SettingsContextType` interface (near `mapTileset` around line 58):

```typescript
overlayScheme: OverlayScheme;
overlayColors: OverlayColors;
```

3. Inside `SettingsProvider`, add a derived value (after the `mapTileset` state around line 210):

```typescript
const overlayScheme = React.useMemo<OverlayScheme>(() => {
  const customTileset = customTilesets.find(ct => `custom-${ct.id}` === mapTileset);
  return getSchemeForTileset(mapTileset, customTileset?.overlayScheme);
}, [mapTileset, customTilesets]);

const overlayColors = React.useMemo(() => getOverlayColors(overlayScheme), [overlayScheme]);
```

4. Add `overlayScheme` and `overlayColors` to the context value object (near line 1001).

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors (the `customTileset?.overlayScheme` will warn until Task 5 adds the field — temporarily use `(customTileset as any)?.overlayScheme` and note a TODO)

**Step 3: Commit**

```bash
git add src/contexts/SettingsContext.tsx
git commit -m "feat: derive overlayScheme from active tileset in SettingsContext (#2020)"
```

---

### Task 3: Update `mapHelpers.tsx` — scheme-aware position history colors

**Files:**
- Modify: `src/utils/mapHelpers.tsx:210-241`

**Step 1: Refactor color constants to accept scheme colors**

In `src/utils/mapHelpers.tsx`, change the position history color functions (lines 210-241) from hardcoded constants to accepting parameters:

Replace lines 210-211:
```typescript
const POSITION_HISTORY_COLOR_OLD = { r: 0, g: 191, b: 255 }; // DeepSkyBlue → cyan-blue
const POSITION_HISTORY_COLOR_NEW = { r: 255, g: 69, b: 0 }; // OrangeRed → warm endpoint
```

With:
```typescript
// Default colors kept for backward compatibility — callers should pass overlayColors
const POSITION_HISTORY_COLOR_OLD = { r: 0, g: 191, b: 255 };
const POSITION_HISTORY_COLOR_NEW = { r: 255, g: 69, b: 0 };
```

Change `getPositionHistoryColor` (line 237-241) from:
```typescript
export const getPositionHistoryColor = (index: number, total: number): string => {
  if (total <= 1) return interpolateColor(POSITION_HISTORY_COLOR_OLD, POSITION_HISTORY_COLOR_NEW, 1);
  const ratio = index / (total - 1);
  return interpolateColor(POSITION_HISTORY_COLOR_OLD, POSITION_HISTORY_COLOR_NEW, ratio);
};
```

To:
```typescript
export const getPositionHistoryColor = (
  index: number,
  total: number,
  colorOld?: { r: number; g: number; b: number },
  colorNew?: { r: number; g: number; b: number },
): string => {
  const old = colorOld ?? POSITION_HISTORY_COLOR_OLD;
  const newC = colorNew ?? POSITION_HISTORY_COLOR_NEW;
  if (total <= 1) return interpolateColor(old, newC, 1);
  const ratio = index / (total - 1);
  return interpolateColor(old, newC, ratio);
};
```

**Step 2: Run existing tests to confirm no regressions**

Run: `npx vitest run src/utils/mapHelpers.test.tsx`
Expected: All existing tests PASS (they don't pass custom colors, so defaults kick in)

**Step 3: Commit**

```bash
git add src/utils/mapHelpers.tsx
git commit -m "feat: make position history colors configurable with backward-compatible defaults (#2020)"
```

---

### Task 4: Update `mapIcons.ts` — scheme-aware hop colors

**Files:**
- Modify: `src/utils/mapIcons.ts:15-35`
- Modify: `src/utils/mapIcons.test.ts`

**Step 1: Refactor `getHopColor` to accept optional color config**

In `src/utils/mapIcons.ts`, change `getHopColor` (lines 15-35) from:

```typescript
export function getHopColor(hops: number): string {
  if (hops === 0) {
    return '#22c55e';
  } else if (hops === 999) {
    return '#9ca3af';
  ...
```

To:

```typescript
export function getHopColor(
  hops: number,
  hopColors?: { local: string; noData: string; max: string; gradient: string[] },
): string {
  const colors = hopColors ?? {
    local: '#22c55e',
    noData: '#9ca3af',
    max: '#FF0000',
    gradient: ['#0000FF', '#3300CC', '#660099', '#990066', '#CC0033', '#FF0000'],
  };

  if (hops === 0) {
    return colors.local;
  } else if (hops === 999) {
    return colors.noData;
  } else if (hops >= 6) {
    return colors.max;
  } else {
    return colors.gradient[hops - 1] || colors.gradient[colors.gradient.length - 1];
  }
}
```

**Step 2: Run existing tests**

Run: `npx vitest run src/utils/mapIcons.test.ts`
Expected: All existing tests PASS (they don't pass hopColors, so defaults kick in)

**Step 3: Commit**

```bash
git add src/utils/mapIcons.ts
git commit -m "feat: make hop colors configurable with backward-compatible defaults (#2020)"
```

---

### Task 5: Add `overlayScheme` field to `CustomTileset` interface

**Files:**
- Modify: `src/config/tilesets.ts:10-20` (CustomTileset interface)
- Modify: `src/components/CustomTilesetManager.tsx:7-21` (FormData interface, DEFAULT_FORM_DATA)

**Step 1: Add field to CustomTileset**

In `src/config/tilesets.ts`, add to the `CustomTileset` interface (line 19, after `isVector?`):

```typescript
overlayScheme?: 'light' | 'dark';
```

**Step 2: Add to CustomTilesetManager form**

In `src/components/CustomTilesetManager.tsx`:

Add to `FormData` interface (line 12, after `description`):

```typescript
overlayScheme: 'light' | 'dark';
```

Add to `DEFAULT_FORM_DATA` (line 20, after `description: ''`):

```typescript
overlayScheme: 'dark',
```

Then add a select field in the form JSX (find the form fields area near the maxZoom input). Add after the maxZoom field:

```tsx
<div className="form-group">
  <label>{t('settings.custom_tileset_overlay_scheme')}</label>
  <select
    value={formData.overlayScheme}
    onChange={(e) => setFormData(prev => ({ ...prev, overlayScheme: e.target.value as 'light' | 'dark' }))}
  >
    <option value="dark">{t('settings.overlay_scheme_dark')}</option>
    <option value="light">{t('settings.overlay_scheme_light')}</option>
  </select>
</div>
```

Make sure the `handleSave` function includes `overlayScheme` in the data passed to `addCustomTileset` / `updateCustomTileset`.

**Step 3: Run TypeScript check**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

**Step 4: Commit**

```bash
git add src/config/tilesets.ts src/components/CustomTilesetManager.tsx
git commit -m "feat: add overlayScheme field to custom tileset config (#2020)"
```

---

### Task 6: Wire overlay colors into `useTraceroutePaths`

**Files:**
- Modify: `src/hooks/useTraceroutePaths.tsx:57-62` (ThemeColors interface)
- Modify: `src/hooks/useTraceroutePaths.tsx:85` (UseTraceroutePathsParams)
- Modify: `src/hooks/useTraceroutePaths.tsx` (color usage at lines ~429, ~729, ~770, ~831, ~872)
- Modify: `src/App.tsx:366-386` (themeColors state and useEffect)

**Step 1: Add overlay color fields to ThemeColors interface**

In `src/hooks/useTraceroutePaths.tsx`, change `ThemeColors` (lines 57-62) to:

```typescript
export interface ThemeColors {
  mauve: string;
  red: string;
  blue: string;
  overlay0: string;
  // Overlay scheme colors (override theme CSS colors when set)
  tracerouteForward?: string;
  tracerouteReturn?: string;
  mqttSegment?: string;
  neighborLine?: string;
}
```

**Step 2: Update color references in the hook**

Replace all color references in the hook to prefer overlay colors over theme colors:

- Line ~429: Change `themeColors.overlay0` to `themeColors.mqttSegment ?? themeColors.overlay0` and `themeColors.mauve` to `themeColors.neighborLine ?? themeColors.mauve`
- Line ~729: Change `themeColors.blue` to `themeColors.tracerouteForward ?? themeColors.blue`
- Line ~770: Same
- Line ~831: Change `themeColors.red` to `themeColors.tracerouteReturn ?? themeColors.red`
- Line ~872: Same
- Line ~624 useMemo deps: Add the overlay fields
- Line ~885 useMemo deps: Add the overlay fields

**Step 3: Update App.tsx to populate overlay colors from context**

In `src/App.tsx`, after the existing `themeColors` state (line 368-386), add:

```typescript
import { useSettings } from './contexts/SettingsContext';
```

Then where `themeColors` is used (already in the render area), update to merge overlay colors:

After the `useEffect` that computes themeColors from CSS (line 376-386), add another effect:

```typescript
const { overlayColors: schemeColors } = useSettings();

const mergedThemeColors = React.useMemo(() => ({
  ...themeColors,
  tracerouteForward: schemeColors.tracerouteForward,
  tracerouteReturn: schemeColors.tracerouteReturn,
  mqttSegment: schemeColors.mqttSegment,
  neighborLine: schemeColors.neighborLine,
}), [themeColors, schemeColors]);
```

Then pass `mergedThemeColors` instead of `themeColors` to `useTraceroutePaths` (line ~4089).

**Step 4: Run TypeScript check**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

**Step 5: Commit**

```bash
git add src/hooks/useTraceroutePaths.tsx src/App.tsx
git commit -m "feat: wire overlay scheme colors into traceroute rendering (#2020)"
```

---

### Task 7: Wire overlay colors into NodesTab (neighbor lines + position history)

**Files:**
- Modify: `src/components/NodesTab.tsx:2021` (neighbor line color)
- Modify: `src/components/NodesTab.tsx:2067` (position history color)

**Step 1: Import and use overlay colors**

In `src/components/NodesTab.tsx`, add at top:

```typescript
import { useSettings } from '../contexts/SettingsContext';
```

Inside the component (near other context hooks around line 270), add:

```typescript
const { overlayColors } = useSettings();
```

**Step 2: Update neighbor line color**

Change line 2021 from:
```tsx
color="#cba6f7"
```
To:
```tsx
color={overlayColors.neighborLine}
```

**Step 3: Update position history color**

Change line 2067 from:
```typescript
const color = getPositionHistoryColor(i, segmentCount);
```
To:
```typescript
const color = getPositionHistoryColor(i, segmentCount, overlayColors.positionHistoryOld, overlayColors.positionHistoryNew);
```

**Step 4: Run TypeScript check**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

**Step 5: Commit**

```bash
git add src/components/NodesTab.tsx
git commit -m "feat: use overlay scheme colors for neighbor lines and position history (#2020)"
```

---

### Task 8: Wire overlay colors into mapIcons (hop markers)

**Files:**
- Modify: `src/components/NodesTab.tsx` (where `getHopColor` is called)
- Modify: `src/components/MapLegend.tsx` (where `getHopColor` is called)

**Step 1: Find all getHopColor call sites and pass overlay colors**

Search for all `getHopColor(` calls in `NodesTab.tsx` and `MapLegend.tsx`. Update each call to pass `overlayColors.hopColors`:

```typescript
// Before:
getHopColor(hops)
// After:
getHopColor(hops, overlayColors.hopColors)
```

In `MapLegend.tsx`, import `useSettings` and get `overlayColors`.

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

**Step 3: Commit**

```bash
git add src/components/NodesTab.tsx src/components/MapLegend.tsx
git commit -m "feat: use overlay scheme colors for hop count markers (#2020)"
```

---

### Task 9: Add i18n translation keys

**Files:**
- Modify: `public/locales/en.json`

**Step 1: Add translation keys**

In `public/locales/en.json`, find the `settings.` section and add:

```json
"settings.custom_tileset_overlay_scheme": "Map Overlay Colors",
"settings.overlay_scheme_dark": "Dark Mode (bright overlays)",
"settings.overlay_scheme_light": "Light Mode (saturated overlays)",
```

**Step 2: Commit**

```bash
git add public/locales/en.json
git commit -m "feat: add i18n keys for overlay scheme selection (#2020)"
```

---

### Task 10: Run full test suite and verify

**Step 1: Run full vitest suite**

Run: `npx vitest run`
Expected: All tests pass, no regressions

**Step 2: Run TypeScript compilation**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

**Step 3: Clean up any TODO comments from Task 2**

If Task 2 used `(customTileset as any)?.overlayScheme`, update it now that `overlayScheme` is on the interface (from Task 5).

**Step 4: Commit any cleanup**

```bash
git add -u
git commit -m "chore: clean up type assertions after overlayScheme field added (#2020)"
```
