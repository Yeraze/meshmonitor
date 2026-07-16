# Link Profile Tool — Implementation Spec (Terrain Link Profile Epic #4111, Phase 2)

**Branch:** `feature/link-profile-tool` (worktree `../meshmonitor-link-profile`, based on `origin/main` incl. Phase 1 elevation backend).
**Scope:** Frontend only. Pure math utils, a two-point picker controller, a bottom drawer chart + link-budget panel, a toolbar button gated on `elevationEnabled`, an ApiService method, and tests. **No backend changes** — Phase 1's `POST /api/elevation/profile` is frozen and consumed as-is.

**Exit criteria (from epic):** end-to-end in browser: pick two nodes → drawer shows terrain profile + Fresnel + budget verdict; matches site.meshtastic.org for a reference link; full Vitest suite green; `npm run lint:ci` exits 0; merged.

---

## 0. Key decisions (interview + design)

1. **Elevation model = DEM terrain + antenna height AGL (site.meshtastic.org model).** The LOS baseline at each endpoint is `terrainElevation(endpoint) + antennaHeightAGL`, where `terrainElevation` is the Phase‑1 DEM sample at the endpoint. **Node GPS altitude is deliberately NOT used** for the LOS geometry. Rationale: node GPS altitude is frequently WGS‑84 ellipsoidal (or absent/noisy) while the DEM returns orthometric terrain height; mixing them injects tens of metres of datum error. Terrain + AGL is self-consistent, matches site.meshtastic.org, and is simpler. (Phase 3 may optionally surface node GPS altitude as an alternate baseline; out of scope here.)
2. **Bottom drawer chart** (not a modal/side panel), rendered as an absolutely-positioned overlay inside `.map-analysis-canvas` so the map stays usable above it — mirrors how `TimeSliderControl` / `MapLegend` already sit over the canvas.
3. **FULL link budget** readout: FSPL, RX power, margin, and a geometry verdict (clear / marginal / obstructed) shown together.
4. **Picker UX:** click snaps to the nearest node when the click lands within a pixel threshold of one; otherwise the raw clicked map point becomes an arbitrary (non-node) endpoint. No modifier key required. Mirrors `MeasureDistanceController`'s capture-phase click interception exactly.
5. **Recompute-without-refetch:** the elevation profile is geometry-only (depends solely on the two coordinates + sample count). Budget-input edits (frequency, heights, power, gains, cable loss, RX sensitivity, k-factor) recompute the analysis client-side from the already-fetched samples — no new elevation request. Frequency and antenna heights change the *analysis* (Fresnel radius, LOS baseline), not the elevation samples, so they also do **not** refetch.
6. **Frequency default 915 MHz**, manual editable field. Phase 3 wires per-source auto-detection.
7. **Documented default budget constants** (all editable in the drawer): antenna height 2 m AGL each end, TX power 20 dBm, TX/RX gain 2.15 dBi each, cable loss 0 dB, RX sensitivity −129 dBm (LongFast SF11/BW125), earth k-factor 4/3, sample count 256 (backend default).

### Verified reference values (independently computed — use as test fixtures)

| Quantity | Formula | Inputs | Value |
|---|---|---|---|
| FSPL | `20log10(d_km)+20log10(f_MHz)+32.44` | 33.3 km, 915 MHz | **122.117 dB** |
| FSPL | same | 1 km, 100 MHz | **72.440 dB** (clean: 0+40+32.44) |
| FSPL | same | 10 km, 915 MHz | 111.668 dB |
| Wavelength | `c/f` | 915 MHz | **0.32764 m** |
| Fresnel r₁ (midpoint) | `sqrt(λ·d1·d2/(d1+d2))`, d1=d2=D/2 = `0.5·sqrt(λD)` | 10 km link, 915 MHz | **28.620 m** |
| Fresnel r₁ | general | d1=3000, d2=7000, 915 MHz | 26.231 m |
| Earth bulge (mid) | `d1·d2/(2·k·R)`, R=6371000 | 33.3 km, k=4/3 | 16.317 m |
| Earth bulge (mid) | same, k=1 | 33.3 km | 21.757 m |
| RX power | `Ptx+Gtx+Grx−Lcable−FSPL` | 20+2.15+2.15−0−122.117 | **−97.817 dBm** |
| Margin | `Prx−RXsens` | −97.817 − (−129) | **+31.183 dB** |

---

## 1. Reuse inventory (verified against the tree)

