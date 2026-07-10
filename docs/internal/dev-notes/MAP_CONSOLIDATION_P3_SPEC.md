# Map Consolidation — Phase 3 Spec: Traceroute Rendering Unification

**Epic:** #4047 · **Phase:** 3 · **Branch:** `feature/4047-p3-traceroute-unify` (from `origin/4049-map-refactor`)
**Status:** Spec — no feature code written yet.
**Scope:** app maps only (NodesTab, DashboardMap, TracerouteWidget, MapAnalysis). EmbedMap is Phase 6.

## 0. TL;DR for implementers

Today there are **5 traceroute renderers, 3 SNR color scales, 4 dash conventions, 3 weight
formulas**, and the #1862/#2051/#2931 behaviors are re-implemented per renderer. Phase 3:

1. **One canonical SNR→color scale** — 4-band (`≥5 / ≥0 / ≥-5 / <-5` = green/yellow/orange/red)
   + `noData`, **theme-aware** (hex moves into `overlayColors.snrColors`, expanded 3→4 bands).
2. **One shared render layer** `src/components/map/layers/TraceroutePathsLayer.tsx` owning geometry,
   curvature, arrows, forward/return legs, MQTT/unknown-SNR dashing — parameterized for weight
   strategy, arrows, color mode, hover-highlight. Consumed by all four app maps.
3. **One shared decomposition util** `src/utils/tracerouteSegments.ts` that is the SINGLE home for
   #1862 (snapshot positions), #2051 (empty-routeBack guard), #2931 (unknown-SNR sentinel), with tests.
4. Consumer-specific **data** logic (dedup, usage/occurrence counting, weak-link filtering, direction
   classification, zoom-adaptive filtering) STAYS in each consumer's hook — only rendering unifies.

Approved appearance changes: NodesTab base layer 3-band → 4-band; DashboardMap gains return legs
(and MQTT dashing on its paths pass — C2); TracerouteWidget leg colors converge to the theme
`tracerouteForward`/`tracerouteReturn` palette (C1).

## 0.1 Orchestrator decisions — RESOLVED (gate review 2026-07-10)

