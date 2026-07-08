# Phase 2 Implementation Spec — Follow & Auto-zoom (issue #3788)

**Branch/worktree:** `feature/3788-follow-autozoom` @ `/home/yeraze/Development/meshmonitor-3788-p2`
**Scope:** Frontend only. No backend, schema, migration, or API change. No new `any`. No raw `fetch()` in components/pages.
**Goal:** Add **Follow** and **Auto-zoom** toggles to the `/analysis` toolbar. On each live position update (the 15s `useDashboardUnifiedData` poll), operate on the **selected nodes' current positions** (Phase 1's `config.selectedNodeIds`):
- **Follow** → `map.setView(averageCenter, currentZoom)` (recenter, keep zoom).
- **Auto-zoom** → `map.fitBounds(paddedBounds, …)` (fit + 15% margin).
- **Both on** → Auto-zoom governs; Follow is a no-op.
- **Manual pan/zoom while active → PAUSE** + a "Resume follow" affordance; no yank-back until resumed.
- Toggles persist in `MapAnalysisConfig`. Pause is transient (not persisted).

Builds directly on merged **Phase 1** (`useAnalysisNodes`, `unifiedNodeKey`, `selectedNodeIds`). Reuse over duplication is a hard requirement.

---

## 1. Reuse inventory (verified in worktree)

| Symbol | File:line | How Phase 2 uses it |
|---|---|---|
| `useAnalysisNodes()` → `AnalysisNode[]` (`{ node, latLng, key }`) | `src/components/MapAnalysis/useAnalysisNodes.ts:54-93` | **Reuse as-is.** The source of "selected nodes' current positions." Controller + toolbar both call it; identical react-query key ⇒ shared cache, no double fetch. Filter by `key ∈ config.selectedNodeIds`. |
| `config.selectedNodeIds: string[]` | `src/hooks/useMapAnalysisConfig.ts:52-53,77` | **Reuse.** The follow/auto-zoom target set (already persisted, load-safe). |
| `MapAnalysisConfig` type / `DEFAULT_CONFIG` / `load()` / setters | `src/hooks/useMapAnalysisConfig.ts:40-107,158-188` | **Extend** with `followMode`/`autoZoom` booleans + `setFollowMode`/`setAutoZoom`, mirroring the `selectedNodeIds`/`setSources` pattern exactly (§2). |
| `useMapAnalysisCtx()` / `MapAnalysisProvider` | `src/components/MapAnalysis/MapAnalysisContext.tsx:29-54` | Ctx is `ReturnType<typeof useMapAnalysisConfig> & {…transient…}`. Config additions propagate automatically. **Add** transient `followPaused`/`setFollowPaused` here (mirrors `selected`/`nodeFilter`), NOT in the persisted config (§3a). |
| `useDashboardUnifiedData(...)` `refetchInterval: DASHBOARD_POLL_INTERVAL = 15_000` | `src/hooks/useDashboardData.ts:68,456` | The 15s cadence that drives updates; consumed transitively via `useAnalysisNodes`. No direct use. |
| **`MapBoundsUpdater`** (`useMap()` child, `hasFittedRef`, `L.latLngBounds(...).fitBounds`) | `src/components/Dashboard/DashboardMap.tsx:128-152` | **Template** for the new `FollowController` (a `useMap()` child returning `null`). |
| `MapCenterController` (`useMap()` + `map.setView`) | `src/components/MapCenterController.tsx:16-51` | **Template** for the Follow `setView` call. |
| `ZoomHandler` / `MapPositionHandler` (`map.on('…') / map.off('…')` in an effect with cleanup) | `src/components/ZoomHandler.tsx:8-26`, `src/components/MapPositionHandler.tsx:8-30` | **Template** for the `moveend` listener + cleanup lifecycle. |
| `MapAnalysisCanvas` `<MapContainer>` + overlay siblings (`MapLegend`, `TilesetSelector`, `TimeSliderControl`) | `src/components/MapAnalysis/MapAnalysisCanvas.tsx:43-79` | **Wire** `<FollowController/>` inside `<MapContainer>`; **wire** `<FollowResumeButton/>` as an overlay sibling (like `MapLegend`). |
| Time-Slider toggle button (`className={\`map-analysis-layer-btn ${…?'active':''}\`}`) | `src/components/MapAnalysis/MapAnalysisToolbar.tsx:133-139` | **Template** for the two new toggle buttons (plain toggles, not `LayerToggleButton`). |
| `.map-analysis-layer-btn(.active)` / `.map-analysis-legend` (overlay positioning) | `src/styles/map-analysis.css:105-129,369-382` | **Reuse** button styling for toggles; **template** for one small new `.map-analysis-follow-resume` overlay rule. |