| What | Where | Reuse |
|---|---|---|
| Two-point picker UX (capture-phase click, snap-to-nearest, Escape-to-exit, CircleMarker/Polyline render) | `src/components/MeasureDistanceController.tsx` (click handler L68–91; render L107–133) | **Clone the structure** into `LinkProfileController`. Same `map.getContainer()` capture listener, `.leaflet-control` guard, `map.mouseEventToLatLng(e)`. |
| Pure picker geometry, `MeasurePoint`, `nearestPoint` | `src/utils/measureDistance.ts` (`MeasurePoint` L20‑25, `nearestPoint` L31‑46) | **Reuse `nearestPoint`**; extend `MeasurePoint` for `LinkEndpoint`. |
| Great-circle + LatLng (Phase‑1, **already shared/react-free in `src/utils/`**) | `src/utils/greatCircle.ts` (`LatLng` L14‑17, `interpolateGreatCircle`) | **Reuse `LatLng`** for endpoint coords; server already samples the great circle, so the client does not re-interpolate. |
| Haversine distance | `src/utils/distance.ts` (`calculateDistance`) | Reuse for pixel-vs-node snap fallback and any km math. |
| recharts `ComposedChart` composition (Area + Line + XAxis/YAxis/Tooltip/CartesianGrid/ResponsiveContainer) | `src/components/TelemetryChart.tsx` (imports L18; chart L~330+) | **Mirror** for the profile chart; add `ReferenceDot`/`ReferenceLine` from recharts (same package). |
| Toolbar tool-button + transient mode state | `MapAnalysisToolbar.tsx` "Measure" button (`disabled={analysisNodes.length < 2}`, active class); `MapAnalysisContext.tsx` `measureMode`/`setMeasureMode` | **Clone** the button + a `linkProfileMode` context slice. |
| Canvas controller + overlay wiring | `MapAnalysisCanvas.tsx`: `{measureMode && <MeasureDistanceController .../>}` inside `<BaseMap>` (L~150); `TimeSliderControl`/`MapLegend` siblings after `</BaseMap>` inside `.map-analysis-canvas` (`position: relative`) | **Clone**: controller inside `<BaseMap>`, drawer as a post-`BaseMap` sibling. |
| Shared positioned-node list (drives markers + measure points) | `useAnalysisNodes()` → `AnalysisNode { node, latLng:[lat,lng], key }` (`src/components/MapAnalysis/useAnalysisNodes.ts`); mapped to `MeasurePoint[]` in `MapAnalysisCanvas.tsx` L60‑68 | **Reuse the same memo** to build `LinkEndpoint[]` candidates. |
| ApiService request/get/post (raw JSON body, **does not unwrap `data`**) | `src/services/api.ts` (`request`/`get`/`post`, `ApiError`) | **Add `getElevationProfile`**; it must unwrap `.data` from the `{success,data}` envelope. |
| Elevation route (frozen) | `POST /api/elevation/profile` — body `{ pointA:{lat,lng}, pointB:{lat,lng}, samples? }`; envelope `ok(res,{ distanceMeters, provider, samples:[{distance,lat,lng,elevation}] })`; codes `ELEVATION_DISABLED`(403)/`INVALID_BODY`(400) | Consume as-is. **CSRF:** apiRouter applies `csrfProtection` to all POST `/api/*` (`server.ts` L5847/5849); `csrfTokenMiddleware` issues a token to every session incl. anonymous, and `ApiService.post` attaches `X-CSRF-Token`. Anonymous POST works — no backend change needed. |
| Availability flag source | `GET /api/settings` returns a **bare settings map** (not enveloped — `SettingsContext` reads `settings.maxNodeAgeHours` directly, L1199‑1205). `elevationEnabled` is non-secret and present. | **New `useElevationEnabled` TanStack hook** reads it; do **not** touch the giant `SettingsContext` handleSave dep-array. |
| TanStack Query is the established data-fetch pattern | `src/hooks/useMapAnalysisData.ts`, `src/hooks/useDashboardData.ts` | New hooks use `useQuery` + `ApiService`. |
| Node position resolution + `altitude` availability | `nodePositionUtil.ts` `resolveNodeLatLng` (lat/lng only); `src/types/device.ts` has `altitude?` (L14/L141/L167) | Confirms altitude *exists* but per decision #1 we **do not** consume it. |
| Picker/controller test harness (mock react-leaflet, synthetic capture-phase click) | `src/components/MeasureDistanceController.test.tsx` | **Clone** for `LinkProfileController.test.tsx`. |
| Leaflet-label CSS pattern | `src/components/MeasureDistanceController.css` | Clone for the controller's endpoint label. |
| Page stylesheet convention | `src/styles/map-analysis.css` (`.map-analysis-canvas` L21, `.map-analysis-layer-btn` L105) | Append drawer + button styles here (page convention); tiny leaflet-label CSS in a dedicated `LinkProfileController.css`. |