| # | Question | Resolution |
|---|---|---|
| D1 | Rename `snrColors` fields `{good,medium,poor,noData}` → `{excellent,good,fair,poor,noData}` (semantic shift + 4th band)? | **YES** — rename, lockstep across all readers (§7 lockstep note). |
| D2 | Canonical dash = `'3,6'` applied **iff MQTT/all-unknown-SNR**. NodesTab selected route currently dashes `'3,6'` **always**; Widget `'5,10'` on unknown; MapAnalysis `'4,6'` on MQTT. Converge all to `'3,6'` on MQTT/unknown, dropping NodesTab's always-dash? | **YES** — converge to `'mqtt-unknown'`; keep `'always'` as an escape-hatch prop value. |
| D3 | Light-theme 4-band hexes need a WCAG-AA-on-cream check (Phase 1/2 established this bar). | **YES — binding on WP1:** the implementer must run the WCAG AA (≥4.0 on cream ~#F2EFE9) check on the light hexes and adjust any that fail. §2.1 table is a starting point, not final. |
| D4 | NodesTab node-popup SNR swatch (`NodesTab.tsx:2584`) is **node** SNR (not segment) but reads `overlayColors.snrColors` with an inline 3-band. Adopt canonical `snrToColor` there too? | **YES**. |
| D5 | DashboardMap gains return-leg rendering. | **YES** — epic-approved; the `/4` SNR-scaling note is **binding on WP4**. |

**Gate-review convergence corrections (orchestrator-directed, 2026-07-10):**
- **C1 — Widget leg colors converge to theme.** The Widget's hardcoded `#4CAF50`/`#2196F3` legs vs
  NodesTab-selected's theme `tracerouteForward`/`tracerouteReturn` are two fixed-leg palettes for the
  identical concept — drift, not a deliberate parameter. The Widget now passes
  `legColors={{ forward: overlayColors.tracerouteForward, return: overlayColors.tracerouteReturn }}`
  sourced from **`useSettings().overlayColors`** (the Widget does not receive App.tsx's
  `mergedThemeColors`; `useSettings()` is the same underlying palette). **Approved visible change.**
  Note: in both current palettes `tracerouteForward === tracerouteReturn` (pink; "direction shown by
  arrows") — the widget's legs become same-colored, with direction conveyed by arrows and the existing
  hover-highlight; its legend swatches should read the same theme tokens so they stay truthful.
- **C2 — Dashboard paths pass uses the canonical dash.** Because Dashboard's segment build moves to
  `decomposeTraceroute` (§4), per-hop sentinel data IS available — the paths pass uses the default
  `dashMode: 'mqtt-unknown'` so MQTT segments dash there like everywhere else. Only the fixed-yellow
  overlay pass stays `'never'` (it is a highlight, not a data encoding).

---

## 1. Reuse inventory (serena-verified 2026-07-10)

All epic-survey premises **verified accurate**. Line numbers are current on this branch.

### 1.1 Shared primitives — `src/utils/mapHelpers.tsx`
| Symbol | Line | Behavior (current) |
|---|---|---|
| `UNKNOWN_SNR_SENTINEL` | 16 | `-32` (firmware INT8_MIN/4). #2931. |
| `isUnknownSnr(snr)` | 19 | `snr === -32`. |
| `generateCurvedPath(start,end,curvature=0.15,segments=20,normalizeDirection=false)` | 105 | quadratic bézier; perpendicular offset `curvature*length`; `normalizeDirection` flips sign so A→B and B→A bow opposite ways. |
| `getSegmentSnrColor(snrData, snrColors, defaultColor)` | 164 | **3-band**: avg non-sentinel SNR; `>0→good`, `>=-10→medium`, else `poor`; empty→defaultColor. **Only caller: useTraceroutePaths:573.** |
| `getSegmentSnrOpacity(snrData, isMqtt)` | 182 | MQTT/empty→`0.5`; else avg clamped [-20,15] → `0.4+((n+20)/35)*0.45`. |
| `getLineWeight(snr)` | 199 | `undefined→3`; clamp [-20,10] → `2+((n+20)/30)*4` (2..6). |
| `generateCurvedArrowMarkers(positions,pathKey,color,snrs,curvature,normalizeDirection=true)` | 223 | one arrow at curve midpoint/segment; tooltip `?`/`${snr} dB`. |
| `getTemporalOpacityMultiplier(timestamp)` | 268 | `<1h→1.0`, `>24h→0.2`, sqrt decay; none→0.5. |
| `generateArrowMarkers` (legacy straight) | 38 | **no live consumers** (App.tsx:68 comment only). |

**Consumer blast radius** (imports):
- `getSegmentSnrColor` → **useTraceroutePaths only**.
- `getSegmentSnrOpacity` → useTraceroutePaths:575, MapAnalysis layer:129.
- `getLineWeight` → useTraceroutePaths:812,917; TracerouteWidget:513,547.
- `generateCurvedPath` → useTraceroutePaths, TracerouteWidget, MapAnalysis layer.
- `generateCurvedArrowMarkers` → same three.
- `isUnknownSnr`/`UNKNOWN_SNR_SENTINEL` → useTraceroutePaths, MapAnalysis layer; **useTracerouteAnalysis.ts:5-9 re-declares its own private copy** (duplication to fix under #2931-once).
- `.snrColors` reads: mapHelpers:166 (param type), useTraceroutePaths (`ThemeColors.snrColors`), **NodesTab:2584** (inline node-SNR swatch, 3-band), App.tsx:444 (merge). The shared `MapLegend.tsx` has **no** SNR section (0 matches).

### 1.2 Theme mechanism (concrete design target for "theme-aware")
Two layered systems:

**(a) Overlay palette — `src/config/overlayColors.ts`** — THE home for the canonical SNR tokens.
Plain TS module. `interface OverlayColors` (L3-28) includes `snrColors: {good,medium,poor,noData}`
(L16-21) with `darkOverlayColors` (Catppuccin Mocha, L43-48) and `lightOverlayColors` (darkened Latte,
WCAG-AA-on-cream, L74-79). `getOverlayColors(scheme)` → chosen by `getSchemeForTileset(tilesetId)`.
Consumed via **`useSettings().overlayColors`** (`SettingsContext.tsx:10,85,475,1543`), which memoizes
`getOverlayColors(overlayScheme)`.

**(b) CSS custom properties `--ctp-*`** (Catppuccin) — Leaflet Polylines can't read CSS vars, so
`App.tsx:412-445` resolves `--ctp-mauve/red/blue/overlay0` at runtime via `getComputedStyle` and
`useMemo`s `mergedThemeColors = {...cssVarHexes, tracerouteForward, tracerouteReturn, mqttSegment,
neighborLine, snrColors}` (merging `overlayColors` on top), passed as `themeColors` to useTraceroutePaths.

**Design consequence:** the canonical SNR scale lives in `overlayColors.snrColors` (expanded to 4 bands),
read through `useSettings().overlayColors` by all four consumers. NodesTab already threads it via
`mergedThemeColors`; the other three read `useSettings()` directly. No CSS-var work needed for SNR.

### 1.3 `src/components/map/` (Phase 1/2 output)
`BaseMap.tsx` + `BaseMap.test.tsx` + `leafletDefaultIcon.ts`. **No `layers/` subdir yet** — Phase 3
creates `src/components/map/layers/`. BaseMap conventions: named export, typed props interface, no
`any`, returns a fragment, persistence-agnostic (never calls `useSettings()` itself — caller owns
state). The new layer follows the same conventions but, being an overlay, MAY read `useSettings()`
for the palette (consumers already do) OR take `snrColors` as a prop — spec chooses **prop** (see §3)
to keep it pure/testable, matching BaseMap's "no useSettings" ethos.

### 1.4 The five renderers (current behavior — what each maps onto the shared layer)

**useTraceroutePaths.tsx (1076 LOC) — NodesTab, TWO layers.** Returns **plain data** (arrays of ready
React elements), not a component:
```ts
interface UseTraceroutePathsResult {
  traceroutePathsElements: React.ReactElement[] | null;  // base "all paths"
  selectedNodeTraceroute: React.ReactElement[] | null;   // selected route
  tracerouteNodeNums: Set<number> | null;                // marker filter
  tracerouteBounds: [[number,number],[number,number]] | null;
}
```
Wired App.tsx:4607-4620 (`themeColors=mergedThemeColors`, `mapZoom`, `visibleNodeNums`, …); NodesTab
splats the arrays through `React.memo` pass-throughs (`<>{paths}</>`).
- **Base layer** (useMemo L293-714): age cutoff → **dedup most-recent per bidirectional pair** → aggregate
  per-segment usage count + SNR samples(+ts) + MQTT(per-hop sentinel, NOT node.viaMqtt) + latest ts.
  **STRAIGHT, no arrows.** `visibleNodeNums` both-endpoints filter (L464). **Zoom-adaptive filter**
  (`mapZoom<8` drops no-SNR/MQTT/avg<-10, L472). Weight `min(2+usage,8)` (usage-based). Color: MQTT→
  `mqttSegment`, else `getSegmentSnrColor` (3-band). Opacity `max(0.15, getSegmentSnrOpacity*temporal)`.
  Dash `'3,6'` iff MQTT. Rich `<Popup>` with SNR stats + **recharts `SegmentSnrChart`** (≥3 samples).
- **Selected layer** (useMemo L718-981): single trace, snapshot positions (#1862), empty-route guard.
  Forward `generateCurvedPath(...,0.2,20,true)`, weight `getLineWeight(snr)`, color `tracerouteForward`,
  opacity **0.9**, dash **`'3,6'` always**, arrows. Return leg curvature **-0.2**, color `tracerouteReturn`.
  `tracerouteBounds` from snapshot positions + 10% pad.

**TracerouteWidget.tsx (641 LOC)** — `mapData` useMemo L214-317: snapshot positions (#1862 L217);
**#2051 empty-routeBack guard L233-248** (`hasReturnPath = backHops>0 || hasSnrBack`). Curved ±0.2,
arrows, **fixed leg colors `#4CAF50`/`#2196F3`**, weight `getLineWeight`. Dash `'5,10'` iff `snr===undefined`.
**Hover highlight/dim** (legend `onMouseEnter/Leave` → `highlightedPath: 'forward'|'back'|null`,
opacity 0.9/0.2; arrows only for highlighted leg).

**DashboardMap.tsx (977 LOC)** — local `snrToColor` **4-band** L86-92 (`>=5 #22c55e / >=0 #eab308 /
>=-5 #f97316 / else #ef4444`); local `parseRoutePositions` L117 (snapshot #1862). `tracerouteSegments`
L518: age cutoff; **forward leg ONLY, no routeBack** (gains it in P3); STRAIGHT; `snr=snrTowards[i]`
**un-scaled (no /4)** default 0. **Two stacked passes**: `showPaths` (weight 2, opacity 0.85, per-seg
color) + `showRoute` (fixed **yellow `#facc15`, weight 4, opacity 0.6** overlay). No dash/fade/arrows/hover.

**MapAnalysis — two halves:**
- **DATA (PRESERVE) `useTracerouteAnalysis.ts` (379 LOC):** pure `analyzeTraceroutes` → `AnalyzedSegment[]`
  `{key,sourceId,from,to,fromPos,toPos,direction,neighborNum,avgSnr(number|null),occurrences,isMqtt}`.
  Forward `snrTowards[i]/4`; **#2051 back guard L155** (`routeBack.length>0 || snrBack.length>0`); time/
  source/membership filters; occurrence + non-sentinel SNR aggregation; **weak-link filters**
  `occurrences<minOccurrences`, `avgSnr<minSnr`; direction only when focused; `isMqtt=hasUnknown&&snrCount===0`.
  **Own sentinel copy L5-9 (fold into mapHelpers under #2931).** Positions **live only, no snapshot**.
- **RENDER (REPLACE) `MapAnalysis/layers/TraceroutePathsLayer.tsx` (170 LOC):** `showArrows =
  selectedNodeNum!==null`. Hardcoded `OUTBOUND='#3b82f6'`, `INBOUND='#f43f5e'`; `snrQualityColor` **4-band**
  (`null→#94a3b8`, `≥5→#22c55e`, `≥0→#eab308`, `≥-5→#f97316`, else `#ef4444`). curvature `neutral?0.12:0.2`;
  weight `2+min(occ-1,5)*0.8` (occurrence-based); opacity `getSegmentSnrOpacity`; dash `'4,6'` iff MQTT;
  Polyline click → select (no popup).

### 1.5 Issue-behavior locations (to consolidate)
| Issue | Behavior | Current homes |
|---|---|---|
| #1862 | snapshot route positions | useTraceroutePaths (`getNodePositionWithSnapshot`/`parseRoutePositions`), Widget L217, Dashboard `parseRoutePositions` L117. **MapAnalysis omits (live only).** |
| #2051 | empty-routeBack guard | Widget L233-248, useTracerouteAnalysis L150-165, RouteSegmentTraceroutesModal L51. |
| #2931 | unknown-SNR sentinel + per-hop MQTT | mapHelpers (canonical), useTracerouteAnalysis (**dup copy L5-9**), useTraceroutePaths, MapAnalysis layer. |

### 1.6 Existing tests encoding current behavior
- `src/utils/mapHelpers.test.tsx` — `getSegmentSnrColor` **3-band** cases (L96-123: good `>0`, medium
  `>=-10`, poor); `getLineWeight` range (L153-172); sentinel/opacity/curve. **Updates on 4-band change.**
- `src/hooks/useTraceroutePaths.test.tsx` — visibleNodeNums / channel / MQTT filtering (data logic;
  survives, may need element-shape tweaks after render swap).
- `src/hooks/useTracerouteAnalysis.test.ts` + `.emptyBack.test.ts` — data/dedup/#2051/#2931 (PRESERVE;
  only sentinel-import change).
- `src/components/MapAnalysis/layers/TraceroutePathsLayer.test.tsx` — "one polyline per segment", time-
  window exclusion (updates when render swaps to shared layer).

---

## 2. Canonical conventions design

### 2.1 SNR → color (one scale, 4-band, theme-aware)
Thresholds (canonical, binding): `avg ≥ 5` excellent · `≥ 0` good · `≥ -5` fair · `< -5` poor · `null/empty` noData.
SNR values are **/4-scaled dB** (already scaled by every data producer; DashboardMap's un-scaled `snrTowards`
**must be /4'd** when building segments — see §4).

Expand `overlayColors.snrColors` to `{ excellent, good, fair, poor, noData }` in **both** palettes.
Starting hex table (D3 — verify light against WCAG AA ≥4.0 on cream):
| band | dark (Mocha) | light (Latte, AA-on-cream) |
|---|---|---|
| excellent (≥5) | `#22c55e` | `#15803d` |
| good (≥0) | `#eab308` | `#8f5200` |
| fair (≥-5) | `#f97316` | `#b45309` |
| poor (<-5) | `#ef4444` | `#d20f39` |
| noData | `#6c7086` | `#6c6f7e` |

New mapHelpers export:
```ts
export interface SnrColorScale { excellent: string; good: string; fair: string; poor: string; noData: string; }
export function snrToColor(avgSnr: number | null | undefined, scale: SnrColorScale): string {
  if (avgSnr == null || isUnknownSnr(avgSnr)) return scale.noData;
  if (avgSnr >= 5) return scale.excellent;
  if (avgSnr >= 0) return scale.good;
  if (avgSnr >= -5) return scale.fair;
  return scale.poor;
}
```
Rewrite `getSegmentSnrColor(snrData, scale, defaultColor)` to average non-sentinel then delegate to
`snrToColor` (4-band; `defaultColor` still returned for all-empty to preserve the "no data uses
neighbor/mauve" caller intent — OR drop `defaultColor` and always use `scale.noData`; **recommend keep
`defaultColor` param** to avoid churn at the one caller). No separate 3-band survivor — the 3-band scale
is deleted app-wide (approved: NodesTab base layer changes 3→4 band).

### 2.2 Line weight (one API, three named strategies)
The three formulas are legitimately different data axes; keep all three as **explicit parameters**.
Export canonical strategy helpers from mapHelpers:
```ts
export const weightBySnr = getLineWeight;                              // existing 2..6 (keep name/behavior)
export function weightByUsage(usage: number): number { return Math.min(2 + usage, 8); }
export function weightByOccurrence(occ: number): number { return 2 + Math.min(occ - 1, 5) * 0.8; }
```
Layer `weight` prop = `number | ((seg) => number)`. NodesTab base → `weightByUsage(seg.usageCount)`;
NodesTab selected & Widget → `weightBySnr(seg.avgSnr)`; MapAnalysis → `weightByOccurrence(seg.occurrences)`;
Dashboard → fixed `2` (paths) / `4` (overlay pass).

### 2.3 Dash (one convention)
Canonical `MQTT_DASH = '3,6'`, applied iff segment is **MQTT OR all-SNR-unknown** (`isMqtt || avgSnr==null`).
Replaces `'5,10'` (Widget) and `'4,6'` (MapAnalysis) and NodesTab-base MQTT dash. Layer prop
`dashMode?: 'mqtt-unknown' | 'always' | 'never'` (default `'mqtt-unknown'`). Per D2 (resolved YES),
NodesTab selected route converges from `'always'` to `'mqtt-unknown'`; `'always'` stays available as an
escape hatch only. Per C2, the Dashboard **paths** pass also uses `'mqtt-unknown'` (sentinel data is
available once it builds via `decomposeTraceroute`); only its fixed-yellow overlay pass is `'never'`
(highlight, not a data encoding).

### 2.4 Opacity + temporal fade
Opacity is per-consumer → layer prop `opacity?: number | ((seg) => number)` with `getSegmentSnrOpacity`
available as the SNR-scaled default. Temporal fade (`getTemporalOpacityMultiplier`) is ONLY the NodesTab
base layer → gate behind `temporalFade?: boolean` (default false); when true the layer multiplies the
resolved opacity by `getTemporalOpacityMultiplier(seg.timestamp)` and floors at `0.15` (matches L575).

### 2.5 Curvature / arrows
`curvature?: number` (default 0 = straight). Forward legs use `+curvature`, return `-curvature`
(via `generateCurvedPath(..., normalizeDirection=true)`); `neutralCurvature?: number` for MapAnalysis
neutral segments (0.12). `showArrows?: boolean` (consumer computes: MapAnalysis `selectedNodeNum!==null`).
Arrows drawn with `generateCurvedArrowMarkers`; for straight layers (curvature 0) arrows are simply off.

### 2.6 What happens to the 3-band `getSegmentSnrColor`
**Deleted as a 3-band function** — repurposed to 4-band (single canonical). No non-traceroute caller
exists (verified: only useTraceroutePaths). The `noData` semantic previously split across `defaultColor`
arg and (absent) 4th band is now unified in `snrToColor`.

---

## 3. Shared modules — API design

### 3.1 `src/utils/tracerouteSegments.ts` (NEW — the single home for #1862/#2051/#2931)
Pure, React-free, fully unit-testable. Consolidates the per-traceroute decomposition common denominator;
consumer hooks call these then apply their own aggregation/filtering ON TOP.
```ts
export interface TracerouteRenderSegment {
  key: string;
  from: [number, number];              // lat,lng — already snapshot-resolved
  to: [number, number];
  leg: 'forward' | 'return' | 'neutral';
  direction?: 'inbound' | 'outbound' | 'neutral'; // MapAnalysis relative-to-selection
  avgSnr: number | null;               // /4-scaled dB; null = no data
  isMqtt: boolean;                      // per-hop sentinel (#2931), NOT node.viaMqtt
  usageCount?: number;                  // weightByUsage
  occurrences?: number;                 // weightByOccurrence
  timestamp?: number;                   // temporal fade
  snrSamples?: { snr: number; timestamp?: number }[]; // popup/chart + array color/opacity
}

// #1862 — parse the traceroute's stored position snapshot (nodeNum → latlng).
export function parseSnapshotRoutePositions(traceroute): Map<number, [number, number]>;
// snapshot-then-live resolution.
export function resolveSegmentPosition(nodeNum, snapshot, liveNodes): [number,number] | null;
// #2051 — true only when a return path genuinely exists.
export function hasReturnPath(routeBack: number[], snrBack: string | number[] | null): boolean;
// per-traceroute forward+return decomposition; sentinel→isMqtt/avgSnr(#2931); omits fictitious return (#2051).
export function decomposeTraceroute(traceroute, opts: { resolvePosition: (n:number)=>[number,number]|null }): TracerouteRenderSegment[];
```
`isUnknownSnr`/`UNKNOWN_SNR_SENTINEL` stay in mapHelpers; `useTracerouteAnalysis.ts` **imports them**
(removes its dup copy) so #2931 lives once.

> **Migration nuance:** MapAnalysis currently omits snapshot positions (live only). Its data hook
> `useTracerouteAnalysis` already decomposes and aggregates; it need not adopt `decomposeTraceroute`
> wholesale. Minimum to satisfy "#2051 once" = have `useTracerouteAnalysis` call `hasReturnPath`, and
> "#2931 once" = import the sentinel. Full `decomposeTraceroute` adoption is used by NodesTab / Widget /
> Dashboard (which all share snapshot + forward/return build). MapAnalysis keeps its live-position path
> but shares the guard + sentinel. This keeps the biggest hook's data logic untouched while still
> centralizing the three behaviors.

### 3.2 `src/components/map/layers/TraceroutePathsLayer.tsx` (NEW — the render layer)
```ts
export interface TraceroutePathsLayerProps {
  segments: TracerouteRenderSegment[];
  snrColors: SnrColorScale;                          // theme palette (prop, not useSettings)
  colorMode: 'snr' | 'direction' | 'fixed-leg' | 'fixed';
  legColors?: { forward: string; return: string };   // 'fixed-leg'
  directionColors?: { outbound: string; inbound: string; neutral: string }; // 'direction'
  fixedColor?: string;                                // 'fixed' (Dashboard yellow overlay)
  curvature?: number;                                 // 0 = straight; default 0
  neutralCurvature?: number;                          // MapAnalysis neutral 0.12
  weight: number | ((seg: TracerouteRenderSegment) => number);
  opacity?: number | ((seg: TracerouteRenderSegment) => number);
  dashMode?: 'mqtt-unknown' | 'always' | 'never';    // default 'mqtt-unknown'
  showArrows?: boolean;
  temporalFade?: boolean;                             // multiplies opacity, floor 0.15
  highlight?: { group: 'forward' | 'return' | 'neutral' | null; dimmedOpacity: number }; // Widget hover
  onSegmentClick?: (seg: TracerouteRenderSegment) => void;   // MapAnalysis click-select
  renderPopup?: (seg: TracerouteRenderSegment) => React.ReactNode; // NodesTab recharts / DraggablePopup
  segmentClassName?: (seg: TracerouteRenderSegment) => string;     // NodesTab 'route-segment node-X'
}
```
Rendering: for each segment, resolve color (by `colorMode`), weight, opacity (× temporalFade if set,
× dim if `highlight` and segment not in highlighted group), dash (`dashMode`), geometry
(`curvature===0` → straight `[from,to]`; else `generateCurvedPath` with leg-signed curvature). Emit
`<Polyline>` (+ optional `<Popup>` from `renderPopup`, + `onClick={onSegmentClick}`), then arrows via
`generateCurvedArrowMarkers` when `showArrows`. Returns a fragment (BaseMap convention). **No `any`.**

**Consumer → props mapping:**
| Consumer | colorMode | curvature | weight | opacity | dashMode | arrows | extras |
|---|---|---|---|---|---|---|---|
| NodesTab base | `snr` | 0 | `weightByUsage` | `getSegmentSnrOpacity` | mqtt-unknown | off | `temporalFade`, `renderPopup` (recharts), `segmentClassName` |
| NodesTab selected | `fixed-leg` (theme fwd/ret) | 0.2 | `weightBySnr` | 0.9 | mqtt-unknown (was always — D2) | on | `renderPopup` (DraggablePopup) |
| Widget | `fixed-leg` (theme fwd/ret via `useSettings().overlayColors` — C1) | 0.2 | `weightBySnr` | 0.9 | mqtt-unknown | on | `highlight` (hover) |
| Dashboard paths | `snr` | 0 | `2` | 0.85 | mqtt-unknown (C2) | off | gains return legs |
| Dashboard overlay | `fixed` (`#facc15`) | 0 | `4` | 0.6 | never (highlight, not data) | off | 2nd layer instance |
| MapAnalysis | `direction` (focused) / `snr` (unfocused) | 0.2 / neutral 0.12 | `weightByOccurrence` | `getSegmentSnrOpacity` | mqtt-unknown | `selectedNodeNum!==null` | `onSegmentClick` |

MapAnalysis colorMode is dynamic: when a node is focused use `'direction'` (`directionColors` blue/rose),
else `'snr'`. Implement as consumer passing `colorMode={focused ? 'direction' : 'snr'}`.

---

## 4. File-by-file changes

### Created
- `src/utils/tracerouteSegments.ts` — §3.1. (+ `.test.ts`)
- `src/components/map/layers/TraceroutePathsLayer.tsx` — §3.2. (+ `.test.tsx`)

### Modified
- `src/config/overlayColors.ts` — expand `OverlayColors.snrColors` to `{excellent,good,fair,poor,noData}`;
  update both palettes (§2.1 table).
- `src/utils/mapHelpers.tsx` — add `SnrColorScale`, `snrToColor`, `weightByUsage`, `weightByOccurrence`,
  `weightBySnr` alias, `MQTT_DASH`; rewrite `getSegmentSnrColor` to 4-band delegate.
- `src/utils/mapHelpers.test.tsx` — 4-band assertions for `getSegmentSnrColor`; add `snrToColor` +
  weight-strategy tests.
- `src/hooks/useTracerouteAnalysis.ts` — import `isUnknownSnr`/`UNKNOWN_SNR_SENTINEL` from mapHelpers
  (delete dup L5-9); call `hasReturnPath` for the #2051 guard.
- `src/hooks/useTraceroutePaths.tsx` — `ThemeColors.snrColors` type → 4-band; replace hand-built
  Polyline/arrow construction in BOTH memos with `TracerouteRenderSegment[]` + `<TraceroutePathsLayer/>`
  (base + selected). Keep dedup/usage/zoom-adaptive/visibleNodeNums/bounds DATA logic. Recharts popup
  moves into a `renderPopup` callback.
- `src/components/NodesTab.tsx` — the `React.memo` pass-throughs render arrays unchanged; node-SNR swatch
  L2584 → `snrToColor` (D4).
- `src/components/TracerouteWidget.tsx` — replace inline render L507-573 with `<TraceroutePathsLayer/>`;
  keep `mapData`/#2051 (or delegate to `decomposeTraceroute`); wire hover via `highlight` prop; **delete
  hardcoded `#4CAF50`/`#2196F3` leg palette — legs converge to theme `tracerouteForward`/`tracerouteReturn`
  read from `useSettings().overlayColors` (C1, approved visible change);** legend swatches read the same
  tokens; delete local dash inline logic.
- `src/components/Dashboard/DashboardMap.tsx` — **delete local `snrToColor` L86-92** and use canonical;
  **/4-scale** the SNR when building segments; add return-leg decomposition (via `decomposeTraceroute`
  or extend `tracerouteSegments`); replace the two stacked passes with two `<TraceroutePathsLayer/>`
  instances — paths `colorMode:'snr'` with `dashMode:'mqtt-unknown'` (C2 — sentinel data now flows from
  `decomposeTraceroute`, so MQTT segments dash here like everywhere else) + overlay `colorMode:'fixed'`
  with `dashMode:'never'`.
- `src/components/MapAnalysis/layers/TraceroutePathsLayer.tsx` — **delete local `snrQualityColor` +
  hardcoded OUTBOUND/INBOUND**; map `AnalyzedSegment[]` → `TracerouteRenderSegment[]` and render the
  shared `src/components/map/layers/TraceroutePathsLayer`. File remains a thin MapAnalysis adapter
  (preserves its test location); `useTracerouteAnalysis` untouched except §above.
- `src/components/MapAnalysis/MapLegend.tsx` — SNR section L127-131 hardcoded hex → read canonical
  `useSettings().overlayColors.snrColors` (excellent/good/fair/poor). Labels already match.
- `src/App.tsx` — L444 `snrColors: schemeColors.snrColors` now carries 4 bands (no logic change; type flows).

### Deleted (local implementations)
- `DashboardMap.snrToColor`, `MapAnalysis.snrQualityColor` + its `OUTBOUND_COLOR`/`INBOUND_COLOR`,
  `useTracerouteAnalysis` private sentinel copy, `mapHelpers.getSegmentSnrColor` 3-band body, hardcoded
  leg palettes inline in Widget/NodesTab-selected/Dashboard-overlay (moved to `legColors`/`fixedColor`).

---

## 5. Test plan

### Updated (encode OLD behavior)
- `src/utils/mapHelpers.test.tsx` — rewrite `getSegmentSnrColor` cases to 4-band thresholds; keep
  `getLineWeight`/opacity/sentinel/curve cases.
- `src/components/MapAnalysis/layers/TraceroutePathsLayer.test.tsx` — "one polyline per segment" and
  time-window exclusion still valid; update any color/weight assertions to shared-layer output.
- `src/hooks/useTraceroutePaths.test.tsx` — filtering tests survive (data logic); adjust element-shape
  expectations if they assert raw Polyline props now produced by the shared layer.

### Unchanged / preserve
- `src/hooks/useTracerouteAnalysis.test.ts` + `.emptyBack.test.ts` — data/dedup/#2051/#2931 unchanged
  (only sentinel now imported; behavior identical).

### New
- `tracerouteSegments.test.ts` — **#1862** (snapshot beats live position), **#2051**
  (`hasReturnPath`/`decomposeTraceroute` omit fictitious return for empty routeBack+snrBack; DRAW when
  snrBack has data), **#2931** (sentinel → `isMqtt`/`avgSnr=null`; per-hop, not node.viaMqtt), forward/
  return leg + `/4` scaling.
- `TraceroutePathsLayer.test.tsx` (map/layers) — color modes (snr 4-band / direction / fixed-leg /
  fixed), weight strategies (usage/occurrence/snr/fixed), dash logic (mqtt-unknown vs always vs never),
  curvature 0=straight vs curved, arrows on/off, temporalFade opacity floor 0.15, hover dim, popup/click
  render-props. Assert polyline count = segment count.

**Gate:** full Vitest suite `success:true`, 0 failures (verify via `--reporter=json`, per memory —
the rtk summary line masks suite-collection failures). `npm run lint:ci` exits 0 (no baseline growth;
no new `any`). typecheck clean.

---

## 6. Work packages (Sonnet-sized, disjoint, ordered)

### WP1 — Canonical conventions + theme palette *(no deps)*
Files: `overlayColors.ts`, `mapHelpers.tsx`, `mapHelpers.test.tsx`, `useTracerouteAnalysis.ts` (sentinel
import only), `NodesTab.tsx:2584`, `useTraceroutePaths.tsx` (`ThemeColors.snrColors` type only), `App.tsx`
(type flow). **Acceptance:** 4-band `snrColors` in both palettes; `snrToColor`/weight strategies/`MQTT_DASH`
exported + tested; `getSegmentSnrColor` 4-band; useTracerouteAnalysis uses shared sentinel; suite+lint green.
No visual change yet except NodesTab node-SNR swatch (D4).

### WP2 — Shared decomposition util + render layer + tests *(deps: WP1)*
Files: `src/utils/tracerouteSegments.ts` (+test), `src/components/map/layers/TraceroutePathsLayer.tsx`
(+test). **Acceptance:** util encapsulates #1862/#2051/#2931 with tests; layer renders all color modes /
weight strategies / dash / curvature / arrows / temporalFade / hover / popup+click render-props; no
consumer wired yet; suite+lint green.

### WP3 — NodesTab / useTraceroutePaths migration *(deps: WP2)*
Files: `useTraceroutePaths.tsx`, `NodesTab.tsx` (pass-throughs). **Acceptance:** both base + selected
layers render via shared `TraceroutePathsLayer`; dedup/usage/zoom-adaptive/visibleNodeNums/bounds/recharts
popup preserved; base layer now 4-band (approved); browser-validated on Nodes map; suite green.

### WP4 — DashboardMap + TracerouteWidget migration *(deps: WP2; parallel to WP3)*
Files: `DashboardMap.tsx`, `TracerouteWidget.tsx`. **Acceptance:** Dashboard uses canonical scale
(**/4 scaling — binding, D5**), **gains return legs**, two-pass via two layer instances with paths pass
`dashMode:'mqtt-unknown'` and overlay pass `'never'` (C2 — MQTT segments visibly dash on the Dashboard);
Widget renders via shared layer with hover-highlight preserved, #2051 guard intact, and **leg colors from
theme `tracerouteForward`/`tracerouteReturn` via `useSettings().overlayColors`** (C1 — hardcoded
`#4CAF50`/`#2196F3` deleted; legend swatches match); browser-validated on Dashboard + widget; suite green.

### WP5 — MapAnalysis render migration + legend SNR *(deps: WP2; parallel to WP3/WP4)*
Files: `MapAnalysis/layers/TraceroutePathsLayer.tsx`, `MapAnalysis/MapLegend.tsx`,
`MapAnalysis/layers/TraceroutePathsLayer.test.tsx`. **Acceptance:** analysis layer renders via shared
layer (occurrence weight, direction/snr color modes, neutral curvature, click-select preserved); legend
SNR section consumes canonical `overlayColors.snrColors`; `snrQualityColor`/hardcoded direction hex
deleted; `useTracerouteAnalysis` data logic untouched; browser-validated on Map Analysis; suite green.

**Dependency graph:** WP1 → WP2 → {WP3 ∥ WP4 ∥ WP5}. (WP3-5 touch disjoint files; safe in parallel,
but each must re-run full suite before its PR-slice.)

---

## 7. Risks & gotchas

- **useTraceroutePaths is 1076 LOC feeding NodesTab via App.tsx props (`mergedThemeColors`, `mapZoom`,
  `visibleNodeNums`).** The DATA logic (dedup-per-pair, usage aggregation, zoom-adaptive `<8` filter,
  visibleNodeNums, snapshot bounds, recharts SNR chart) must survive intact — WP3 only swaps the
  element-construction tail, not the memo bodies. The recharts `SegmentSnrChart` (≥3 samples) must move
  into `renderPopup` verbatim.
- **DashboardMap's two stacked passes** (`showPaths` weight-2 base + `showRoute` fixed-yellow weight-4
  overlay) are TWO layers over the same segment set — model as two `<TraceroutePathsLayer>` instances,
  not one. Also: Dashboard SNR is **un-scaled** today; must `/4` when building segments or colors shift.
- **MapAnalysis `useTracerouteAnalysis` dedup/filtering is data-side and must stay** — do NOT push its
  aggregation into the shared layer. It keeps live positions (no snapshot); only shares the sentinel +
  #2051 guard. Direction coloring is only active when a node is focused (`colorMode` toggles).
- **Widget hover state** (`highlightedPath` driven by legend mouse events) → the `highlight` prop; arrows
  currently draw only for the highlighted leg — preserve via arrows honoring `highlight`.
- **Zoom-adaptive filtering** (NodesTab base, `mapZoom<8`) stays in the hook (data decision), not the layer.
- **No new `any`; lint baseline must not grow** (CLAUDE.md ratchet). Type the layer/util fully.
- **`snrColors` field rename (D1)** touches every reader — WP1 must update mapHelpers, useTraceroutePaths
  `ThemeColors`, NodesTab:2584, App.tsx merge, MapAnalysis legend (WP5) in lockstep or typecheck breaks.
- **Verify suite via `--reporter=json`** (`success:true`) — the rtk summary line masks suite-collection
  failures (project memory).
- **Snapshot-position parity:** three current `parseRoutePositions` copies (useTraceroutePaths, Widget,
  Dashboard) may differ subtly in field names of the stored snapshot — WP2's `parseSnapshotRoutePositions`
  must reproduce each; diff them during WP2 to avoid a regression where a route silently falls back to live.
- **Widget node-marker colors (C1 side-effect):** the Widget also colors its from/to node icons
  `#4CAF50`/`#2196F3` to match its old leg palette (createNodeIcon call around L322). Marker icon
  unification is **Phase 4 scope** — WP4 must NOT restyle the markers, but should note the temporary
  leg/marker color mismatch in a code comment referencing Phase 4.
