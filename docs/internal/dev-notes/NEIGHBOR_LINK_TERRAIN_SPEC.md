# Neighbor-Link Terrain Integration — Phase 1 Implementation Spec

**Epic:** 3D Map & Elevation (#3826)
**Phase:** 1 — Neighbor-link terrain integration
**Branch:** `feature/3826-neighbor-link-terrain`
**Author:** Phase Architect (Opus)
**Status:** Ready for implementation

---

## 0. Goal (restated)

When a neighbor link is selected in the Map Analysis workspace, the inspector
panel (`AnalysisInspectorPanel`) surfaces terrain-aware information:

1. **Link distance** (great-circle) — always, when both endpoints have positions.
2. **Endpoint ground elevations** (DEM) — only when `elevationEnabled`.
3. **"View terrain profile"** action — opens the **existing** Link Profile
   drawer pre-populated with the link's two endpoints, reusing the existing
   `MapAnalysisContext` link-profile state machine. **No parallel drawer.**

Works for Meshtastic **and** MeshCore neighbor links when both endpoints have
positions; degrades gracefully otherwise. Gated on `useElevationEnabled` for
elevations + the profile action, consistent with the toolbar's Link Profile
button (which is *hidden* when elevation is disabled).

This phase is **frontend-only**. No backend changes (justification in §3.5).

---

## 1. Reuse inventory (build on these — do not duplicate)

| Concern | Existing asset | Path | How Phase 1 uses it |
|---|---|---|---|
| Link-profile state machine | `linkProfileMode` / `setLinkProfileMode`, `linkEndpoints` / `setLinkEndpoints`, `measureMode` / `setMeasureMode` | `src/components/MapAnalysis/MapAnalysisContext.tsx` | Inspector's "View terrain profile" writes these to open the drawer. **No new context state.** |
| Endpoint type | `LinkEndpoint` (`{ id, lat, lng, isNode, sourceId?, sourceIds?, nodeNum?, isMeshCore?, label? }`) | `src/utils/linkProfile.ts` | Neighbor endpoints are built as `LinkEndpoint[]` in the exact shape `MapAnalysisCanvas` already produces for the picker, so `useAutoRadioDefaults` resolves per-source freq/RX. |
| Elevation profile fetch | `useElevationProfile(a, b)` — TanStack query keyed on rounded coords, `staleTime` 30 min | `src/hooks/useElevationProfile.ts` | Inspector reuses it to read `samples[0]`/`samples[last]` elevation. **Identical query key to the drawer ⇒ shared cache, zero double-fetch** (§2.1). |
| Elevation gating | `useElevationEnabled()` → boolean | `src/hooks/useElevationEnabled.ts` | Gates endpoint elevations + the profile action (mirrors the toolbar). |
| Great-circle distance | `calculateDistance(lat1,lon1,lat2,lon2)` → km | `src/utils/distance.ts` | Link distance. **Do not add a new haversine.** |
| Distance formatting | `formatDistance(km, unit)` | `src/utils/distance.ts` | Formats distance with the user's unit. |
| Distance unit preference | `useSettings().distanceUnit` | `src/contexts/SettingsContext.tsx` | Feeds `formatDistance` (same as `LinkProfileDrawer`). |
| Position resolution | `resolveNodeLatLng(node)` → `[lat,lng] \| null` (handles flat + nested shape, Null-Island discard) | `src/components/MapAnalysis/nodePositionUtil.ts` | Resolves both endpoint coordinates from the unified node list. |
| Unified node list | `useDashboardUnifiedData(sourceIds)` → `{ nodes }` (already consumed in the inspector) | `src/hooks/useDashboardData.ts` | The node array the endpoint resolver walks. Already present in the inspector — no new fetch. |
| Node shape | `NodeRecord` (`nodeNum`, `sourceId`, `isMeshCore`, `publicKey`, `sources: NodeSourceRef[]`, position fields) | `src/components/MapAnalysis/useAnalysisNodes.ts` | Reference shape for the endpoint resolver's node param. |
| The drawer itself | `LinkProfileDrawer` (mounted unconditionally in the canvas; renders when `linkProfileMode` on **or** endpoints exist; fetches profile; owns AGL/budget defaults) | `src/components/MapAnalysis/LinkProfileDrawer.tsx` | Opened by the inspector action. **Not modified.** |
| Map path renderer | `LinkProfileController` (renders verdict-colored polyline + endpoint rings when `linkProfileMode` is on) | `src/components/MapAnalysis/LinkProfileController.tsx` | Renders automatically once the action sets `linkProfileMode=true`. **Not modified.** |
| Neighbor selection shape | `SelectedTarget` (`type:'neighbor'`, meshtastic: `nodeNum`/`neighborNum`/`sourceId`; meshcore: `publicKey`/`neighborPublicKey`/`nodeName`/`neighborName`; both: `snr`/`timestamp`) | `src/components/MapAnalysis/MapAnalysisContext.tsx` | Input to the endpoint resolver. **No shape change needed** (§2.4). |

### Justification for the one new file

`SelectedTarget` (neighbor variant) carries only identifiers (nodeNum/neighborNum
or publicKey/neighborPublicKey) — **not coordinates**. Turning a neighbor
selection into a `LinkEndpoint` pair requires a lookup against the unified node
list plus the cross-source position fallback the layers use (#3792). That
mapping is pure, testable, and used from a React component, so it belongs in a
small dedicated module (`neighborLinkEndpoints.ts`) rather than inlined in the
already-large `AnalysisInspectorPanel`. No existing helper does this
(the layers resolve positions into a `Map` for rendering, not into
`LinkEndpoint` objects).

---

## 2. Design decisions

### 2.1 Endpoint-elevation sourcing — reuse `useElevationProfile`, no new endpoint

**Decision:** The inspector calls `useElevationProfile(endpointA, endpointB)`
(the same hook the drawer uses) and reads the **first** and **last** sample
elevations for the two endpoints. It does **not** add a point-elevation
endpoint and does **not** call the profile endpoint with a custom sample count.

**Why this is the cheapest correct option:**
- The only elevation routes that exist are `POST /api/elevation/profile` and
  `POST /api/elevation/test` (verified — no point endpoint). A profile with the
  default sample count already contains the endpoint elevations as `samples[0]`
  and `samples[samples.length-1]`.
- `useElevationProfile`'s query key is `['elevation-profile', [roundA], [roundB]]`
  — **it does not include the sample count**. Calling it from the inspector with
  the same endpoints the drawer will use produces the **identical cache entry**.
  So when the user then clicks "View terrain profile", the drawer's own
  `useElevationProfile` call is a **cache hit** — the profile is fetched **once**
  per distinct link and shared. This is strictly better than a separate
  small-`samples` call, which would create a *different* logical need but the
  *same* cache key (latent aliasing) — so we deliberately keep the default
  sample count to guarantee cache-sharing with the drawer.
- Result: **one** elevation request per distinct neighbor link, cached 30 min,
  reused by the drawer. No new route, no new hook.

**Rate-limit reasoning (`elevationLimiter` = 20/min, `optionalAuth`):**
- Cost is one request per *distinct* link selection (TanStack Query dedups +
  30-min `staleTime`). Re-selecting the same link, or opening its drawer, costs
  nothing.
- Worst case: a user rapidly clicks ~20+ *different* neighbor links within a
  minute → a 429 on the surplus. This degrades gracefully: distance still
  renders (it's pure math), elevations show `—`, and the action still opens the
  drawer (which surfaces the elevation error UI it already has). Acceptable and
  self-healing (the drawer would have fired the same request anyway).
- **Rejected alternative:** show distance + action only in the inspector and let
  elevations appear *inside* the drawer. Rejected because the epic exit criteria
  explicitly require *"distance (+ elevations when enabled)"* in the inspector.
  The reuse approach delivers inspector elevations at zero marginal fetch cost
  vs. opening the drawer.

**Gating of the fetch:** the hook is passed `undefined` endpoints (→ query
disabled) whenever elevation is disabled **or** either endpoint lacks a
position. So a browse with elevation off, or over unpositioned links, issues
**no** elevation requests at all.

### 2.2 Gating behavior (consistent with the toolbar)

| Condition | Distance | Endpoint elevations | "View terrain profile" action |
|---|---|---|---|
| Both endpoints positioned, `elevationEnabled` | ✅ shown | ✅ shown (loading `…` / value / `—` if DEM null) | ✅ shown |
| Both endpoints positioned, elevation disabled | ✅ shown | ❌ hidden (no fetch) | ❌ hidden |
| One/both endpoints have no position | ❌ (can't compute) | ❌ | ❌ |

The action + elevations are gated by `useElevationEnabled()`, mirroring
`MapAnalysisToolbar` which **hides** the Link Profile button entirely when
elevation is disabled. Distance is unconditional on positions (pure geometry, no
elevation dependency) — this is *additive* to the existing neighbor panel
(names, source, SNR, reported), which continues to render unchanged.

### 2.3 Opening the drawer — reuse the state machine exactly

The "View terrain profile" handler performs, in order:

```ts
setMeasureMode(false);            // mutual exclusivity, matches toolbar handler
setLinkEndpoints([endpointA, endpointB]);
setLinkProfileMode(true);
```

- `LinkProfileDrawer` (mounted unconditionally in `MapAnalysisCanvas`) renders
  because `linkProfileMode` is now true and endpoints are set; it fetches the
  profile (cache hit, §2.1) and computes verdict/budget.
- `LinkProfileController` mounts (gated on `linkProfileMode`) and draws the
  verdict-colored polyline + endpoint rings on the map — identical to using the
  toolbar tool and picking both endpoints.
- Setting `linkProfileMode=true` also arms the capture-phase picker, so a
  subsequent map click restarts endpoint A. This is **the existing, expected**
  tool behavior — no divergence, no special-casing.

This is the minimal correct way to open the drawer with the two endpoints and is
100% reuse of the existing flow. **No new "open drawer" API is added to context.**

### 2.4 MeshCore handling

- `SelectedTarget` already distinguishes MeshCore neighbor links by the presence
  of `publicKey` (the inspector's existing `isMeshCore = !!selected.publicKey`
  branch). No `SelectedTarget` change needed.
- Endpoint resolution for MeshCore keys on `publicKey`/`neighborPublicKey`
  against unified nodes where `isMeshCore && publicKey` match — mirroring
  `MeshCoreNeighborLinksLayer`'s `positionByKey`. MeshCore unified nodes carry a
  `nodeNum` (populated by the merge), so the built `LinkEndpoint` sets
  `nodeNum` from the resolved record and `isMeshCore: true` — exactly the shape
  `MapAnalysisCanvas.linkEndpointCandidates` produces for MeshCore, so
  `useAutoRadioDefaults` behaves identically.
- Meshtastic keys on `nodeNum`/`neighborNum` with the #3792 cross-source
  fallback (prefer the reporting `sourceId`'s record; fall back to any source
  that has the node positioned). `isMeshCore: false`.

### 2.5 Antenna-height / frequency defaults when opening from a link

Nothing to override. The inspector hands the drawer only the two `LinkEndpoint`
objects. The drawer owns all budget defaults (`DEFAULT_AGL_M = 2` for both
antennas, `DEFAULT_FREQ_MHZ = 915`, etc.) and its `useAutoRadioDefaults`
auto-seeds per-source frequency/RX-sensitivity from the endpoints' `sourceId`/
`sourceIds`/`nodeNum`/`isMeshCore`. Because we build endpoints in the same shape
`MapAnalysisCanvas` already produces, defaults and auto-seeding match the
toolbar-driven flow byte-for-byte. **Match by construction, not by copying
constants.**

---

## 3. File-by-file changes

### 3.1 NEW — `src/components/MapAnalysis/neighborLinkEndpoints.ts`

Pure, react-free. Resolves a neighbor `SelectedTarget` into a `LinkEndpoint`
pair using the unified node list.

```ts
import type { LinkEndpoint } from '../../utils/linkProfile';
import type { SelectedTarget } from './MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from './nodePositionUtil';

/** Minimal node shape the resolver needs (subset of useAnalysisNodes NodeRecord). */
export interface EndpointNodeRecord extends MaybePositionedNode {
  nodeNum?: number;
  sourceId?: string;
  isMeshCore?: boolean;
  publicKey?: string | null;
  longName?: string | null;
  shortName?: string | null;
  sources?: Array<{ sourceId: string }>;
}

export interface NeighborEndpoints {
  a: LinkEndpoint;
  b: LinkEndpoint;
}

/**
 * Build a LinkEndpoint pair for a selected neighbor link, or null when either
 * endpoint cannot be resolved to a rendered position. Meshtastic links key on
 * nodeNum with the #3792 cross-source fallback; MeshCore links key on publicKey.
 */
export function resolveNeighborEndpoints(
  selected: SelectedTarget,
  nodes: EndpointNodeRecord[],
): NeighborEndpoints | null;
```

Behavior:
- Guard: `selected.type !== 'neighbor'` → `null`.
- `isMeshCore = !!selected.publicKey`.
- **Meshtastic:** find node A by `nodeNum === selected.nodeNum` preferring
  `sourceId === selected.sourceId`, else any positioned match; node B likewise
  for `selected.neighborNum`. (Mirror `NeighborLinksLayer`'s
  `positionByKey`→`positionByNode` fallback.)
- **MeshCore:** find node A by `isMeshCore && publicKey === selected.publicKey`
  preferring `sourceId === selected.sourceId`, else any positioned match; node B
  by `neighborPublicKey`.
- For each, `resolveNodeLatLng(node)`; if either is `null` → return `null`.
- Build each `LinkEndpoint`:
  ```ts
  {
    id: isMeshCore ? `${node.sourceId ?? ''}:${node.publicKey ?? ''}`
                   : `${node.sourceId ?? ''}:${node.nodeNum}`,
    lat, lng,
    isNode: true,
    sourceId: node.sourceId,
    sourceIds: node.sources?.map(s => s.sourceId) ?? (node.sourceId ? [node.sourceId] : []),
    nodeNum: node.nodeNum,
    isMeshCore,
    label: node.shortName ?? undefined,
  }
  ```
  (`id` shape/semantics match `MapAnalysisCanvas.linkEndpointCandidates`; the
  key format is only used for React-Query/`useAutoRadioDefaults` identity, so
  MeshCore's publicKey-based id is fine.)

> Import note: `SelectedTarget` is exported from `MapAnalysisContext.tsx`; import
> it as a type to avoid a runtime cycle (`import type`).

### 3.2 MODIFY — `src/components/MapAnalysis/AnalysisInspectorPanel.tsx`

New imports:
```ts
import { useSettings } from '../../contexts/SettingsContext';
import { useElevationEnabled } from '../../hooks/useElevationEnabled';
import { useElevationProfile } from '../../hooks/useElevationProfile';
import { calculateDistance, formatDistance } from '../../utils/distance';
import { resolveNeighborEndpoints } from './neighborLinkEndpoints';
```

Destructure additional context setters:
```ts
const {
  config, selected, setInspectorOpen,
  setLinkEndpoints, setLinkProfileMode, setMeasureMode,
} = useMapAnalysisCtx();
const { distanceUnit } = useSettings();
const elevationEnabled = useElevationEnabled();
```

Add top-level hooks (unconditional — React rules; `selected`/`nodes` may be
anything, the memo just returns `null` when not a neighbor):
```ts
const neighborEndpoints = useMemo(
  () =>
    selected?.type === 'neighbor'
      ? resolveNeighborEndpoints(selected, (nodes ?? []) as EndpointNodeRecord[])
      : null,
  [selected, nodes],
);

// Same query key as LinkProfileDrawer ⇒ shared cache. Disabled unless elevation
// is on AND both endpoints resolved.
const elevA = elevationEnabled ? neighborEndpoints?.a : undefined;
const elevB = elevationEnabled ? neighborEndpoints?.b : undefined;
const { data: neighborProfile, isLoading: neighborElevLoading } =
  useElevationProfile(elevA, elevB);
```

Neighbor branch (`selected.type === 'neighbor'`) additions — keep the existing
`<h3>`, subtitle, Node/Neighbor/Source/SNR/Reported `<dl>`, then append:

- **Distance** row when `neighborEndpoints` is non-null:
  ```ts
  const distKm = neighborEndpoints
    ? calculateDistance(a.lat, a.lng, b.lat, b.lng)   // a=neighborEndpoints.a, b=.b
    : null;
  // <dt>Distance</dt><dd>{distKm != null ? formatDistance(distKm, distanceUnit) : '—'}</dd>
  ```
- **Endpoint elevations** rows, only when `elevationEnabled && neighborEndpoints`:
  read `neighborProfile.samples[0].elevation` and
  `neighborProfile.samples[samples.length-1].elevation`.
  - loading → `…`; value present → `formatElevation(m)` (e.g. `${Math.round(m)} m`);
    `null`/no data → `—`.
  - Render a small helper `formatElevation(m: number | null | undefined): string`
    (local const, like the existing `formatNumber` family).
- **"View terrain profile" button**, only when `elevationEnabled && neighborEndpoints`:
  ```tsx
  <button
    type="button"
    className="map-analysis-link-profile-action"
    onClick={() => {
      setMeasureMode(false);
      setLinkEndpoints([neighborEndpoints.a, neighborEndpoints.b]);
      setLinkProfileMode(true);
    }}
  >
    View terrain profile
  </button>
  ```
  (Reuse an existing button style class where one fits; a new class is a CSS-only
  add if needed — no baseline impact.)

Notes / constraints:
- No raw `fetch()` — all data via hooks/`ApiService` (satisfied).
- No `any` — type the local node cast as `EndpointNodeRecord[]` (or reuse the
  panel's existing `NodeRecord`, widened to include `publicKey`/`isMeshCore`/
  `sources`). Prefer importing `EndpointNodeRecord` from the new helper.
- `react-hooks/exhaustive-deps`: the new `useMemo` deps are `[selected, nodes]`
  — complete, no disable needed.
- All added hooks are at the top level, before the existing early returns
  (`!config.inspectorOpen`, `!selected`), so hook order is stable.

### 3.3 MODIFY — `src/components/MapAnalysis/AnalysisInspectorPanel.test.tsx` (or new sibling)

See §4.

### 3.4 (Optional) `nodes.css` / MapAnalysis stylesheet

If a new `.map-analysis-link-profile-action` button class is introduced, add its
rule to the existing MapAnalysis CSS. CSS-only; not lint/baseline relevant.
Beware the documented `nodes.css` cascade-order gotcha if editing that file.

### 3.5 Backend — NO changes (justification)

The endpoint elevations come from the already-shipped `POST /api/elevation/profile`
(reused via `useElevationProfile`). No point-elevation endpoint is needed
(§2.1) and adding one would duplicate the profile-endpoint's SSRF/clamp/rate-limit
surface for a strictly-worse cache story. All other data (positions, neighbor
identity, distance) is already client-side. **Frontend-only phase confirmed.**

---

## 4. Test plan (Vitest — standard suite, no standalone scripts)

### 4.1 NEW — `src/components/MapAnalysis/neighborLinkEndpoints.test.ts` (pure helper)

- **Meshtastic, both positioned** → returns endpoints with correct
  `lat/lng/id/sourceId/nodeNum/isMeshCore:false`; `sourceIds` derived from
  `sources`.
- **Meshtastic, cross-source fallback (#3792)** → endpoint B positioned only
  under a different source than `selected.sourceId` still resolves.
- **Meshtastic, one endpoint unpositioned** → `null`.
- **MeshCore, both positioned** (matched by `publicKey`/`neighborPublicKey`,
  `isMeshCore:true`, `nodeNum` from record) → endpoints returned.
- **MeshCore, publicKey not found** → `null`.
- **Null-Island endpoint** (0,0 discarded by `resolveNodeLatLng`) → `null`.
- **Non-neighbor selection** → `null`.

### 4.2 EXTEND — `AnalysisInspectorPanel.test.tsx`

Add mocks: `../../hooks/useElevationEnabled` and `../../hooks/useElevationProfile`
(both `vi.mock`), plus `../../contexts/SettingsContext` `useSettings` returning
`{ distanceUnit: 'km' }`. Extend the `useDashboardUnifiedData` node fixture with a
second positioned node (nodeNum 2) and a MeshCore pair (publicKeys) so neighbor
resolution has data. (Non-DB component mocks are still correct per CLAUDE.md —
this is not a route test, so the route harness does not apply.)

Cases:
- **Neighbor, both positioned, elevation ENABLED** → renders `Neighbor Link`,
  `Distance` with a formatted value, both endpoint elevation rows, and a
  `View terrain profile` button. (`useElevationProfile` mock returns samples
  with known first/last elevations; assert the rounded metres render.)
- **Neighbor, both positioned, elevation DISABLED**
  (`useElevationEnabled → false`) → `Distance` shown; **no** elevation rows;
  **no** `View terrain profile` button. Assert `useElevationProfile` mock was
  called with `undefined` endpoints (fetch gated off) — or simply assert the
  button/elevation rows are absent.
- **Neighbor, an endpoint unpositioned** → no Distance, no elevations, no action
  (panel still shows names/source/SNR).
- **Profile action dispatch** → click `View terrain profile`; assert context
  state via a probe component reading `useMapAnalysisCtx()`:
  `linkProfileMode === true`, `linkEndpoints.length === 2` with the expected
  `nodeNum`s / `isMeshCore` flags, and `measureMode === false`.
- **MeshCore variant** → select a MeshCore neighbor (set `publicKey`/
  `neighborPublicKey`/names); assert Distance + action render and the dispatched
  `linkEndpoints` carry `isMeshCore: true`.
- **Elevation loading state** → `useElevationProfile` mock `{ isLoading: true }`
  → elevation rows show the loading placeholder (`…`), Distance still shown.

Existing inspector tests (node/segment/empty/collapse) must remain green
unchanged.

---

## 5. Work packages

Small phase — **2 packages**, WP-2 depends on WP-1.

### WP-1 — Pure endpoint resolver + tests  *(Sonnet)*
**Scope:** Create `src/components/MapAnalysis/neighborLinkEndpoints.ts`
(`resolveNeighborEndpoints` + `EndpointNodeRecord`/`NeighborEndpoints` types) and
`neighborLinkEndpoints.test.ts`.
**Depends on:** nothing.
**Acceptance:**
- All §4.1 cases pass.
- Pure/react-free; no `any`; `tsc` clean; imports `LinkEndpoint`/`SelectedTarget`
  as types only.
- Endpoint `id`/`sourceIds`/`nodeNum`/`isMeshCore` shape matches
  `MapAnalysisCanvas.linkEndpointCandidates` for both protocols.

### WP-2 — Inspector integration + component tests  *(Sonnet)*
**Scope:** Wire `AnalysisInspectorPanel` neighbor branch: distance row (always,
when positioned), endpoint elevation rows + "View terrain profile" action (gated
on `useElevationEnabled`), via `resolveNeighborEndpoints` + `useElevationProfile`
(shared-cache) + `useSettings`. Optional CSS for the action button. Extend
`AnalysisInspectorPanel.test.tsx` per §4.2.
**Depends on:** WP-1.
**Acceptance:**
- All §4.2 cases pass; existing inspector tests still green.
- Elevation fetch gated off (undefined endpoints) when elevation disabled or an
  endpoint is unpositioned.
- Profile action sets `linkProfileMode`/`linkEndpoints`/`measureMode` correctly
  (asserted via context probe); opening the drawer in the live app is a
  cache-hit (browser-validated on the dev container).
- No raw `fetch()` in the component; no `any`; no new
  `react-hooks/exhaustive-deps` violations; `npm run lint:ci` exits 0; full
  Vitest suite green.

---

## 6. Out of scope (Phase 1)

- No 3D map, no MapLibre component, no tile proxy (Phases 2–3).
- No changes to `LinkProfileDrawer` / `LinkProfileController` / the elevation
  backend.
- No new context state, no new API route, no migration.