**Greenfield:** no Fresnel/link-budget/FSPL/obstruction code exists anywhere. All math is new.

---

## 2. File-by-file changes

### NEW pure utils (react-free, unit-tested)

#### 2.1 `src/utils/linkBudget.ts` — scalar radio math
```ts
export const SPEED_OF_LIGHT_MPS = 299_792_458;
export const EARTH_RADIUS_M = 6_371_000;
export const DEFAULT_K_FACTOR = 4 / 3;

/** Wavelength in metres for a frequency in MHz. */
export function wavelengthMeters(freqMhz: number): number;

/**
 * nth Fresnel-zone radius (metres) at a point d1/d2 metres from each endpoint.
 * r = sqrt(n · λ · d1 · d2 / (d1 + d2)). Returns 0 when d1 or d2 is 0 (endpoints).
 */
export function fresnelRadiusMeters(n: number, freqMhz: number, d1M: number, d2M: number): number;

/** Free-space path loss (dB): 20log10(d_km) + 20log10(f_MHz) + 32.44. */
export function fsplDb(distanceKm: number, freqMhz: number): number;

/** Earth-curvature bulge (metres): d1·d2 / (2·k·R). k default 4/3. */
export function earthBulgeMeters(d1M: number, d2M: number, kFactor?: number, earthRadiusM?: number): number;

export interface LinkBudgetInputs {
  txPowerDbm: number;
  txGainDbi: number;
  rxGainDbi: number;
  cableLossDb: number;      // total, both ends
  rxSensitivityDbm: number; // negative
}
export interface LinkBudgetResult {
  fsplDb: number;
  rxPowerDbm: number;       // txPower + txGain + rxGain − cableLoss − FSPL
  marginDb: number;         // rxPower − rxSensitivity  (rxSensitivity is negative)
}
/** Combine FSPL (from distance+freq) with the budget inputs. Sign conventions above. */
export function computeLinkBudget(distanceKm: number, freqMhz: number, inputs: LinkBudgetInputs): LinkBudgetResult;
```
**Sign conventions (documented in JSDoc):** gains/power add, cable loss and FSPL subtract, `marginDb = rxPowerDbm − rxSensitivityDbm`. Because `rxSensitivityDbm` is negative, subtracting it increases margin (equivalent to `…− FSPL − rxSensitivity` when the latter is written with its sign). Positive margin ⇒ link closes.

