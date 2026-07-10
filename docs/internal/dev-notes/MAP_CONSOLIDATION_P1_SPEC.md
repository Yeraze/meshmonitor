# Map Consolidation — Phase 1 Implementation Spec (`BaseMap` shell)

**Epic:** #4047 (see `MAP_CONSOLIDATION_EPIC.md`)
**Branch:** `feature/4047-p1-basemap-shell`
**Deliverable of this phase:** `src/components/map/BaseMap.tsx` (shared map shell) + migrate the four simple maps onto it.
**Author:** Phase 1 Architect. Implementers are Sonnet agents — follow the work packages in §5 exactly.

> **Prime directive for Phase 1: pure refactor.** BaseMap is created, four maps adopt it, and **none of the four maps changes visibly** (same tiles, same markers, same draw tools, same click behavior). Any change a reviewer can see on screen is a bug in this phase. Convergence of appearance happens in later phases.

---

## 0. TL;DR for implementers

- Create `src/components/map/BaseMap.tsx` — a thin wrapper around react-leaflet `MapContainer` that owns exactly three things: (1) the tile layer (raster `TileLayer` **or** MapLibre `VectorTileLayer`, chosen via `tilesets.ts`), (2) an optional `TilesetSelector` overlay, (3) an optional resize-invalidate handler. Everything else (markers, draw handlers, overlays, controllers) is passed as `children`.
- Extract the duplicated Leaflet default-icon fix into `src/components/map/leafletDefaultIcon.ts` (side-effect module). BaseMap imports it. `App.tsx` and `EmbedSettings.tsx` drop their copies.
- Migrate the 4 maps by replacing their `<MapContainer><TileLayer/>…children</MapContainer>` block with `<BaseMap …>…children</BaseMap>`. Keep every caller's outer wrapper `<div>` (height/border) exactly as-is.
- The 4 maps stay on **hardcoded OSM raster**. Do **not** wire them to the user's selected tileset — that would be a visible change and is out of scope for Phase 1.

---

## 1. Reuse inventory (use these; do NOT duplicate)

Verified against the code in this worktree. Line numbers are current-tree references.

### 1.1 Tileset config — `src/config/tilesets.ts`
- `DEFAULT_TILESET_ID: PredefinedTilesetId = 'osm'` (`:86`). **Unconditional** — there is *no* theme→tileset mapping anywhere in the codebase (confirmed: no `ThemeContext`; theme lives in `SettingsContext`). See §2.6.
- `getTilesetById(id, customTilesets = []) : TilesetConfig` (`:100`) — resolves predefined → custom → falls back to `osm`. Computes `.isVector` for customs.
- `isVectorTileUrl(url) : boolean` (`:138`) — url contains `.pbf`/`.mvt`.
- `validateTileUrl(url)` (`:147`) — not needed by BaseMap (used by custom-tileset admin UI); listed for completeness.
- `TilesetConfig` exposes `{ id, name, url, attribution, maxZoom, description, isCustom?, isVector? }`.
- `CustomTileset`, `TilesetId` (`= PredefinedTilesetId | string`), `getAllTilesets(customTilesets)` also exported.

### 1.2 `src/components/VectorTileLayer.tsx`
- `VectorTileLayer({ url, attribution?, maxZoom = 14, styleJson? })` — a `useMap()` child that mounts a MapLibre GL layer via `L.maplibreGL`. **Must be rendered inside a `MapContainer`.** Imports `maplibre-gl` + `@maplibre/maplibre-gl-leaflet` at module scope (relevant to tests — §4.5). BaseMap renders this component for the vector branch; do not reimplement.

### 1.3 `src/components/TilesetSelector.tsx`
- `TilesetSelector({ selectedTilesetId, onTilesetChange })` — draggable overlay listing tilesets. Reads `useSettings().customTilesets` internally; it does not need `useMap`. **Ground truth: NodesTab renders it OUTSIDE the `MapContainer`** — `</MapContainer>` closes at `NodesTab.tsx:2663` and `<TilesetSelector>` follows at `:2665-2668` as a **sibling**, absolutely positioned against the caller's map wrapper div. BaseMap renders it optionally (`showTilesetSelector`, default off) **as a sibling after `MapContainer`, never inside it** (see §2.2 render sketch and gotcha §6.10).