**Genuinely new files (justified):**
- `src/components/MapAnalysis/followMath.ts` — pure, leaflet-free average-center + padded-bounds math. No such helper exists; extracting it keeps the branching (empty/single/coincident/multi) unit-testable instead of buried in an effect. (Mirrors the prompt's `averageLatLng`/`boundsWithPad` ask.)
- `src/components/MapAnalysis/FollowController.tsx` — the `useMap()` view controller. No existing controller does live-recenter/fit against a selection; the Dashboard ones are one-shot (`hasFittedRef`) or single-target. New behavior, built on their patterns.
- `src/components/MapAnalysis/FollowResumeButton.tsx` — the pause overlay affordance. Small, but a distinct concern from the controller (renders outside `<MapContainer>`); kept separate so the controller stays a pure `null`-rendering `useMap` child.

**Reused, not rebuilt:** live feed (`useAnalysisNodes`/`useDashboardUnifiedData`), identity keying (`unifiedNodeKey`), selection persistence (`selectedNodeIds`), toggle-button chrome, overlay-positioning CSS.

---

## 2. Config changes — `src/hooks/useMapAnalysisConfig.ts` (modify)

Mirror the existing `selectedNodeIds` treatment precisely.

- **`MapAnalysisConfig`** (after `selectedNodeIds`):
  ```ts
  /** Follow: recenter to the selected nodes' average position each update, keep zoom (issue #3788 P2). */
  followMode: boolean;
  /** Auto-zoom: fit the selected nodes' bounds (+15% margin) each update (issue #3788 P2). */
  autoZoom: boolean;
  ```
- **`DEFAULT_CONFIG`** (after `selectedNodeIds: []`): `followMode: false,` and `autoZoom: false,`.
- **`load()`** — add explicit coercion inside the returned object literal (old-config / garbage safety; `{ ...DEFAULT_CONFIG, ...parsed }` already backfills, this hardens against non-boolean):
  ```ts
  followMode: typeof parsed.followMode === 'boolean' ? parsed.followMode : false,
  autoZoom: typeof parsed.autoZoom === 'boolean' ? parsed.autoZoom : false,
  ```
- **Setters** (mirror `setSelectedNodeIds`, :162-164):
  ```ts
  const setFollowMode = useCallback((v: boolean) => {
    setConfig((prev) => ({ ...prev, followMode: v }));
  }, []);
  const setAutoZoom = useCallback((v: boolean) => {
    setConfig((prev) => ({ ...prev, autoZoom: v }));
  }, []);
  ```
- Add `setFollowMode, setAutoZoom` to the returned object (:176-187). `reset()` already restores `DEFAULT_CONFIG` (both → false).

**No migration** — localStorage persistence; old configs load safely.

---

## 3. File-by-file changes

### 3a. `src/components/MapAnalysis/MapAnalysisContext.tsx` (modify) — transient pause state

Pause is **session-transient**, not persisted (reload starts unpaused). Put it beside the existing transient `selected`/`nodeFilter` state so both the controller (inside `<MapContainer>`) and the resume overlay (sibling) read it via `useMapAnalysisCtx()`.

- Extend `CtxShape`:
  ```ts
  /** Follow/Auto-zoom paused by a manual pan/zoom; cleared by Resume or retargeting (issue #3788 P2). */
  followPaused: boolean;
  setFollowPaused: (p: boolean) => void;
  ```
- In `MapAnalysisProvider`: `const [followPaused, setFollowPaused] = useState(false);` and add `followPaused, setFollowPaused` to the provider `value`.

### 3b. `src/components/MapAnalysis/followMath.ts` (new) — pure helpers

Leaflet-free. Replicates Leaflet's `LatLngBounds.pad(ratio)` (each side extended by `ratio × span`) so `fitBounds` can be handed an already-padded 2-corner tuple (Leaflet accepts `[[lat,lng],[lat,lng]]` as a `LatLngBoundsExpression`, so **no `L` import needed** in the controller either).

```ts
export type LatLng = [number, number];

/** Arithmetic mean of the points, or null for an empty set (Follow target). */
export function averageLatLng(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  let lat = 0, lng = 0;
  for (const [a, b] of points) { lat += a; lng += b; }
  return [lat / points.length, lng / points.length];
}

export const AUTOZOOM_PAD = 0.15;

export type FitPlan =
  | { kind: 'none' }                              // empty selection ⇒ no-op
  | { kind: 'single'; center: LatLng }            // 1 point OR all-coincident ⇒ center @ current zoom
  | { kind: 'multi'; bounds: [LatLng, LatLng] };  // padded [SW, NE] for fitBounds

/** Classify the auto-zoom action for a set of points (pad defaults to 15%). */
export function planAutoZoom(points: LatLng[], pad: number = AUTOZOOM_PAD): FitPlan {
  if (points.length === 0) return { kind: 'none' };
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lat, lng] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  // 1 point, or every point identical ⇒ no meaningful box: center, don't zoom-to-max.
  if (minLat === maxLat && minLng === maxLng) return { kind: 'single', center: [minLat, minLng] };
  const dLat = (maxLat - minLat) * pad;
  const dLng = (maxLng - minLng) * pad;
  return { kind: 'multi', bounds: [[minLat - dLat, minLng - dLng], [maxLat + dLat, maxLng + dLng]] };
}
```

> **Scope note:** naive lat/lng mean; correct for co-located mesh nodes, not antimeridian-spanning sets — out of scope (same simplification the rest of the map uses).

### 3c. `src/components/MapAnalysis/FollowController.tsx` (new) — the `useMap()` view controller

A `useMap()` child rendering `null`, dropped inside `<MapContainer>`. Reads `useAnalysisNodes()` + `useMapAnalysisCtx()`.

**Selected points + change signature (rate-limit / act-only-on-change):**
```ts
const map = useMap();
const { config, followPaused, setFollowPaused } = useMapAnalysisCtx();
const analysisNodes = useAnalysisNodes();

const points = useMemo<LatLng[]>(() => {
  const sel = new Set(config.selectedNodeIds);
  return analysisNodes.filter((n) => sel.has(n.key)).map((n) => n.latLng);
}, [analysisNodes, config.selectedNodeIds]);

// Position signature — the apply effect keys on THIS, so it fires only when a
// coordinate actually changes, not on every render/poll that returns identical data.
const sig = useMemo(() => points.map((p) => `${p[0]},${p[1]}`).join('|'), [points]);
// Selection-membership signature — position-independent, used to reset pause.
const selKey = config.selectedNodeIds.join('|');
```

**Programmatic-move flag lifecycle (distinguishes our moves from the user's):**

All programmatic moves use `{ animate: false }` so `setView`/`fitBounds` fire their `moveend` **synchronously** within the call — no animation race. `moveend` is the single gate: it fires for pan **and** zoom (a zoom also moves the view), so one listener covers drag, wheel-zoom, double-click, box-zoom, keyboard, and zoom-control buttons uniformly. None of those set the flag.

```ts
const programmaticRef = useRef(false);

const applyView = useCallback((fn: () => void) => {
  programmaticRef.current = true;
  fn(); // animate:false ⇒ moveend fires synchronously and consumes the flag below
  // Safety net: if the move was a no-op (setView to the current center/zoom fires
  // NO moveend in Leaflet), clear the stuck flag before any user interaction can
  // occur (a frame is far shorter than any human gesture).
  const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 0);
  raf(() => { programmaticRef.current = false; });
}, []);

useEffect(() => {
  const onMoveEnd = () => {
    if (programmaticRef.current) { programmaticRef.current = false; return; } // our move — consume
    setFollowPaused(true); // genuine user pan/zoom ⇒ pause
  };
  map.on('moveend', onMoveEnd);
  return () => { map.off('moveend', onMoveEnd); };
}, [map, setFollowPaused]);
```

**Apply effect (Follow / Auto-zoom / both) — with no-op epsilon guard:**
```ts
useEffect(() => {
  if (followPaused) return;
  if (!config.followMode && !config.autoZoom) return;

  if (config.autoZoom) {
    const plan = planAutoZoom(points);           // Auto-zoom governs when both on
    if (plan.kind === 'none') return;
    if (plan.kind === 'single') {
      applyView(() => map.setView(plan.center, map.getZoom(), { animate: false }));
      return;
    }
    applyView(() => map.fitBounds(plan.bounds, { animate: false }));
    return;
  }

  // Follow only
  const center = averageLatLng(points);
  if (!center) return;
  const cur = map.getCenter();
  const EPS = 1e-6; // ~0.1 m; skip redundant setView (avoids churn + Leaflet no-op-move quirk)
  if (Math.abs(cur.lat - center[0]) < EPS && Math.abs(cur.lng - center[1]) < EPS) return;
  applyView(() => map.setView(center, map.getZoom(), { animate: false }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [sig, followPaused, config.followMode, config.autoZoom, map]);
```
`points` is read through the `sig`-gated effect (stable while `sig` stable); the `exhaustive-deps` disable is deliberate and documented — depending on `points`/`applyView` object identity would defeat the change-only gate.

**Pause auto-reset (re-engage on retarget / re-enable — but NOT on position drift):**
```ts
// Selection SET changed (not positions) ⇒ user retargeted ⇒ re-engage.
useEffect(() => { setFollowPaused(false); }, [selKey, setFollowPaused]);
// Toggling either mode ⇒ re-engage (turning on follows immediately; turning off is harmless).
useEffect(() => { setFollowPaused(false); }, [config.followMode, config.autoZoom, setFollowPaused]);
```
Critically, pause reset keys on `selKey` (membership), **never on `sig`** (positions) — otherwise every 15s poll that moves a node would silently un-pause and yank the map, defeating the pause. Clicking **Resume** (§3d) also sets `followPaused = false`, which re-runs the apply effect and snaps to the current view.

Returns `null`.

### 3d. `src/components/MapAnalysis/FollowResumeButton.tsx` (new) — pause affordance

Overlay button (sibling of `<MapContainer>`, like `MapLegend`). Shown only while a mode is active **and** paused:
```tsx
export default function FollowResumeButton() {
  const { config, followPaused, setFollowPaused } = useMapAnalysisCtx();
  const active = config.followMode || config.autoZoom;
  if (!active || !followPaused) return null;
  return (
    <button
      type="button"
      className="map-analysis-follow-resume"
      onClick={() => setFollowPaused(false)}
    >
      ⟳ Resume follow
    </button>
  );
}
```

### 3e. `src/components/MapAnalysis/MapAnalysisCanvas.tsx` (modify) — wiring

- Import `FollowController` and `FollowResumeButton`.
- Inside `<MapContainer>` (e.g. right after `<TileLayer/>`, alongside the panes): `<FollowController />`.
- As an overlay sibling after `<MapLegend />` (:79): `<FollowResumeButton />`.

### 3f. `src/components/MapAnalysis/MapAnalysisToolbar.tsx` (modify) — toggles

- Destructure the new setters: `const { config, …, setSelectedNodeIds, setFollowMode, setAutoZoom, … } = useMapAnalysisCtx();`
- Mount two plain toggle buttons after `<NodeMultiSelect … />` (:132), mirroring the Time-Slider button (:133-139):
  ```tsx
  <button
    type="button"
    className={`map-analysis-layer-btn ${config.followMode ? 'active' : ''}`}
    onClick={() => setFollowMode(!config.followMode)}
    title="Recenter on the selected nodes as they move (keeps zoom)"
  >
    Follow
  </button>
  <button
    type="button"
    className={`map-analysis-layer-btn ${config.autoZoom ? 'active' : ''}`}
    onClick={() => setAutoZoom(!config.autoZoom)}
    title="Zoom to fit the selected nodes as they move"
  >
    Auto-zoom
  </button>
  ```
Independently operable (each writes its own flag); "both on" precedence lives in the controller.

### 3g. `src/styles/map-analysis.css` (modify) — one overlay rule

Add near `.map-analysis-legend` (:369), reusing legend colors; position top-center so it's clearly the "map is paused" prompt:
```css
.map-analysis-follow-resume {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2000;
  background: #2563eb;
  color: #fff;
  border: 1px solid #2563eb;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
}
.map-analysis-follow-resume:hover { background: #1d4ed8; border-color: #1d4ed8; }
```

---

## 4. Pure helpers to extract & unit-test

- `averageLatLng(points)` — Follow center; `null` on empty (§3b).
- `planAutoZoom(points, pad=0.15)` — discriminated union `none` | `single` | `multi{bounds}`; encodes empty/single/coincident/multi + the 15% pad math (§3b).

All branching lives in these two pure functions; the controller effect just dispatches on the result and calls `map.setView`/`map.fitBounds`.

---

## 5. Test plan (Vitest, standard suite — no standalone scripts)

1. **`src/components/MapAnalysis/followMath.test.ts` (new)**
   - `averageLatLng([])` → `null`; `[[10,20]]` → `[10,20]`; `[[0,0],[10,20]]` → `[5,10]`.
   - `planAutoZoom([])` → `{kind:'none'}`.
   - `planAutoZoom([[10,20]])` → `{kind:'single',center:[10,20]}`.
   - Coincident: `planAutoZoom([[5,5],[5,5]])` → `{kind:'single',center:[5,5]}`.
   - Multi + exact pad: `planAutoZoom([[0,0],[10,20]])` → `{kind:'multi',bounds:[[-1.5,-3],[11.5,23]]}` (span 10×20, 0.15 pad = 1.5 / 3 each side).
   - Custom pad arg respected.

2. **`src/hooks/useMapAnalysisConfig.test.ts` (extend)**
   - `DEFAULT_CONFIG.followMode === false` && `.autoZoom === false`; fresh hook returns both false.
   - `setFollowMode(true)` / `setAutoZoom(true)` update config **and** persist (assert `JSON.parse(localStorage[KEY]).followMode/autoZoom`).
   - Old-config load: seed a `version:1` JSON omitting both keys ⇒ hook loads them as `false`, no throw.
   - Garbage coercion: seed `followMode:"yes"`, `autoZoom:1` ⇒ both coerced to `false`.
   - `reset()` returns both to `false`.

3. **`src/components/MapAnalysis/FollowController.test.tsx` (new)**
   Mock `react-leaflet`'s `useMap` to return a fake map: `on`/`off` recording handlers by event; `setView`/`fitBounds` as spies where **`setView`/`fitBounds` synchronously invoke the recorded `moveend` handler** (emulating `animate:false`); `getZoom()` → e.g. `10`; `getCenter()` → `{lat:0,lng:0}`. Mock `useAnalysisNodes` (return chosen `{key,latLng}` set) and `useMapAnalysisCtx` (config + `followPaused` + spy `setFollowPaused`). Assert:
   - **Follow, 2 selected points** → `setView` called with `averageLatLng` center and `getZoom()` zoom; `fitBounds` NOT called.
   - **Auto-zoom, 2 points** → `fitBounds` called with the `planAutoZoom` padded bounds; `setView` NOT called.
   - **Both on** → `fitBounds` called, `setView` NOT (Follow suppressed).
   - **Single selected point, Auto-zoom** → `setView(center, 10)` (NOT `fitBounds`) — no zoom-to-max.
   - **Empty selection** (or none of the selected keys positioned) → neither `setView` nor `fitBounds` called.
   - **Programmatic move doesn't self-pause:** after the mode-driven `setView`/`fitBounds` fires the synchronous `moveend`, `setFollowPaused` was NOT called with `true`.
   - **User move pauses:** invoke the recorded `moveend` handler directly (flag false) → `setFollowPaused(true)` called once.
   - **Paused ⇒ inert:** with `followPaused=true`, no `setView`/`fitBounds`.
   - **Follow no-op guard:** `getCenter()` already equal to the average ⇒ `setView` NOT called.

4. **`src/components/MapAnalysis/FollowResumeButton.test.tsx` (new)**
   Render inside a mocked ctx. Assert: hidden when no mode active; hidden when active but not paused; **visible** when `(followMode||autoZoom) && followPaused`; click calls `setFollowPaused(false)`.

5. **`src/components/MapAnalysis/MapAnalysisToolbar.test.tsx` (extend, or thin new)** *(optional but recommended)*
   With mocked hooks, assert the **Follow** and **Auto-zoom** buttons render, carry `active` class per config, and clicking calls `setFollowMode`/`setAutoZoom` with the toggled value.

**Also:** `npm run typecheck` clean; `npm run lint:ci` exits 0 (no new `any`; no raw `fetch()` — all data via existing hooks); full Vitest suite 0 failures.

---

## 6. Work-package decomposition

Sized for one Sonnet agent each. **WP-A and WP-B are independent foundations (parallel).** WP-C depends on both; WP-D depends on WP-A (and lands with/after WP-C for end-to-end resume).

### WP-A — Config flags + transient pause state (foundation)
- Extend `MapAnalysisConfig`/`DEFAULT_CONFIG`/`load()`/setters with `followMode`,`autoZoom` (§2).
- Add transient `followPaused`/`setFollowPaused` to `MapAnalysisContext` (§3a).
- Extend `useMapAnalysisConfig.test.ts` (test #2).
- **Accept:** config + existing tests green; typecheck clean; defaults false; old-config/garbage coerce to false.

### WP-B — Pure follow math (foundation, parallel with WP-A)
- Create `followMath.ts` (§3b) + `followMath.test.ts` (test #1).
- **Accept:** average + all `planAutoZoom` branches (empty/single/coincident/multi) pass incl. exact 15% pad math; no leaflet import; typecheck clean.

### WP-C — Controller + canvas wiring (depends on WP-A + WP-B)
- Create `FollowController.tsx` (§3c): selected-points/`sig` derivation, `moveend`-gated manual-pan detection with the `programmaticRef` + `animate:false` + rAF safety-net lifecycle, apply effect (Follow/Auto-zoom/both, epsilon guard), pause auto-reset on `selKey`/toggles.
- Wire `<FollowController/>` into `MapAnalysisCanvas` `<MapContainer>` (§3e).
- `FollowController.test.tsx` (test #3).
- **Accept:** all controller assertions pass — programmatic move never self-pauses, user move pauses, both-on precedence, single/empty handled; typecheck clean.

### WP-D — Toolbar toggles + Resume overlay (depends on WP-A)
- Add Follow/Auto-zoom toggle buttons to `MapAnalysisToolbar` (§3f).
- Create `FollowResumeButton.tsx` (§3d) + `.map-analysis-follow-resume` CSS (§3g); wire as canvas overlay sibling (§3e).
- Tests #4 (+ optional #5).
- **Accept:** toggles render/persist/independently operable; Resume shows only while active+paused and clears pause; typecheck clean.

**Final integration gate (after all WPs):** full Vitest suite 0 failures; `npm run typecheck` clean; `npm run lint:ci` exits 0; browser-validate on `/analysis`: select ≥2 nodes → **Follow** recenters to average, keeps zoom; **Auto-zoom** fits + margin; manual pan shows "Resume follow" and stops yanking; Resume re-engages; single-node selection centers without zoom-to-max; empty selection = no-op; toggles persist across reload.