#### 2.2 `src/utils/linkProfile.ts` — obstruction analysis (chart-ready)
```ts
import type { LatLng } from './greatCircle';
import type { MeasurePoint } from './measureDistance';
import { fresnelRadiusMeters, earthBulgeMeters, fsplDb, computeLinkBudget, type LinkBudgetInputs, type LinkBudgetResult, DEFAULT_K_FACTOR, EARTH_RADIUS_M } from './linkBudget';

/** A picked endpoint. `isNode=false` ⇒ arbitrary map point. */
export interface LinkEndpoint extends MeasurePoint { isNode: boolean; }

/** One elevation sample from the backend profile (client mirror of server ProfileSample). */
export interface ElevationSample { distance: number; lat: number; lng: number; elevation: number | null; }

export type LinkVerdict = 'clear' | 'marginal' | 'obstructed';

export interface LinkProfileOptions {
  freqMhz: number;
  antennaHeightAglAM: number;   // AGL metres at endpoint A
  antennaHeightAglBM: number;   // AGL metres at endpoint B
  kFactor?: number;             // default 4/3
  earthRadiusM?: number;        // default 6_371_000
  fresnelClearThreshold?: number; // default 0.6 (60% of first Fresnel)
}

/** Per-sample plot row (all elevations in metres, distance in km for the X axis). */
export interface LinkProfilePoint {
  distanceKm: number;
  terrain: number | null;          // raw DEM elevation
  effectiveTerrain: number | null; // terrain + curvature bulge (what LOS is judged against)
  los: number;                     // straight line between antenna tops
  fresnelLower: number;            // los − first-Fresnel radius
  obstructed: boolean;             // effectiveTerrain > los at this sample
}

export interface LinkProfileAnalysis {
  points: LinkProfilePoint[];
  totalDistanceKm: number;
  verdict: LinkVerdict;
  /** Tightest interior sample (min clearance ratio). null if no usable interior samples. */
  worst: { distanceKm: number; clearanceM: number; clearanceRatio: number } | null;
  /** min(clearance / fresnelRadius) across interior samples, as a percent (may be negative). */
  fresnelClearancePct: number;
  antennaTopAM: number; // ground(A) + AGL
  antennaTopBM: number;
}

/**
 * Pure geometry/obstruction analysis. Antenna tops = terrain at each endpoint + AGL
 * (node GPS altitude intentionally ignored — see spec §0.1). Curvature raises terrain
 * toward the straight LOS chord (effectiveTerrain = terrain + bulge). Endpoints and
 * null-elevation samples are excluded from worst-case classification.
 *
 * Classification (first match wins):
 *   obstructed  — some interior effectiveTerrain > los  (clearance < 0)
 *   marginal    — LOS clear but min(clearance/fresnelR) < threshold (default 0.6)
 *   clear       — min(clearance/fresnelR) ≥ threshold
 */
export function analyzeLinkProfile(samples: ElevationSample[], opts: LinkProfileOptions): LinkProfileAnalysis;
```
**Math details for the implementer** (all lengths in metres unless noted):
- `total = samples[last].distance`; `d1 = samples[i].distance`, `d2 = total − d1`.
- `groundA = samples[0].elevation ?? 0`, `groundB = samples[last].elevation ?? 0`; `antennaTopA/B = ground + AGL`.
- `los[i] = antennaTopA + (antennaTopB − antennaTopA) · (d1/total)`.
- `bulge[i] = earthBulgeMeters(d1, d2, k)` (0 at endpoints).
- `effectiveTerrain[i] = terrain[i] + bulge[i]` (null when `terrain[i]` null).
- `fresnelR[i] = fresnelRadiusMeters(1, freq, d1, d2)`; `fresnelLower[i] = los[i] − fresnelR[i]`.
- `clearance[i] = los[i] − effectiveTerrain[i]`; `ratio[i] = fresnelR[i] > 0 ? clearance/fresnelR : +Infinity`.
- Worst = interior, non-null sample minimising `ratio`. `fresnelClearancePct = min ratio · 100`.
- Guard divide-by-zero at endpoints (fresnelR=0) and the whole-null profile (worst=null, verdict `'clear'`, but the drawer surfaces a "no terrain data" note).

### NEW types + API client

#### 2.3 `src/types/elevation.ts` — client mirror of the backend envelope payload
```ts
export interface ElevationSample { distance: number; lat: number; lng: number; elevation: number | null; }
export interface ElevationProfile { distanceMeters: number; provider: string; samples: ElevationSample[]; }
```
(Keep `ElevationSample` defined once — `linkProfile.ts` imports it from here rather than redefining. Adjust §2.2 import accordingly.)

#### 2.4 `src/services/api.ts` — add method (EDIT)
```ts
/**
 * Terrain elevation profile between two coords (#4111). POST is CSRF-guarded;
 * ApiService.post attaches the token. Unwraps the { success, data } envelope —
 * request() returns the raw body, so read .data here (matches the MQTT-monitor
 * unwrap gotcha in CLAUDE.md).
 */
async getElevationProfile(
  pointA: { lat: number; lng: number },
  pointB: { lat: number; lng: number },
  samples?: number,
): Promise<ElevationProfile> {
  const res = await this.post<{ success: boolean; data: ElevationProfile }>(
    '/api/elevation/profile',
    samples != null ? { pointA, pointB, samples } : { pointA, pointB },
  );
  return res.data;
}
```
Import `ElevationProfile` from `../types/elevation`. On `ApiError` with `code === 'ELEVATION_DISABLED'` the caller (hook) treats it as "feature off"; other errors surface a generic message.

### NEW hooks

#### 2.5 `src/hooks/useElevationEnabled.ts`
```ts
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';
/** True unless the server explicitly set elevationEnabled='false'. Anonymous-readable. */
export function useElevationEnabled(): boolean {
  const { data } = useQuery({
    queryKey: ['settings', 'elevationEnabled'],
    queryFn: () => apiService.get<{ elevationEnabled?: string }>('/api/settings'),
    staleTime: 5 * 60_000,
  });
  return data?.elevationEnabled !== 'false';
}
```
(Confirm the singleton export name/shape of `ApiService` in `src/services/api.ts` and match it; if it exports a class instance under a different identifier, use that.)