### 1.4 Resize / center / position helpers (existing)
- `src/components/MapResizeHandler.tsx` — `MapResizeHandler({ trigger })`: on `trigger` change, `setTimeout(300)` → `map.invalidateSize()`. BaseMap mounts this **only when `resizeTrigger` prop is provided**. **None of the 4 maps pass one today**, so BaseMap must not mount it for them (mounting it would be a behavior change — extra invalidateSize).
- `src/components/MapCenterController.tsx` — popup-centering controller hardcoded to zoom 15. **NodesTab/big-map specific; NOT for the 4 simple maps.** Do not pull into BaseMap.
- `src/components/MapPositionHandler.tsx` — writes map center into `MapContext`. **NodesTab-specific** (depends on `useMapContext`). Not for BaseMap.
- `src/components/ZoomHandler.tsx` — `ZoomHandler({ onZoomChange })`. Generic, but only used by big maps today. Not needed by the 4; leave as-is. (EmbedSettings has its own inline `zoomend` handler — keep it as a child, don't swap.)

> These four helpers are inventory context, not things BaseMap wires. BaseMap only *directly* uses `MapResizeHandler` (gated). The rest remain callers' children in later phases.

### 1.5 The reference wiring pattern — `src/components/NodesTab.tsx`
The raster-vs-vector branch BaseMap centralizes already exists here and is the canonical pattern to copy:
- `MapContainer` at `:2232`; tile branch at `:2242-2255`:
  ```tsx
  getTilesetById(activeTileset, customTilesets).isVector
    ? <VectorTileLayer url={..} attribution={..} maxZoom={..} styleJson={activeStyleJson ?? undefined} />
    : <TileLayer attribution={..} url={..} maxZoom={..} />
  ```
  All of `url`/`attribution`/`maxZoom` come from `getTilesetById(activeTileset, customTilesets)`; `.isVector` selects the branch.
- `TilesetSelector` at `:2665-2668`: `selectedTilesetId={activeTileset}` / `onTilesetChange={setMapTileset}`.
- **Do not migrate NodesTab in Phase 1** (deferred to Phase 6). It is listed only so BaseMap's tile-branch matches the pattern NodesTab will later adopt.

### 1.6 Tileset persistence (canonical mechanism — for later phases, NOT the 4 editors)
- Source of truth is `useSettings()` → `mapTileset: TilesetId` + `setMapTileset(id)` (`src/contexts/SettingsContext.tsx:346-354, 592-613`). localStorage key `'mapTileset'` is a context implementation detail — **do not read/write it directly from BaseMap or any picker.**
- BaseMap is **persistence-agnostic**: it takes a controlled `tilesetId` + `onTilesetChange` and does not itself read `useSettings().mapTileset`. Callers wire persistence. (The 4 editors pass nothing → default OSM.)

### 1.7 The duplicated default-icon fix (the one thing Phase 1 de-duplicates)
Two copies mutate the **global** `L.Icon.Default`:
- `src/App.tsx:113-125` — inline **SVG data-URI teardrop pins** (red retina / blue / shadow).
- `src/components/settings/EmbedSettings.tsx:14-24` — real **Leaflet PNG** marker images (`leaflet/dist/images/marker-icon*.png` + shadow).

Because both run `L.Icon.Default.mergeOptions(...)` at module-eval time, whichever module loads last wins **globally**. See §2.5 + §6.1 for the canonical-icon decision and why it is PNG.

---

## 2. BaseMap API design

### 2.1 Props interface (authoritative — type it exactly, no `any`)

```tsx
// src/components/map/BaseMap.tsx
import type { ReactNode, CSSProperties, Ref } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import type { TilesetId, CustomTileset } from '../../config/tilesets';

export interface BaseMapProps {
  /** Initial center. Like react-leaflet, this is applied once at mount and is
   *  NOT reactive — view changes after mount are the caller's job (child
   *  controllers / fitBounds). See §6.2. */
  center: [number, number];
  /** Initial zoom (mount-only, same non-reactivity as `center`). */
  zoom: number;

  // ---- Tile layer selection ----------------------------------------------
  /** Tileset id. Omitted ⇒ DEFAULT_TILESET_ID ('osm', raster). The 4 Phase-1
   *  editors omit it. */
  tilesetId?: TilesetId;
  /** Needed only to resolve `custom-*` ids. Default []. */
  customTilesets?: CustomTileset[];
  /** MapLibre style JSON passthrough for vector tilesets (ignored for raster). */
  styleJson?: Record<string, unknown>;

  // ---- Optional tileset selector overlay ---------------------------------
  /** Render the TilesetSelector overlay. Default false. */
  showTilesetSelector?: boolean;
  /** Required to be useful when showTilesetSelector is true. */
  onTilesetChange?: (id: TilesetId) => void;

  // ---- MapContainer passthroughs (explicit, type-safe) -------------------
  scrollWheelZoom?: boolean;      // default: leaflet default (true) unless caller overrides
  doubleClickZoom?: boolean;
  zoomControl?: boolean;
  attributionControl?: boolean;
  /** Merged into MapContainer style; default { height: '100%', width: '100%' }. */
  mapStyle?: CSSProperties;
  /** className on the MapContainer element. */
  className?: string;

  // ---- Resize handling ----------------------------------------------------
  /** When this value changes, BaseMap calls map.invalidateSize() (via
   *  MapResizeHandler). Omit ⇒ handler NOT mounted (no behavior change). */
  resizeTrigger?: unknown;

  // ---- Map instance access ------------------------------------------------
  /** Forwarded to MapContainer's ref → resolves to the Leaflet map. */
  mapRef?: Ref<LeafletMap>;

  // ---- Composition --------------------------------------------------------
  /** Markers, draw handlers, overlays, useMap-based controllers. Rendered
   *  inside MapContainer, after the tile layer. */
  children?: ReactNode;
}
```

**Match the exact prop defaults to avoid visible drift.** The four editors currently pass to `MapContainer`: `center`, `zoom`, `style={{height:'100%',width:'100%'}}`, and some pass `scrollWheelZoom`. BaseMap must reproduce these 1:1 (see per-map notes in §3).

### 2.2 What the shell owns vs. what is `children`

| Owned by BaseMap | Passed as `children` by caller |
|---|---|
| `MapContainer` element + its mount props | Node/marker layers, `<Marker>`, `L.*` imperative draw layers |
| Raster `TileLayer` **or** `VectorTileLayer` (branch on `getTilesetById(...).isVector`) | Click/move/zoom event handlers (`useMapEvents` children) |
| Optional `TilesetSelector` overlay (sibling **after** `MapContainer` — §6.10) | Fit-bounds / view-setting controllers (`useMap` children) |
| Optional `MapResizeHandler` (gated on `resizeTrigger`) | Everything feature-specific |
| Importing the shared default-icon fix (§1.7) | — |

BaseMap returns a **fragment** (conceptually):
```tsx
<>
  <MapContainer center={center} zoom={zoom} ref={mapRef} className={className}
                style={{ height:'100%', width:'100%', ...mapStyle }}
                scrollWheelZoom={scrollWheelZoom} doubleClickZoom={doubleClickZoom}
                zoomControl={zoomControl} attributionControl={attributionControl}>
    {tileset.isVector
      ? <VectorTileLayer url={tileset.url} attribution={tileset.attribution}
                         maxZoom={tileset.maxZoom} styleJson={styleJson} />
      : <TileLayer url={tileset.url} attribution={tileset.attribution} maxZoom={tileset.maxZoom} />}
    {resizeTrigger !== undefined && <MapResizeHandler trigger={resizeTrigger} />}
    {children}
  </MapContainer>
  {showTilesetSelector && <TilesetSelector selectedTilesetId={resolvedId}
                                           onTilesetChange={onTilesetChange ?? (() => {})} />}
</>
```
`TilesetSelector` is a **sibling rendered after `MapContainer`, not a child inside it** — this matches NodesTab today (`</MapContainer>` at `:2663`, selector at `:2665`). Its absolute positioning resolves against the caller's positioned map wrapper div, exactly as it does now. Rendering it inside the Leaflet container would change its positioning ancestor and put its drag/click events inside Leaflet's event surface — a behavior change. For the same reason, **BaseMap must NOT introduce its own wrapper `<div>`** around the fragment: callers size the map via their existing wrapper (`height: 100%` on the MapContainer resolves against it), and an extra div would break those height/layout assumptions.

where
```tsx
const resolvedId = tilesetId ?? DEFAULT_TILESET_ID;
const tileset = getTilesetById(resolvedId, customTilesets ?? []);
```
`getTilesetById` already falls back to `osm` for unknown ids, so BaseMap never renders a broken tile layer.

> Only pass MapContainer props you were given — don't spread arbitrary `...rest`. Explicit props keep the type surface clean and prevent no-`any` violations.

### 2.3 Tileset-selection state (controlled, not persisted by BaseMap)
- **Controlled.** `tilesetId` in, `onTilesetChange` out. BaseMap keeps no internal tileset state and does **not** call `useSettings()`. Persistence is the caller's concern (§1.6). This keeps BaseMap testable and lets the 4 editors stay on OSM by simply omitting `tilesetId`.

### 2.4 How the four editors' interactions attach (confirmed compatible)
All four editors implement their map behavior as **child components that call `useMap()` / `useMapEvents()`** inside the `MapContainer`. Those children are unchanged and become BaseMap `children`, so they still resolve the react-leaflet context BaseMap provides:
- `DefaultMapCenterPicker` — `MapPositionTracker` (`useMapEvents`) + `MapInitializer` (`useMap`).
- `EmbedSettings` picker — `MapClickHandler` (`useMapEvents`) + `MapCenterUpdater` (`useMap`) + a bare `<Marker>`.
- `BBoxMapEditor` — `<Layer>` (`useMap` + `useMapEvents`, imperative `L.rectangle`/`L.marker`).
- `GeofenceMapEditor` — `<MapDrawingLayer>` (`useMap` + `useMapEvents`, imperative `L.circle`/`L.polygon`/`L.marker`, and it imperatively toggles `map.doubleClickZoom` — that stays in the child and is unaffected).

No editor reads the map instance at the `MapContainer` level, so `mapRef` is not required by any of them (it exists for future big-map adopters).

### 2.5 Where the default-icon fix moves
- New side-effect module `src/components/map/leafletDefaultIcon.ts`:
  ```ts
  import L from 'leaflet';
  import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
  import iconUrl from 'leaflet/dist/images/marker-icon.png';
  import shadowUrl from 'leaflet/dist/images/marker-shadow.png';

  // Applied once at import; idempotent (re-running mergeOptions is harmless).
  delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
  L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl });
  ```
  Uses the **Leaflet PNG** images — the canonical default (see §6.1 for why PNG, not the App.tsx SVG). Note: avoid `as any` — use the narrowed cast shown to satisfy the no-`any` ratchet.
- `BaseMap.tsx` imports it for side effect: `import './leafletDefaultIcon';`.
- `App.tsx` (`:113-125`): **delete** the inline block. Add a top-level side-effect import `import './components/map/leafletDefaultIcon';` so the app-wide default is applied at root even before any BaseMap mounts.
- `EmbedSettings.tsx` (`:14-24`): **delete** the inline block and the three `markerIcon*` PNG imports (they move into the shared module). EmbedSettings no longer needs them directly.

### 2.6 Theme-aware defaults — explicit Phase-1 decision
The epic lists "theme-aware defaults." **Ground truth: no theme→tileset mapping exists today** and the 4 editors are hardcoded OSM. Making BaseMap read `useSettings().theme` and swap the default to `cartoDark` would **visibly change all four editors** — a Phase-1 violation. Therefore:
- **Phase 1:** BaseMap's default tileset is `DEFAULT_TILESET_ID` ('osm'), theme-independent. "Theme-aware default" is satisfied by *callers* choosing `tilesetId` (as NodesTab already resolves its own). No theme read inside BaseMap.
- **Future hook (documented, not built now):** a later phase may add an opt-in `themeAwareDefault?: boolean` that, when true and `tilesetId` is omitted, picks `cartoDark`/`cartoLight` from `useSettings().theme`. Left unimplemented so it can't regress the editors. Note this in the phase log when big maps adopt.

### 2.7 SSR / test considerations
- BaseMap is client-only (leaflet touches `window`); the app has no SSR. No guard needed beyond what react-leaflet already requires.
- Under Vitest, there is **no global react-leaflet mock** (`src/test/setup.ts` mocks only i18n/emoji/localStorage/matchMedia). Real leaflet does not render usefully in jsdom, so **BaseMap unit tests mock `react-leaflet` + the tile components** (§4). Migrated-map tests mock **BaseMap itself** as a passthrough (§4.2) so they never pull in maplibre.

---

## 3. File-by-file changes

### Created
1. **`src/components/map/BaseMap.tsx`** — the shell, per §2.
2. **`src/components/map/leafletDefaultIcon.ts`** — shared default-icon side-effect module, per §2.5.
3. **`src/components/map/BaseMap.test.tsx`** — unit tests, per §4.1.

### Modified
4. **`src/App.tsx`** — delete inline icon block (`:113-125`); add `import './components/map/leafletDefaultIcon';` near the other top-level imports. Leave the existing `import L from 'leaflet'` / `import 'leaflet/dist/leaflet.css'` (still used elsewhere in the file).
5. **`src/components/settings/EmbedSettings.tsx`** — delete inline icon block + the 3 `markerIcon*` PNG imports (`:14-24`); replace the picker's `<MapContainer><TileLayer/>…</MapContainer>` (`:493-509`) with `<BaseMap center={[form.defaultLat, form.defaultLng]} zoom={form.defaultZoom} scrollWheelZoom>` wrapping the existing `MapClickHandler`, `MapCenterUpdater`, and `<Marker>` children. Keep the `.embed-map-picker` wrapper div and hardcoded OSM (omit `tilesetId`). Keep `import 'leaflet/dist/leaflet.css'` and `import L from 'leaflet'` only if still referenced after removing the icon block — **remove `L` import if it becomes unused** (it likely does; verify to avoid an unused-import lint error).
6. **`src/components/configuration/DefaultMapCenterPicker.tsx`** — replace `<MapContainer><TileLayer/>…</MapContainer>` (`:79-93`) with `<BaseMap center={initialCenter} zoom={initialZoom} scrollWheelZoom>` wrapping the existing `MapPositionTracker` + conditional `MapInitializer`. Keep the outer `<div style={{height:'300px'}}>`. `MapContainer`/`TileLayer` imports from react-leaflet are removed; keep `useMap`/`useMapEvents` imports (children use them).
7. **`src/components/configuration/DefaultMapCenterPicker.test.tsx`** — update mock surface, per §4.2.
8. **`src/components/BBoxMapEditor.tsx`** — replace `<MapContainer><TileLayer/><Layer/></MapContainer>` (`:298-316`) with `<BaseMap center={initialCenter} zoom={bbox ? 5 : 2}>` wrapping the existing `<Layer>`. Keep the wrapper div + border. Drop `MapContainer`/`TileLayer` from the react-leaflet import; keep `useMap`/`useMapEvents` (used by `Layer`).
9. **`src/components/GeofenceMapEditor.tsx`** — replace `<MapContainer><TileLayer/><MapDrawingLayer/></MapContainer>` (`:408-423`) with `<BaseMap center={[30, 0]} zoom={3}>` wrapping the existing `<MapDrawingLayer>`. Keep wrapper div + border. Drop `MapContainer`/`TileLayer` from the react-leaflet import; keep `useMap`/`useMapEvents`.

> **Do not** change any editor's outer wrapper `<div>`, its height, borders, hints, buttons, numeric inputs, or its child components' logic. Only the `<MapContainer>…</MapContainer>` element is replaced by `<BaseMap>…</BaseMap>`.

---

## 4. Test plan

All tests live in the standard Vitest suite (`*.test.tsx`, `// @vitest-environment jsdom`). No standalone scripts.

### 4.1 New: `src/components/map/BaseMap.test.tsx`
Mock strategy (mirrors `Dashboard/DashboardMap.test.tsx`):
- `vi.mock('react-leaflet', …)`: `MapContainer` → `({children, ...props}) => <div data-testid="map-container" data-scrollwheel={String(props.scrollWheelZoom)}>{children}</div>`; `TileLayer` → `(props) => <div data-testid="raster-tile" data-url={props.url} data-maxzoom={String(props.maxZoom)} />`; `useMap`/`useMapEvents` → stubs.
- `vi.mock('../VectorTileLayer', () => ({ VectorTileLayer: (p) => <div data-testid="vector-tile" data-url={p.url} /> }))`.
- `vi.mock('../TilesetSelector', () => ({ TilesetSelector: (p) => <div data-testid="tileset-selector" data-selected={p.selectedTilesetId} /> }))`.
- `vi.mock('../MapResizeHandler', () => ({ default: () => <div data-testid="resize-handler" /> }))`.
- `vi.mock('leaflet/dist/leaflet.css', () => ({}))` and for the icon module either let it run or `vi.mock('./leafletDefaultIcon', () => ({}))`.

Assertions:
1. **Raster branch:** default props (no `tilesetId`) → `getByTestId('raster-tile')` present with `data-url` = the osm url; `queryByTestId('vector-tile')` is null.
2. **Vector branch:** mock `../../config/tilesets` `getTilesetById` to return `{ …, url:'https://x/{z}/{x}/{y}.pbf', isVector:true }` (mirrors DashboardMap.test) → `getByTestId('vector-tile')` present with that url; `queryByTestId('raster-tile')` null. (This is the exit-criterion "a map given a MapLibre style URL renders VectorTileLayer" at unit level; real maplibre rendering is browser-validated, not jsdom — §4.5.)
3. **Unknown-id fallback:** `tilesetId="does-not-exist"` (no matching custom) → falls back to raster osm (via `getTilesetById` fallback). Assert raster tile with osm url.
4. **Selector gating (sibling, not child):** `showTilesetSelector` absent → no `tileset-selector`; `showTilesetSelector` + `tilesetId="osm"` → `tileset-selector` present with `data-selected="osm"`. Assert **presence in the render tree** (`getByTestId`), and additionally assert it is **NOT a descendant of `map-container`** (`expect(getByTestId('map-container')).not.toContainElement(getByTestId('tileset-selector'))`) — it must render as a sibling after `MapContainer` per §2.2/§6.10.
5. **Resize gating:** no `resizeTrigger` → no `resize-handler`; with `resizeTrigger={1}` → `resize-handler` present.
6. **Children passthrough:** a child `<div data-testid="child" />` renders inside the container.
7. **Prop passthrough:** `scrollWheelZoom` reaches MapContainer (`data-scrollwheel`).
8. **Icon fix applied (unmocked icon module):** in a separate test that imports `./leafletDefaultIcon` and real `leaflet`, assert `(L.Icon.Default.prototype as any)._getIconUrl === undefined` and that `L.Icon.Default.mergeOptions` result includes a PNG `iconUrl`; assert importing the module twice does not throw (idempotent). (Use a local `as any` **only in test files** — allowed by the raw-SQL/`any` ratchet's test-file exemption; production code uses the narrowed cast from §2.5.)

### 4.2 Update: `src/components/configuration/DefaultMapCenterPicker.test.tsx`
The picker now renders `<BaseMap>` instead of `<MapContainer>`. To keep the test isolated from BaseMap internals (and maplibre), **add a BaseMap passthrough mock** and keep the existing react-leaflet mock (the picker's own children still use `useMap`/`useMapEvents`):
```tsx
vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children?: React.ReactNode }) =>
    <div data-testid="minimap">{children}</div>,
}));
```
Keep the existing `vi.mock('react-leaflet', …)` (still needed for `useMap`/`useMapEvents`/`TileLayer`) and `vi.mock('leaflet/dist/leaflet.css')`. All existing text assertions ("No default center configured", "Default: 40.7128, -74.0060 (zoom 12)", "Clear", "Save as Default", `onSave` called with 3 numbers) must still pass unchanged — they assert on the picker's own JSX, which is untouched.

### 4.3 Unchanged: `src/components/GeofenceTriggersSection.test.tsx`
Fully stubs `./GeofenceMapEditor` as a div and never touches react-leaflet. **Preserve GeofenceMapEditor's `default` export and its `onShapeChange`/`shapeType`/`shape`/`nodePositions` prop contract** (they are unchanged by this refactor) and this test needs no edits. Do not alter it.

### 4.4 No existing tests: BBoxMapEditor, EmbedSettings
Neither has tests today (verified: 0 hits). Exit criteria do not require new per-map tests — browser validation covers rendering. **Optional (nice-to-have, WP3):** a light `BBoxMapEditor.test.tsx` that mocks `../map/BaseMap` as passthrough + mocks `react-leaflet` `useMap`/`useMapEvents` and asserts the hint text transitions (no bbox → "Click two corners…"). Keep it minimal; skip if it risks flakiness with the imperative `L.*` calls (those need `useMap` returning a functional stub).

### 4.5 Vector under jsdom — do not attempt real maplibre
`VectorTileLayer` needs WebGL/canvas (`L.maplibreGL`) which jsdom lacks. Every vector-capable map test in the repo stubs it. BaseMap tests therefore assert **branch selection only** (§4.1 #2) by mocking `VectorTileLayer` + `getTilesetById`. Real vector rendering is a browser-validation item for the phase, not a unit test.

### 4.6 Suite gate
Run the **full** Vitest suite + `tsc` (typecheck) — both must be green. Run `npm run lint:ci` (baseline ratchet) — must exit 0; do not grow any rule count (watch for stray `any`, unused imports after removing `MapContainer`/`TileLayer`/`L`).

---

## 5. Work packages (Sonnet-sized, disjoint files)

Dependency order: **WP1 → then WP2 ‖ WP3 in parallel** (WP2 and WP3 touch disjoint files).

### WP1 — BaseMap + icon module + BaseMap tests  *(no dependencies; start immediately)*
**Files (all new; no overlap with WP2/WP3):**
- `src/components/map/BaseMap.tsx`
- `src/components/map/leafletDefaultIcon.ts`
- `src/components/map/BaseMap.test.tsx`

**Do:** implement §2 API exactly; icon module per §2.5; tests per §4.1.
**Acceptance:**
- BaseMap renders raster `TileLayer` by default and `VectorTileLayer` when the resolved tileset `.isVector` (assert via mocks).
- Unknown tileset id falls back to osm raster.
- `showTilesetSelector` and `resizeTrigger` gate their components correctly.
- Children render inside the container; `mapRef`/`scrollWheelZoom` forwarded.
- Icon module applies the PNG default once, idempotently; no `any` in production code.
- `tsc` + BaseMap.test green; `lint:ci` clean.

### WP2 — Picker migrations + icon-fix consolidation
**Files (disjoint from WP3):**
- `src/components/configuration/DefaultMapCenterPicker.tsx`
- `src/components/configuration/DefaultMapCenterPicker.test.tsx`
- `src/components/settings/EmbedSettings.tsx`
- `src/App.tsx`  *(icon block removal only — the single, isolated edit)*

**Do:** §3 items 4, 5, 6, 7. Migrate both pickers to `<BaseMap>` keeping OSM + wrappers; delete App.tsx and EmbedSettings inline icon blocks; add App.tsx side-effect import; update the picker test mock.
**Acceptance:**
- DefaultMapCenterPicker and EmbedSettings picker render identically (OSM tiles, same wrapper size/border, EmbedSettings center `<Marker>` shows the same PNG marker as before).
- App.tsx has no inline icon block and imports the shared module; grep confirms no default-marker regression (§6.1).
- No unused imports left (`MapContainer`/`TileLayer`; `L`/PNG imports in EmbedSettings).
- DefaultMapCenterPicker.test green with the new BaseMap mock; full suite + `tsc` + `lint:ci` green.
- **Browser-validate:** open the Default Map Center picker (Configuration) and the Embed profile editor map — pan/zoom/click still set values; markers/tiles look unchanged.

### WP3 — Editor migrations (BBox + Geofence)
**Files (disjoint from WP2):**
- `src/components/BBoxMapEditor.tsx`
- `src/components/GeofenceMapEditor.tsx`
- *(optional)* `src/components/BBoxMapEditor.test.tsx` — light smoke, per §4.4

**Do:** §3 items 8, 9. Swap the `MapContainer` block for `<BaseMap>`; keep the imperative draw `children`, wrappers, borders, and all draw/drag/click logic untouched.
**Acceptance:**
- BBox two-corner draw + corner-drag resize works exactly as before; OSM tiles; `--ctp-*` colors intact.
- Geofence circle (click + center/radius drag) and polygon (click-to-add, dbl-click finalize, vertex drag) all work; node-position dots + tooltips render; `map.doubleClickZoom` toggle still fires (it's inside the child).
- `GeofenceTriggersSection.test.tsx` still green untouched (GeofenceMapEditor contract preserved).
- Full suite + `tsc` + `lint:ci` green.
- **Browser-validate:** the mqtt-bridge bbox editor and the auto-responder geofence editor.

---

## 6. Risks & gotchas

### 6.1 Global icon mutation — pick PNG as canonical, verify no regression *(highest-risk item)*
`L.Icon.Default` is a global; whichever icon-fix module loaded last currently wins app-wide. **Only one thing renders a bare default `<Marker>`: `EmbedSettings.tsx:508`** (verified — every other `<Marker>`/`L.marker` in the codebase passes an explicit `icon`). EmbedSettings' own module sets the **PNG** default before it renders, so its marker is PNG today. The App.tsx **SVG teardrop** default has **no rendered consumer**. Therefore:
- **Canonical = Leaflet PNG** (matches the only visible consumer). The shared module uses the PNG images; the App.tsx SVG pins are dropped with no visible effect.
- **Verification step (WP2):** `grep -rn "<Marker" src --include=*.tsx | grep -v icon=` and `grep -rn "L.marker(" src` — confirm EmbedSettings' bare `<Marker>` remains the only default-icon consumer, so dropping the SVG changes nothing. If a new bare marker is found, it must be given an explicit icon or accept the PNG.

### 6.2 react-leaflet v5 `center`/`zoom` are mount-only (not reactive)
Changing `center`/`zoom` props after mount does nothing in react-leaflet — every editor already relies on child controllers (`MapInitializer`, `MapCenterUpdater`, `map.fitBounds`) for post-mount view changes. BaseMap must **not** try to make them reactive (e.g. no `map.setView` effect on prop change) — that would alter behavior. Pass them straight through.

### 6.3 Children require the react-leaflet context — preserved
All editor draw layers call `useMap()`/`useMapEvents()`. They must remain **descendants of the `MapContainer`** BaseMap renders. Since they're passed as `children` and BaseMap renders `{children}` inside `MapContainer`, the context is intact. Do not hoist any child above BaseMap.

### 6.4 EmbedSettings imports marker PNGs + `L` directly
After removing the inline icon block, the three `markerIcon*` imports and possibly the `import L from 'leaflet'` become unused → **unused-import lint errors**. Remove them. Keep `import 'leaflet/dist/leaflet.css'` (harmless; BaseMap also imports it — duplicate CSS import is a no-op).

### 6.5 Do NOT wire the editors to the user's tileset
Tempting to pass `tilesetId={mapTileset}` "for consistency." That would flip the four editors from OSM to whatever the user picked (e.g. satellite/dark) — a visible change and a Phase-1 violation. Editors stay on hardcoded OSM (omit `tilesetId`). Cross-editor tileset adoption, if ever wanted, is a separate future decision.

### 6.6 EmbedSettings has two unrelated "tileset" concerns
`EmbedSettings` has a per-profile `tileset` **dropdown** (config data for the published embed output, `getAllTilesets(...)`). That is **not** the preview map's tiles and must stay untouched. Only the preview `<MapContainer>` (`:493-509`) migrates, and it keeps OSM.

### 6.7 `MapResizeHandler` default import
`MapResizeHandler` is a **default** export. BaseMap imports it `import MapResizeHandler from '../MapResizeHandler'`. Mount only when `resizeTrigger !== undefined` so the 4 editors (which pass none) get zero behavioral change.

### 6.8 No new `any`; test-file `any` is fine
Production code (BaseMap, icon module) must be `any`-free — use the narrowed cast in §2.5 for the `_getIconUrl` delete. Test files may use `any` (baseline exempts tests). `VectorTileLayer`'s internal `any` is pre-existing/baselined — don't touch it.

### 6.9 No backend/API/DB surface
Phase 1 is frontend-only. No routes, migrations, repositories, or `sourceId` plumbing. The "frontend never talks to nodes" rule is trivially satisfied (no data fetching added). Raw-`fetch` ban is irrelevant (no fetch introduced).

### 6.10 `TilesetSelector` must be a SIBLING of `MapContainer`, and BaseMap must not add a wrapper div
NodesTab (the only current consumer) renders `TilesetSelector` **outside** the `MapContainer` (`</MapContainer>` at `NodesTab.tsx:2663`, selector at `:2665`) — its absolute positioning resolves against the caller's positioned map wrapper div, and its drag/click events live outside Leaflet's event surface. Two failure modes to avoid:
- **Rendering it inside `MapContainer`** changes its positioning ancestor to the Leaflet container and routes its pointer events through Leaflet's handlers (map pans/zooms while dragging the selector) — a behavior change.
- **Wrapping the fragment in a BaseMap-owned `<div>`** breaks callers' layout: every migrated map sizes the `MapContainer` via `height: 100%` against the caller's own wrapper (300px/400px divs with borders), and an interposed div both collapses that height chain and becomes an unintended positioning ancestor for the selector.
BaseMap therefore returns a fragment: `<MapContainer>…</MapContainer>` followed by the optional `<TilesetSelector>` sibling (§2.2). §4.1 assertion #4 pins this structurally.

---

## 7. Exit-criteria checklist (map to epic)

- [ ] `src/components/map/BaseMap.tsx` exists with tests (WP1).
- [ ] 4 simple maps migrated (WP2 + WP3), rendering **identically** (tiles, markers, draw tools, click handling) — browser-validated.
- [ ] Default-icon fix lives in one shared module; App.tsx + EmbedSettings copies removed; no marker regression.
- [ ] Vector-tile support works through the shell: a vector (`.pbf`) tileset renders `VectorTileLayer` (unit-asserted via branch; real render browser-checked).
- [ ] `tsc` typecheck green.
- [ ] Full Vitest suite green (0 failures).
- [ ] `npm run lint:ci` exits 0 (no baseline growth).