#### 2.6 `src/hooks/useElevationProfile.ts`
```ts
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';
import type { LinkEndpoint } from '../utils/linkProfile';
import type { ElevationProfile } from '../types/elevation';

/**
 * Fetch the elevation profile for a full endpoint pair. Keyed on rounded coords
 * so budget-input edits never refetch (geometry-only). Disabled until both set.
 * samples defaults to backend DEFAULT_SAMPLES (256) — omit from the body.
 */
export function useElevationProfile(a: LinkEndpoint | undefined, b: LinkEndpoint | undefined) {
  const enabled = !!a && !!b;
  return useQuery<ElevationProfile>({
    queryKey: ['elevation-profile',
      a ? [round(a.lat), round(a.lng)] : null,
      b ? [round(b.lat), round(b.lng)] : null],
    queryFn: () => apiService.getElevationProfile(
      { lat: a!.lat, lng: a!.lng }, { lat: b!.lat, lng: b!.lng }),
    enabled,
    staleTime: 30 * 60_000, // terrain is static
  });
}
// round to ~6 dp so identical picks share cache
```

### NEW components

#### 2.7 `src/components/MapAnalysis/LinkProfileController.tsx` (prop-driven, like MeasureDistanceController)
```ts
export interface LinkProfileControllerProps {
  active: boolean;
  /** Candidate node endpoints (from useAnalysisNodes → LinkEndpoint w/ isNode:true). */
  points: LinkEndpoint[];
  endpoints: LinkEndpoint[];               // 0..2, from context
  onPick: (next: LinkEndpoint[]) => void;  // controller pushes the new endpoint array
  onExit?: () => void;
}
```
Behaviour (clone MeasureDistanceController):
- Capture-phase `click` on `map.getContainer()`, guard `.leaflet-control`, `stopPropagation`/`preventDefault`, `map.mouseEventToLatLng(e)`.
- **Snap decision:** nearest node = `nearestPoint(points, lat, lng)`; if it exists and its screen distance `map.latLngToContainerPoint(nearest) → e.clientX/Y` is `< SNAP_PX` (24), use it as `{ ...nearest, isNode:true }`; else `{ id:'pt-<lat>,<lng>', lat, lng, isNode:false }`.
- Pick sequence identical: 0 → [A]; 1 → [A,B] (ignore re-pick of same node id as A); 2 → restart from [new A]. Emit via `onPick`.
- Render `CircleMarker` for each endpoint (node = filled, arbitrary = hollow), a **solid** `Polyline` between A and B in a distinct colour (amber `#f59e0b`) with a permanent `Tooltip` showing straight-line distance (`measureLabel` reuse) so it's visually different from the Measure tool's dashed cyan line.
- Escape → `onPick([])` + `onExit?.()`. `enabled = active && points.length >= 0` (arbitrary points allowed even with 0 nodes, but the toolbar still gates on ≥2 positioned nodes for parity — see §2.10).
- Tiny CSS: `src/components/MapAnalysis/LinkProfileController.css` (clone `.measure-distance-label` → `.link-profile-label`, amber border).

#### 2.8 `src/components/MapAnalysis/LinkProfileDrawer.tsx` — bottom drawer
- Reads `linkEndpoints` from `useMapAnalysisCtx()`. Returns `null` when `linkProfileMode` is off **and** no endpoints.
- `const { data: profile, isLoading, error } = useElevationProfile(a, b)`.
- **Local budget-input state** (`useState`) seeded from documented defaults (§0.7): `freqMhz`, `aglA`, `aglB`, `txPowerDbm`, `txGainDbi`, `rxGainDbi`, `cableLossDb`, `rxSensitivityDbm`, `kFactor`.
- `const analysis = useMemo(() => profile ? analyzeLinkProfile(profile.samples, { freqMhz, antennaHeightAglAM:aglA, antennaHeightAglBM:aglB, kFactor }) : null, [profile, freqMhz, aglA, aglB, kFactor])` — recompute on input change, **no refetch**.
- `const budget = useMemo(() => analysis ? computeLinkBudget(analysis.totalDistanceKm, freqMhz, { txPowerDbm, txGainDbi, rxGainDbi, cableLossDb, rxSensitivityDbm }) : null, [...])`.
- **Layout:** flex row — left = `<ResponsiveContainer>` chart; right = stats readout + collapsible budget-input form.
- **Chart (`ComposedChart`, mirror TelemetryChart):**
  - data = `analysis.points`; `XAxis dataKey="distanceKm" type="number"` (km); `YAxis` metres.
  - `<Area dataKey="effectiveTerrain">` filled (brown `#8d6e63`), `connectNulls={false}` so DEM voids show as gaps.
  - `<Line dataKey="los">` (green `#22c55e`, dashed when `verdict==='obstructed'`).
  - `<Line dataKey="fresnelLower">` (orange `#f59e0b`), the 1st-Fresnel lower bound.
  - Obstruction highlight: `<ReferenceDot>` at `analysis.worst` (red when obstructed/marginal) + optional `<ReferenceLine x={worst.distanceKm}>`. (`ReferenceDot`/`ReferenceLine` from `recharts`.)
  - `Tooltip` formats terrain/LOS/Fresnel at the hovered distance.
- **Stats readout:** distance (km/mi via `useSettings().distanceUnit`), frequency, FSPL (dB), RX power (dBm), margin (dB, colour-coded ≥0 green / <0 red), Fresnel clearance %, and a **verdict pill**: `Clear` / `Marginal` / `Obstructed` (green/amber/red) — combined line e.g. `Clear · +31.2 dB margin`. When `profile` all-null: "No terrain data for this path".
- **Budget-input form:** number inputs for every field above, each `onChange` updating local state (recompute only). Frequency default 915. Loading → skeleton/spinner; `error` (non-`ELEVATION_DISABLED`) → inline message.
- **Close/clear:** an ✕ button calls `setLinkProfileMode(false)` + `setLinkEndpoints([])`. Re-picking a new pair while open updates in place.
- Uses `ApiService` via the hook — **no raw `fetch`** in the component (ESLint ratchet).

### EDIT — context / canvas / toolbar

#### 2.9 `src/components/MapAnalysis/MapAnalysisContext.tsx` (EDIT)
Add to `CtxShape` + provider (transient, not persisted — mirror `measureMode`):
```ts
/** Link Profile tool active (#4111 Phase 2); transient. Mutually exclusive with measureMode. */
linkProfileMode: boolean;
setLinkProfileMode: (m: boolean) => void;
/** Picked endpoints (0..2) for the Link Profile tool; transient. */
linkEndpoints: LinkEndpoint[];
setLinkEndpoints: (e: LinkEndpoint[]) => void;
```
`import type { LinkEndpoint } from '../../utils/linkProfile';` + two `useState`s.

#### 2.10 `src/components/MapAnalysis/MapAnalysisToolbar.tsx` (EDIT)
- `const elevationEnabled = useElevationEnabled();`
- Pull `linkProfileMode, setLinkProfileMode, measureMode, setMeasureMode` from ctx.
- Add a "Link Profile" button beside "Measure":
  - **Hidden** when `!elevationEnabled` (`{elevationEnabled && (<button .../>) }`).
  - `disabled={analysisNodes.length < 2}` with the same title-hint pattern as Measure.
  - `className={... linkProfileMode ? 'active' : ''}`.
  - onClick toggles `linkProfileMode`; when turning it **on**, also `setMeasureMode(false)` (mutually exclusive). Symmetrically, the Measure onClick sets `setLinkProfileMode(false)`.

#### 2.11 `src/components/MapAnalysis/MapAnalysisCanvas.tsx` (EDIT)
- Build `linkEndpointCandidates: LinkEndpoint[]` from the same `analysisNodes` memo (add `isNode:true`); reuse or extend the existing `measurePoints` memo.
- Inside `<BaseMap>`, after the measure controller:
```tsx
{linkProfileMode && (
  <LinkProfileController
    active={linkProfileMode}
    points={linkEndpointCandidates}
    endpoints={linkEndpoints}
    onPick={setLinkEndpoints}
    onExit={() => setLinkProfileMode(false)}
  />
)}
```
- After `</BaseMap>` (sibling of `TimeSliderControl`/`MapLegend`, inside `.map-analysis-canvas`):
```tsx
<LinkProfileDrawer />
```
- Pull `linkProfileMode, setLinkProfileMode, linkEndpoints, setLinkEndpoints` from ctx.

#### 2.12 `src/styles/map-analysis.css` (EDIT — append)
- `.map-analysis-link-drawer`: `position:absolute; left:0; right:0; bottom:0; height:min(42vh,340px); z-index:1000;` (above leaflet panes, matching how the legend/time-slider float; verify it clears the attribution control) `background:#0f172a; border-top:1px solid #334155; display:flex; overflow:hidden;`. Chart pane `flex:1; min-width:0;`; stats/inputs pane fixed width (`~300px`) with `overflow-y:auto`.
- Verdict pill classes `.link-verdict-clear|marginal|obstructed` (green/amber/red). Number-input grid for the budget form. Follow this page's dark palette; **do not** put mobile overrides in an earlier `@media` block (the nodes.css cascade-order gotcha does not apply to map-analysis.css, but keep base rules before any media query for safety).

---

## 3. Test plan

All Vitest; jsdom for component tests. No standalone scripts.

#### 3.1 `src/utils/linkBudget.test.ts`
- `wavelengthMeters(915)` ≈ 0.32764 (±1e-4).
- `fsplDb(33.3, 915)` ≈ 122.117 (±0.01); `fsplDb(1, 100)` ≈ 72.440; `fsplDb(10, 915)` ≈ 111.668.
- `fresnelRadiusMeters(1, 915, 5000, 5000)` ≈ 28.620; `(1,915,3000,7000)` ≈ 26.231; endpoint `(1,915,0,10000)` === 0.
- `earthBulgeMeters(16650,16650)` ≈ 16.317 (k=4/3 default); with `k=1` ≈ 21.757; endpoint (d2=0) === 0.
- `computeLinkBudget(33.3, 915, {txPowerDbm:20,txGainDbi:2.15,rxGainDbi:2.15,cableLossDb:0,rxSensitivityDbm:-129})` → `rxPowerDbm` ≈ −97.817, `marginDb` ≈ +31.183, `fsplDb` ≈ 122.117.
- Sign checks: raising cable loss lowers margin; raising RX sensitivity toward 0 lowers margin.

#### 3.2 `src/utils/linkProfile.test.ts`
- **Clear:** flat terrain well below LOS, tall masts → `verdict:'clear'`, `fresnelClearancePct ≥ 60`, `worst` set to the tightest interior sample.
- **Marginal:** terrain that stays below LOS everywhere but pokes into the Fresnel zone at one sample → `verdict:'marginal'` (clearance ≥ 0 but ratio < 0.6).
- **Obstructed:** a mid-path hill above LOS → `verdict:'obstructed'`, `worst.clearanceM < 0`.
- **AGL applied at endpoints:** raising `antennaHeightAglAM/BM` lifts `los` and flips an obstructed case to clear.
- **Curvature applied:** with a long path, non-zero `earthBulgeMeters` raises `effectiveTerrain` vs raw terrain; asserting a mid-path point's `effectiveTerrain > terrain` and that a larger k lowers the bulge.
- **Null handling:** samples with `elevation:null` are excluded from `worst`/verdict; all-null → `worst:null`, no throw.
- `points` length === input length; `distanceKm` monotonic; `totalDistanceKm` matches last sample.

#### 3.3 `src/components/MapAnalysis/LinkProfileController.test.tsx` (clone MeasureDistanceController.test.tsx)
- Mock `react-leaflet` (`useMap` with `getContainer`/`mouseEventToLatLng`/`latLngToContainerPoint`), `CircleMarker`/`Polyline`/`Tooltip` as test doubles.
- Inactive / <픽 renders nothing.
- Click near a node (within SNAP_PX) → endpoint `isNode:true` with that node's coords; click far from any node → `isNode:false` raw point.
- A→B sequence emits `[A]` then `[A,B]`; third click restarts to `[newA]`; re-pick same node as A is ignored.
- Escape emits `onPick([])` + `onExit`.

#### 3.4 `src/components/MapAnalysis/LinkProfileDrawer.test.tsx`
- `vi.mock('../../hooks/useElevationProfile', ...)` returning a canned `ElevationProfile` (obstructed fixture) + `useSettings` for `distanceUnit`; mock `recharts` primitives to simple divs (as Telemetry/Measure tests do) so assertions target stats, not SVG.
- Renders verdict pill text (`Obstructed`), FSPL, RX power, margin (sign-coloured), distance in the user's unit.
- Changing a budget input (e.g. RX sensitivity) updates margin **without** a new `useElevationProfile` call (assert the mocked query fn call count is unchanged).
- `isLoading` → spinner; all-null profile → "No terrain data" copy.

#### 3.5 `src/hooks/useElevationEnabled.test.tsx` (light)
- With a mocked `ApiService.get` returning `{elevationEnabled:'false'}` → hook false; `{}`/`{elevationEnabled:'true'}`/undefined → true. Wrap in a `QueryClientProvider`.

#### 3.6 Toolbar gate (extend existing MapAnalysisToolbar test or add one)
- `elevationEnabled=false` → no "Link Profile" button. `true` + `<2` nodes → button present but `disabled`. `true` + ≥2 → enabled; clicking sets `linkProfileMode` and clears `measureMode`.

**Final gate:** full `npx vitest run` (not targeted) + `npm run lint:ci` exit 0 before PR (CLAUDE.md). No new `any`, no raw `fetch()` in `src/components/**`/`src/pages/**`, respect `react-hooks/exhaustive-deps` (no auto-fix suppressions — write correct dep arrays).

---

## 4. Work packages

Dependency graph: **WP-A** and **WP-C** are parallel (no shared files); **WP-B** depends on WP-A (needs the math API); **WP-D** integrates everything and depends on A+B+C.

### WP-A — Pure math + types + API client *(no deps; start immediately)*
**Files:** `src/utils/linkBudget.ts`, `src/utils/linkProfile.ts`, `src/types/elevation.ts`, edit `src/services/api.ts` (add `getElevationProfile`), `src/hooks/useElevationProfile.ts`, `src/hooks/useElevationEnabled.ts`; tests `linkBudget.test.ts`, `linkProfile.test.ts`, `useElevationEnabled.test.tsx`.
**Acceptance:** every §3.1/§3.2/§3.5 case passes against the verified reference values; `getElevationProfile` unwraps `.data`; hooks typed with no `any`; `npm run lint:ci` clean for touched files. Pure utils import nothing from React/leaflet.

### WP-B — Drawer + chart + budget panel *(depends WP-A)*
**Files:** `src/components/MapAnalysis/LinkProfileDrawer.tsx`, drawer styles appended to `src/styles/map-analysis.css`; test `LinkProfileDrawer.test.tsx`.
**Acceptance:** renders a ComposedChart (terrain Area + LOS Line + Fresnel Line + worst-point marker) and a full stats readout + budget form from a mocked profile; budget edits recompute via `useMemo` with **zero** extra elevation fetches (§3.4); verdict/margin colour logic correct; no raw `fetch`; drawer overlays without breaking the map (manual note for WP-D browser check).

### WP-C — Controller + context slice + toolbar button *(parallel with WP-A/WP-B; controller math-independent)*
**Files:** `src/components/MapAnalysis/LinkProfileController.tsx` + `LinkProfileController.css`, edit `MapAnalysisContext.tsx` (context slice), edit `MapAnalysisToolbar.tsx` (button + gate); test `LinkProfileController.test.tsx` (+ toolbar gate §3.6).
**Note:** WP-C imports the `LinkEndpoint` type from `src/utils/linkProfile.ts` (WP-A). If truly parallel, WP-A should land the type first, or WP-C defines `LinkEndpoint` in a tiny `src/utils/linkProfileTypes.ts` merged by WP-A. Prefer: WP-A publishes the type early.
**Acceptance:** §3.3 + §3.6 pass; snap-vs-raw threshold works; mutual exclusion with Measure; button hidden when `elevationEnabled===false`, disabled with <2 nodes.

### WP-D — Canvas integration + browser validation *(sequential; depends A+B+C)*
**Files:** edit `MapAnalysisCanvas.tsx` (wire controller inside `<BaseMap>`, drawer sibling, build `LinkEndpoint` candidates from `useAnalysisNodes`).
**Acceptance:** end-to-end in the dev container — toggle Link Profile, pick two nodes → drawer opens, fetches once, shows terrain + LOS + Fresnel + verdict + margin; pick an arbitrary map point as one endpoint; edit frequency/heights and watch the analysis recompute with no network call; compare a reference link (e.g. the issue's ~33.3 km @ 915 MHz) against site.meshtastic.org and confirm FSPL/verdict agree; Escape and ✕ both clear; map remains pannable above the drawer. **Final gate:** full Vitest suite + `npm run lint:ci` green, then PR.

---

## 5. Invariants honoured / non-goals

- **No backend changes** — Phase‑1 route/envelope consumed as-is; CSRF handled by existing `ApiService.post` token flow.
- **No raw `fetch()`** in components/pages — all IO via `ApiService` + TanStack hooks.
- **No `any`; TS strict; exhaustive-deps** honoured with correct arrays (no suppressions).
- **Transient state only** — `linkProfileMode`/`linkEndpoints` are not persisted, mirroring `measureMode`; no settings writes, no migration.
- **Node GPS altitude intentionally unused** (§0.1) — documented so a reviewer doesn't flag the missing consumption of `device.altitude`.
- **Per-source N/A** — elevation/link-profile is source-agnostic geometry (same rationale as the Phase‑1 elevation exception); no `sourceId`.
- **Phase 3 (out of scope):** per-source frequency auto-detection, RX-sensitivity preset dropdown, map path colouring by obstruction, missing-DEM/antimeridian edge polish, elevation-source settings UI.
