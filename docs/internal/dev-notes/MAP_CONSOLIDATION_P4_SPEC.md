# Map Consolidation — Phase 4 Spec: Node Marker Unification

**Epic:** #4047 · **Phase:** 4 · **Branch:** `feature/4047-p4-marker-unify` (from `origin/4049-map-refactor`)
**Status:** Spec — no feature code written yet.
**Scope:** the four app maps that render mesh-node markers — NodesTab, DashboardMap, MeshCoreMap, MapAnalysis. EmbedMap is Phase 6 (transparent to this phase). Popup **content** is Phase 5 (preserve exactly).

## 0. TL;DR for implementers

Today there are **two node-marker icon builders** (`createNodeIcon` hop-colored in `src/utils/mapIcons.ts`; MeshCoreMap's hand-rolled `makeIcon` mauve badge) and **four copies of the same spiderfy/icon-cache/popup-strip bridge** (NodesTab inline, DashboardMap inline, MeshCoreMap inline, MapAnalysis `NodeMarkersLayer`). Phase 4:

1. **One icon factory** at `src/components/map/markerIcons.ts` unifying `createNodeIcon` (hop-colored Meshtastic pins/circles) and MeshCoreMap's badge into ONE function whose source-tech differences (fixed vs hop color, badge vs pin body, label-above vs label-below, 24px center-anchor vs 48/60px) are **explicit parameters**. `src/utils/mapIcons.ts` becomes a re-export shim so EmbedMap/MapLegend and any un-migrated importer are untouched.
2. **One shared `NodeMarkersLayer`** at `src/components/map/layers/NodeMarkersLayer.tsx`, generalized from `MapAnalysis/layers/NodeMarkersLayer.tsx`, owning spiderfy wiring + stable position/icon caches + OMS-click→openPopup + the `_openPopup` strip + first-mount pending-flush + removal reconciliation. Consumed by all four app maps. Each host stops re-wiring `SpiderfierController`.
3. Consumer-specific **data/behavior** (filtering, selection state, opacity/age fade, polyline-dimming hover, popup content, spiderfy-key derivation, the rich NodesTab click handler) stays consumer-side, expressed through typed props/callbacks.

**This is a pure refactor: the approved-visible-changes list is EMPTY (§5).** Every marker must render pixel-identical. Anything visibly different is a regression.

## 0.1 Orchestrator decisions — proposed (gate review needed)

| # | Question | Recommendation |
|---|---|---|
| D1 | Factory home: MOVE `createNodeIcon`/glyph helpers to `src/components/map/markerIcons.ts` + re-export from `src/utils/mapIcons.ts`, OR keep in `mapIcons.ts` and just extend? | **MOVE + re-export shim.** Epic goal text says "one icon factory in `src/components/map/`". The shim keeps EmbedMap/MapLegend/all importers transparent (zero edits). |
| D2 | Unified factory shape: extend `createNodeIcon` options with new optional fields (`fixedColor`, `variant`, `labelName`) keeping the current signature working, OR a discriminated-union rewrite? | **Extend, additively.** Keep every existing option field's exact code path (guarantees Meshtastic pixel parity for 4 surfaces) and add the MeshCore `variant:'badge'` branch as the moved `makeIcon` body verbatim (guarantees MeshCore parity). |
| D3 | TracerouteWidget from/to endpoint dots (hand-rolled `L.divIcon`, green/blue/gray) — resolve the Phase-3 `TODO(#4047 Phase 4)`. Keep green/blue semantic, or converge to theme leg colors? | **Keep green/blue/gray; relocate into the factory module** as `createTracerouteEndpointIcon`; delete the stale TODO with a comment stating endpoint dots are a deliberate source/dest/hop role semantic, distinct from leg color. **Zero pixel change.** (Alternative: theme-match — would make from==to==pink, losing the from/to distinction; not recommended.) |
| D4 | Should the shared `NodeMarkersLayer` own the spiderfier via `useMarkerSpiderfier` directly (it is a child of `MapContainer`), retiring `SpiderfierController` for these four maps? | **Yes.** The layer mounts inside the map and calls `useMarkerSpiderfier(SHARED_SPIDERFIER_OPTIONS)` itself. This removes each host's `SpiderfierController` mount + ref + OMS-ready retry dance (Dashboard/MeshCore) and centralizes the 4 duplicated `_openPopup` strips. `SpiderfierController` stays in the tree only if a non-node map still needs it (none in this phase). |
| D5 | WaypointsLayer `emojiDivIcon` (32px emoji POI pin) — in scope? | **No.** A waypoint POI emoji is not a mesh-node marker; different concept. Leave as-is, state explicitly. |

---

## 1. Reuse inventory (serena/grep-verified 2026-07-10)

All epic-survey premises **verified accurate** except line-number drift; corrections noted. Line numbers current on this branch.

### 1.1 Icon builders

**`src/utils/mapIcons.ts` (268 LOC)** — pure module (only `import L from 'leaflet'`). Exports:
- `roleGlyphInnerSvg(category, color): string` (L14) — inner SVG for repeater/roomServer/sensor/companion glyph families, `''` for standard.
- `roleGlyphMarkerSvg(category, color, size=24): string` (L63) — full `<svg>`: white circle (r20, `fill-opacity 0.95`, stroke=color w2) + inner glyph; `''` for standard. **Importers:** MeshCoreMap `makeIcon`, `src/components/MapLegend.tsx:150` (legend swatches).
- `getHopColor(hops, hopColors?): string` (L87) — hop gradient (0=green `#22c55e`, 999=grey `#9ca3af`, ≥6=red, else gradient).
- `createNodeIcon(options): L.DivIcon` (L112) — THE Meshtastic builder. Options: `{hops, isSelected, isRouter, shortName?, showLabel, animate?, highlightSelected?, pinStyle?, roleCategory?}`. Two styles:
  - **`pinStyle:'meshmonitor'`** (default): 48px (60 selected) pin/tower/glyph SVG; `iconSize:[size, size+(label?20:0)]`; `iconAnchor:[size/2, size]` (bottom); `popupAnchor:[0,-size]`; label BELOW (`top:size+2`, white pill w/ colored border) when `showLabel && shortName`; `animate`→`node-icon-pulse`, `highlightSelected`→`node-icon-highlight`.
  - **`pinStyle:'official'`**: 48/60px circle w/ short-name text OR role glyph OR emoji overlay; `iconAnchor:[circleSize/2, circleSize/2]` (center); `popupAnchor:[0,-circleSize/2]`.
  - `className:'custom-node-icon'` both.
  - **Importers:** NodesTab:11, EmbedMap:7 (Phase 6), DashboardMap:18, MapAnalysis `NodeMarkersLayer`:11. (TracerouteWidget has a **local, unrelated** `createNodeIcon` — see 1.3.)

**MeshCoreMap `makeIcon(name, category): L.DivIcon` (MeshCoreMap.tsx:76)** — the hand-rolled builder to eliminate. Body:
- glyph present → `<div style="width:24px;height:24px;filter:drop-shadow(0 2px 4px …)">{roleGlyphMarkerSvg(category, MESHCORE_COLOR, 24)}</div>`.
- else → 24×24 mauve (`MESHCORE_COLOR = #cba6f7`) circle, white 2px border, box-shadow, centered bold `#1e1e2e` "MC" text.
- ALWAYS a name label ABOVE: `position:absolute; top:-20px; left:50%; translateX(-50%); background:${MESHCORE_COLOR}e6; color:#1e1e2e; padding:2px 6px; border-radius:3px; font-size:11px; white-space:nowrap`.
- `className:'meshcore-marker'`, `iconSize:[24,24]`, `iconAnchor:[12,12]` (center). **No** `popupAnchor`. **No** hop color, selection, or animate.

**Divergences the ONE factory must parameterize (source-tech, per user directive):** fixed color (mauve) vs `getHopColor`; badge/MC-fallback body vs pin/tower/circle; 24px center-anchor vs 48/60px bottom(pin)/center(circle) anchor; label-above-always-pill vs label-below-on-zoom / baked-in-circle; no selection/animate vs full.

### 1.2 Spiderfy + cache bridge — four near-identical copies

Shared primitives (keep): `src/hooks/useMarkerSpiderfier.ts` (352 LOC) + `SHARED_SPIDERFIER_OPTIONS` (50px nearbyDistance etc.); `src/components/SpiderfierController.tsx` (forwardRef wrapper over the hook). **All four maps already use `SHARED_SPIDERFIER_OPTIONS`** — spiderfy tuning is already unified (no visible change here).

The hook already owns the **#3612 first-mount buffering** (`pendingRef` flushed when the spiderfier is created — `<Marker ref>` fires in the commit BEFORE the hook's init effect) and the same-position marker-replacement logic.

The per-host bridge (duplicated, to centralize):

| Concern | NodesTab | DashboardMap | MeshCoreMap | MapAnalysis NodeMarkersLayer |
|---|---|---|---|---|
| Spiderfier access | `SpiderfierController` ref sibling | same | same | `useMarkerSpiderfier(SHARED)` **direct** |
| Marker→spiderfier register | `handleMarkerRef(ref, nodeId)` tags `ref._meshNodeId`, `addMarker(ref, nodeId)` | per-key `getMarkerRef(key)`, ignore null bounce, `addMarker(m,key)` | per-key `getMarkerRef`, `addMarker(m,key)` | per-key `getMarkerRef(key)`, `addMarker(m,key)` |
| Icon cache | batch `nodeIcons` useMemo `Map<nodeNum, DivIcon>` keyed by sig-string | per-key `stableIcon(key,sig,build)` + `iconCacheRef` | per-key `stableIcon` + `iconCacheRef` | per-key `stableIcon` + `iconCacheRef` |
| Position cache | batch `nodePositions` Map | per-key `stablePosition` + `positionCacheRef` | per-key `stablePosition` + `positionCacheRef` | per-key `stablePosition` + `positionCacheRef` |
| Removal reconcile | (via handleMarkerRef churn) | `renderedKeysSig` effect drops stale keys | `renderedKeysSig` effect | `renderedKeysSig` effect |
| OMS `click` listener | rich handler: setSelected + centerMapOnNode + conditional `openPopup` (autoPan off), keyed off `_meshNodeId` | default `marker.openPopup()`, **retry loop** until OMS ready | default `openPopup`, **retry loop** | default `openPopup`, registered in effect (no retry — direct hook) |
| `_openPopup` strip (#4015) | every-render effect, per-marker `_meshPopupStripped` tag | `renderedKeysSig`-keyed effect | every-render effect + `_meshPopupStripped` tag | `renderedKeysSig`-keyed effect |
| Stable-ref rationale | memoized icon/pos Maps (#3685) | value-cached refs (#3685) | value-cached refs (#3685) | value-cached refs (#3685) |

**The obscured-marker fix (commits 40b6b1e6/ade691b1, #4015)** = the OMS-click-only popup opening + the `_openPopup` strip. Both must be preserved, centralized in the shared layer. The **#3685 fan-collapse fix** = stable position/icon refs across polls; the layer owns the caches so it survives.

### 1.3 Out-of-scope divIcons (verify, then leave or relocate per D3/D5)
- **TracerouteWidget local `createNodeIcon(isEndpoint,isFrom,isTo)` (L329)** — endpoint dots: 12px (endpoint) / 8px (hop); green `#4CAF50` from, blue `#2196F3` to, gray `#888` hop; `className:'traceroute-node-icon'`; `iconSize:[size+4,size+4]`, center anchor. Carries the `TODO(#4047 Phase 4)` (L325). **Not** a mesh-node icon. Resolve per **D3** (recommend relocate into `markerIcons.ts` unchanged, delete TODO). Widget is NOT a `NodeMarkersLayer` consumer.
- **WaypointsLayer `emojiDivIcon` (WaypointsLayer.tsx:36)** — 32px emoji POI pin. Out of scope (**D5**), leave.
- **NodesTab `createArrowIcon` (neighbor-line arrows, L2647) / `mapHelpers` arrow icons** — traceroute/neighbor decorations, not node markers. Out of scope.

### 1.4 Consumer marker render — current call shapes (what maps onto the layer)

- **NodesTab (L2284–2360+):** `nodesWithPosition.filter(...).map(node => <Marker key={nodeNum} position={nodePositions.get(nodeNum)} icon={nodeIcons.get(nodeNum)} opacity={calculateNodeOpacity(...)} zIndexOffset={animate?10000:0} ref={r=>handleMarkerRef(r, node.user?.id)} eventHandlers={!isTouchDevice?{mouseover, mouseout}}><Popup>MapNodePopupContent…</Popup></Marker>)`. Icon = `createNodeIcon({hops,isSelected,isRouter,shortName,showLabel:showLabel||animate,animate,highlightSelected:showRoute&&isSelected,pinStyle:mapPinStyle})`. Rich OMS click handler (selection+center+popup). Consumer-side: transport/complete/estimated/traceroute/age filters, `mouseover`/`mouseout` polyline dimming, `MapContext`-fed refs.
- **DashboardMap (L569–624):** `nodesWithPosition.map(({node,pos}) => <Marker key={nodeId} ref={getMarkerRef(markerKey)} position={stablePosition(...)} icon={stableIcon(markerKey, sig, ()=>createNodeIcon({hops,isSelected:false,isRouter,shortName,showLabel:true,pinStyle}))} opacity={ageOpacity}><Popup><DashboardNodePopup/></Popup></Marker>)`. markerKey = `${sourceId}:${nodeNum}` or `nodeId`. Default OMS openPopup.
- **MeshCoreMap (L531–586):** `visibleContacts.map(c => <Marker key={publicKey} ref={getMarkerRef(publicKey)} position={stablePosition(publicKey,…)} icon={stableIcon(publicKey, `${name}|${category}`, ()=>makeIcon(name,category))}><Tooltip/><Popup>…</Popup></Marker>)`. Default OMS openPopup. No opacity/selection.
- **MapAnalysis `NodeMarkersLayer` (whole file, 287 LOC):** the reference generalization. `filteredNodes.map(({node,latLng,key})=>…)` with per-key `stableIcon`/`stablePosition`/`getMarkerRef`, `keyOf(n)` (`mc:${nodeId}` for MeshCore, `${sourceId}:${nodeNum}` else), hop-shaded icon, time-slider age fade, selection-dim via leaflet `opacity` (NOT folded into iconSig), `eventHandlers.click`→setSelected, OMS-click openPopup, `_openPopup` strip, `<Popup pane="popupPane"><DashboardNodePopup/></Popup>`.

### 1.5 Existing tests
`src/utils/mapIcons.test.ts`, `src/hooks/useMarkerSpiderfier.test.tsx`, `src/components/SpiderfierController.test.tsx`, `src/components/MapLegend.test.tsx`, `src/components/MapAnalysis/layers/NodeMarkersLayer.test.tsx`, `src/components/Dashboard/DashboardMap.test.tsx`. **Memory (binding): spiderfy tests mock OMS, so they do NOT catch spiderfy regressions — browser validation is the real gate.**

---

## 2. Icon factory API — `src/components/map/markerIcons.ts`

**Move** the full contents of `src/utils/mapIcons.ts` here; `src/utils/mapIcons.ts` becomes `export * from '../components/map/markerIcons';` (D1). EmbedMap/MapLegend/all importers stay byte-identical.

**Extend `createNodeIcon` additively (D2)** — every existing option keeps its exact behavior; new optional fields add the MeshCore capability:

```ts
export interface CreateNodeIconOptions {
  // --- existing (unchanged code paths; Meshtastic parity) ---
  hops?: number;                 // used when color kind = hops (default)
  isSelected?: boolean;
  isRouter?: boolean;
  shortName?: string;
  showLabel?: boolean;
  animate?: boolean;
  highlightSelected?: boolean;
  pinStyle?: 'meshmonitor' | 'official';
  roleCategory?: NodeTypeCategory;
  // --- new (source-tech parameters) ---
  variant?: 'meshtastic' | 'meshcore';   // default 'meshtastic'
  fixedColor?: string;                    // when set, overrides getHopColor(hops) (MeshCore mauve)
  labelName?: string;                     // 'meshcore' variant: always-visible name pill ABOVE
}
export function createNodeIcon(options: CreateNodeIconOptions): L.DivIcon;
```

Dispatch:
- **`variant:'meshtastic'`** (default): current body verbatim. `color = fixedColor ?? getHopColor(hops ?? 999)`. (Meshtastic callers never pass `fixedColor`, so their output is byte-identical.)
- **`variant:'meshcore'`**: the **moved `makeIcon` body verbatim** — `roleGlyphMarkerSvg(roleCategory, fixedColor, 24)` glyph-or-"MC"-badge + name pill from `labelName`; `className:'meshcore-marker'`, `iconSize:[24,24]`, `iconAnchor:[12,12]`. Ignores pin/selection/animate (MeshCore has none today). Guarantees MeshCore pixel parity.

**Endpoint-dot helper (D3), co-located in the same module** to satisfy "no hand-rolled node-marker divIcon outside the factory":
```ts
export function createTracerouteEndpointIcon(role: 'from' | 'to' | 'hop'): L.DivIcon; // green/blue/gray, sizes 12/8 — verbatim relocation of Widget's local builder
```

**Icon cache design** lives in the shared `NodeMarkersLayer` (§3), NOT in the factory (the factory is pure, matching P1/P3 "shared map modules are persistence-agnostic"). Cache is keyed by the layer's stable **marker key**; the entry's validity is an opaque **`iconSig` string** the consumer computes (it already does today) — the cache rebuilds only when `iconSig` changes. Consumers keep their existing sig recipes:
- NodesTab: `${nodeNum}-${hops}-${isSelected}-${role}-${shortName}-${showLabel}-${animate}-${showRoute&&isSelected}-${pinStyle}`.
- Dashboard: `${hops}|${shortName}|${isRouter}|${pinStyle}`.
- MapAnalysis: `${hops}|${isSelected}|${isRouter}|${roleCategory}|${shortName}|${pinStyle}` (selection dim NOT in sig — applied via leaflet `opacity`).
- MeshCore: `${name}|${category}` (add `${fixedColor}` only if color ever varies — it doesn't; keep parity).

**Invalidation:** by iconSig only. Theme switch: hop colors are computed inside `createNodeIcon` from `getHopColor` (fixed palette, not theme-reactive today) — so no theme term is needed to preserve current behavior. (If a future phase makes hop colors theme-aware, add the theme token to each sig; out of scope here.) Selection/age-opacity is applied via the leaflet `opacity` prop, never the icon, so it never churns the cache/fan.

---

## 3. Shared `NodeMarkersLayer` — `src/components/map/layers/NodeMarkersLayer.tsx`

Generalized from `MapAnalysis/layers/NodeMarkersLayer.tsx`. Child of `MapContainer`. Calls `useMarkerSpiderfier(SHARED_SPIDERFIER_OPTIONS)` internally (D4) and owns ALL of: stable position/icon caches, per-key ref handlers (register-on-instance, ignore null bounce), removal reconciliation, OMS-click listener, `_openPopup` strip, pending-flush (via the hook). Returns a fragment. No `any`.

```ts
export interface NodeMarkerDescriptor {
  key: string;                         // stable, UNIQUE spiderfy key (consumer-derived)
  position: [number, number];          // lat,lng — effective position resolved consumer-side
  iconSig: string;                     // cache signature (consumer-computed)
  buildIcon: () => L.DivIcon;          // called only when iconSig changes
  opacity?: number;                    // leaflet opacity (age fade / selection dim) — NOT in iconSig
  zIndexOffset?: number;
  eventHandlers?: LeafletEventHandlerFnMap;  // plain leaflet handlers (e.g. MapAnalysis click→setSelected; NodesTab mouseover/mouseout)
  children?: React.ReactNode;          // <Popup>/<Tooltip> — consumer owns (Phase 5, unchanged)
}
export interface NodeMarkersLayerProps {
  markers: NodeMarkerDescriptor[];
  spiderfierOptions?: SpiderfierOptions;                 // default SHARED_SPIDERFIER_OPTIONS
  onOmsClick?: (marker: LeafletMarker, key: string) => void; // default: marker.openPopup() w/ autoPan preserved
  stripLeafletAutoPopup?: boolean;                       // default true (#4015)
}
```

Internals (moved from the per-host copies, single source of truth):
- `markerByKey`, `refHandlers`, `positionCacheRef`, `iconCacheRef` refs; `stablePosition`/`stableIcon` keyed by `descriptor.key`+`iconSig`.
- `getMarkerRef(key)`: register on instance (`addMarker(m,key)`), track in `markerByKey`, **ignore the null bounce**; expose the leaflet instance to `onOmsClick` via the key map.
- `renderedKeysSig` effect: drop keys no longer in `markers`; `removeMarker` + evict caches.
- OMS `click` listener effect (registered after the hook's init effect — no retry dance needed since the hook is called here directly): default `marker.openPopup()`; if `onOmsClick` supplied, call it with `(marker, key)`.
- `_openPopup` strip effect: every-render loop, per-marker `_meshPopupStripped` tag (safest of the current variants), gated on `stripLeafletAutoPopup`.
- Render `markers.map(d => <Marker key={d.key} ref={getMarkerRef(d.key)} position={stablePosition(d.key, ...d.position)} icon={stableIcon(d.key, d.iconSig, d.buildIcon)} opacity={d.opacity} zIndexOffset={d.zIndexOffset} eventHandlers={d.eventHandlers}>{d.children}</Marker>)`.

**Consumer → layer mapping.** Each host builds `NodeMarkerDescriptor[]` from its own data shape and renders `<NodeMarkersLayer markers={...} onOmsClick={...}/>`; keeps filtering/selection/opacity/popup content consumer-side.

| Consumer | key | position | icon (buildIcon) | opacity | eventHandlers | onOmsClick | children (Phase 5) |
|---|---|---|---|---|---|---|---|
| **NodesTab** | `String(node.user?.id ?? nodeNum)` (keep current `_meshNodeId` semantics via key) | `getEffectivePosition(node)` | `createNodeIcon({variant:'meshtastic', hops, isSelected, isRouter, shortName, showLabel:showLabel\|\|animate, animate, highlightSelected:showRoute&&isSelected, pinStyle})` | `calculateNodeOpacity(...)` | `{mouseover, mouseout}` (polyline dim) when `!isTouchDevice` | rich: setSelected + centerMapOnNode + conditional openPopup(autoPan off) — uses `key`, drops `_meshNodeId` tag | `<Popup><MapNodePopupContent/></Popup>` |
| **DashboardMap** | `${sourceId}:${nodeNum}` \| `nodeId` | `pos` (`{lat,lng}`) | `createNodeIcon({variant:'meshtastic', hops, isSelected:false, isRouter, shortName, showLabel:true, pinStyle})` | `ageOpacity` | — | default (openPopup) | `<Popup><DashboardNodePopup/></Popup>` |
| **MeshCoreMap** | `publicKey` | `[lat,lng]` | `createNodeIcon({variant:'meshcore', fixedColor: MESHCORE_COLOR, roleCategory: category, labelName: name})` | — | — | default (openPopup) | `<Tooltip/><Popup>…</Popup>` |
| **MapAnalysis** | `keyOf(n)` (`mc:${nodeId}` \| `${sourceId}:${nodeNum}`) | `latLng` (live only) | `createNodeIcon({variant:'meshtastic', hops, isSelected, isRouter, roleCategory, shortName, showLabel:true, pinStyle})` | `selectionOpacity(markerAgeOpacity, emphasized)` | `{click: ()=>setSelected(...)}` | default (openPopup) | `<Popup pane="popupPane"><DashboardNodePopup/></Popup>` |

MeshCore is the proof the ONE factory carries source-tech difference as a parameter (`variant:'meshcore'` + `fixedColor` + `labelName`), not a parallel implementation.

---

## 4. File-by-file changes

### Created
- `src/components/map/markerIcons.ts` — moved contents of `src/utils/mapIcons.ts` + new `variant`/`fixedColor`/`labelName` on `createNodeIcon` + `createTracerouteEndpointIcon`. (+ `markerIcons.test.ts`)
- `src/components/map/layers/NodeMarkersLayer.tsx` — §3 shared layer. (+ `NodeMarkersLayer.test.tsx`)

### Modified
- `src/utils/mapIcons.ts` — becomes `export * from '../components/map/markerIcons';` (re-export shim; keeps EmbedMap/MapLegend/all importers transparent). Its existing test `src/utils/mapIcons.test.ts` either stays (tests the re-export) or moves next to the factory — keep it passing.
- `src/components/NodesTab.tsx` — **delete** `SpiderfierController` mount (L2270), `handleMarkerRef` + `_meshNodeId` tagging (L895), the listener-setup effect (L1082–1154+), the `_openPopup` strip effect (L1389–1398), `nodeIcons`/`nodePositions` batch memos (or keep as descriptor inputs); build `NodeMarkerDescriptor[]` and render `<NodeMarkersLayer markers={...} onOmsClick={richHandler}/>`. Preserve: all marker filters, `mouseover`/`mouseout` dim, opacity, zIndexOffset, `MapContext` refs, `<Popup>` content (Phase 5). Biggest surgery — see §7.
- `src/components/Dashboard/DashboardMap.tsx` — delete `SpiderfierController` mount, `spiderfierRef`, `getMarkerRef`/`stableIcon`/`stablePosition`/caches, `renderedKeysSig` effect, OMS retry effect, `_openPopup` strip; build descriptors + render `<NodeMarkersLayer/>`. Keep `markerKey` recipe, `ageOpacity`, `DashboardNodePopup` child.
- `src/components/MeshCore/MeshCoreMap.tsx` — **delete `makeIcon` (L76)** and all spiderfy/cache/strip scaffolding (L135–383); build descriptors with `createNodeIcon({variant:'meshcore',…})` + render `<NodeMarkersLayer/>`. Keep Tooltip/Popup children, node-type filter, path/neighbor/history polylines.
- `src/components/MapAnalysis/layers/NodeMarkersLayer.tsx` — becomes a **thin adapter** (preserves its test location, mirroring P3's analysis-traceroute pattern): map `useAnalysisNodes()` → `NodeMarkerDescriptor[]` and render the shared `src/components/map/layers/NodeMarkersLayer`. Keep `keyOf`, hop lookup, time-slider fade, selection-dim opacity, `setSelected` click, `handleSourceSelect`, `DashboardNodePopup` child. Delete its local spiderfy/cache/strip internals (now in the shared layer).
- `src/components/TracerouteWidget.tsx` — replace local `createNodeIcon` (L329) with imported `createTracerouteEndpointIcon(role)`; delete the `TODO(#4047 Phase 4)` (D3); markers stay pixel-identical.

### Deleted (implementations, not behavior)
- MeshCoreMap `makeIcon`; NodesTab `handleMarkerRef`/`_meshNodeId`/listener-setup/strip; Dashboard & MeshCore spiderfy scaffolding; MapAnalysis layer's local spiderfy/cache; TracerouteWidget local `createNodeIcon` body + stale TODO. `SpiderfierController` itself is retained (still exported/tested) but unused by the four maps — flag to orchestrator whether to delete after Phase 7 confirms no other consumer.

---

## 5. Approved-visible-changes list

**EMPTY.** Phase 4 is a pure refactor. Every node marker on NodesTab, DashboardMap, MeshCoreMap, and MapAnalysis — and the TracerouteWidget endpoint dots — must render **pixel-identical** to the pre-migration baseline (icon geometry, color, anchor, label, selection/animate, opacity, spiderfy fan, popup-open behavior). Any visible difference is a regression to be fixed before the PR. (Contrast Phase 3, which shipped an enumerated visible-change set; Phase 4 ships none.)

Parity guaranteed by construction: Meshtastic callers pass identical `createNodeIcon` options (unchanged code path); MeshCore `variant:'meshcore'` branch is the moved `makeIcon` verbatim; endpoint dots relocated verbatim; spiderfy tuning already shared.

---

## 6. Test plan

### Preserve / update
- `src/utils/mapIcons.test.ts` — keep green (now exercises the re-export). If moved, re-point imports.
- `src/components/MapAnalysis/layers/NodeMarkersLayer.test.tsx` — adapter still renders one Marker per node, hop shading, selection, source-select; adjust for delegation to the shared layer.
- `src/hooks/useMarkerSpiderfier.test.tsx`, `src/components/SpiderfierController.test.tsx` — unchanged (primitives untouched).
- `src/components/Dashboard/DashboardMap.test.tsx` — update marker assertions to the shared-layer output; keep source-select/popup coverage.

### New
- `src/components/map/markerIcons.test.ts` — **parity snapshots**: `variant:'meshcore'` output byte-equals the old `makeIcon` (glyph branch + "MC" fallback branch + name pill + `iconSize`/`iconAnchor`/`className`); `variant:'meshtastic'` meshmonitor + official branches unchanged (hop color, anchors, label placement, selected 60px, animate/highlight classes); `createTracerouteEndpointIcon` from/to/hop colors+sizes. Assert `fixedColor` overrides `getHopColor`.
- `src/components/map/layers/NodeMarkersLayer.test.tsx` — renders one `<Marker>` per descriptor; icon rebuilds only when `iconSig` changes (cache hit returns same ref); position ref stable across identical re-render (#3685); `renderedKeysSig` removal evicts caches; default `onOmsClick` opens popup; custom `onOmsClick` receives `(marker,key)`; `_openPopup` strip gated by `stripLeafletAutoPopup`. (Note: OMS is mocked — these do NOT prove real fan behavior; see browser gate.)

### Browser validation (the real spiderfy/obscured-marker gate — mandatory, per memory)
On the dev container, against pre-migration screenshots, verify on **all four maps**:
1. Markers render identically (color, size, label, glyph, selection highlight, MeshCore mauve badge + name pill).
2. Co-located pile **fans out** on click (spiderfy), stays fanned (`keepSpiderfied`), and each fanned marker is individually clickable.
3. Clicking a fanned/standalone marker opens its popup; clicking a pile does NOT plant a popup on the stacked marker (#4015 obscured-marker fix).
4. Fan does NOT auto-collapse after a poll refresh (#3685).
5. NodesTab: marker hover dims unrelated polylines; rich click still selects + centers + opens popup; animate pulse + zIndex raise intact.
6. MapAnalysis: time-slider age fade + selection dim intact.

### Gate
Full Vitest `success:true` (verify via `--reporter=json` — rtk line masks suite-collection failures, per memory). `npm run lint:ci` exits 0 (no baseline growth; **no new `any`**). typecheck clean.

---

## 7. Work packages (Sonnet-sized, disjoint, ordered)

### WP1 — Icon factory move + unify *(no deps)*
Files: `src/components/map/markerIcons.ts` (new, moved), `src/utils/mapIcons.ts` (shim), `src/components/map/markerIcons.test.ts` (new), `src/utils/mapIcons.test.ts` (keep green). **Acceptance:** factory moved + re-export shim; `variant:'meshcore'`/`fixedColor`/`labelName` added with parity snapshot vs `makeIcon`; `createTracerouteEndpointIcon` added; all importers (EmbedMap/MapLegend/NodesTab/Dashboard/MapAnalysis/MeshCore) compile unchanged; suite+lint+typecheck green. No consumer wired yet.

### WP2 — Shared `NodeMarkersLayer` + tests *(deps: WP1)*
Files: `src/components/map/layers/NodeMarkersLayer.tsx` (+test). **Acceptance:** layer owns spiderfy (direct `useMarkerSpiderfier`), stable caches, reconciliation, OMS-click (default+custom), `_openPopup` strip, first-mount flush; typed, no `any`; tests per §6; no consumer wired. suite+lint green.

### WP3 — MapAnalysis adapter migration *(deps: WP2)* — lowest risk, do first
Files: `src/components/MapAnalysis/layers/NodeMarkersLayer.tsx`, its test. **Acceptance:** file becomes a thin descriptor adapter over the shared layer; keyOf/hop/fade/selection-dim/click/source-select/popup preserved; browser-validated on Map Analysis; suite green. (This is the closest analog to the shared layer — validates the API before the harder hosts.)

### WP4 — MeshCoreMap migration *(deps: WP2; parallel to WP3)*
Files: `src/components/MeshCore/MeshCoreMap.tsx`. **Acceptance:** `makeIcon` deleted; markers via `createNodeIcon({variant:'meshcore'})` + shared layer; Tooltip/Popup/filters/polylines intact; badge + name pill pixel-identical; spiderfy fans (this map's fix preserved); browser-validated; suite green.

### WP5 — DashboardMap migration *(deps: WP2; parallel to WP3/WP4)*
Files: `src/components/Dashboard/DashboardMap.tsx`, its test. **Acceptance:** spiderfy scaffolding deleted; descriptors + shared layer; ageOpacity/markerKey/DashboardNodePopup intact; browser-validated; suite green.

### WP6 — NodesTab migration *(deps: WP2; LAST, highest risk)*
Files: `src/components/NodesTab.tsx`. **Acceptance:** SpiderfierController/handleMarkerRef/`_meshNodeId`/listener-setup/strip/batch-icon-memo deleted; descriptors + shared layer with rich `onOmsClick`; all filters, mouseover/mouseout dim, opacity, zIndex, MapContext refs, popup content preserved; browser-validated exhaustively (§6 items 1–5); suite green.

### WP7 — TracerouteWidget endpoint dots + TODO *(deps: WP1)*
Files: `src/components/TracerouteWidget.tsx`. **Acceptance:** local `createNodeIcon` replaced by `createTracerouteEndpointIcon`; TODO deleted; markers pixel-identical; suite green.

**Dependency graph:** WP1 → WP2 → {WP3 ∥ WP4 ∥ WP5 ∥ WP6}; WP7 depends only on WP1. WP6 last. Each host WP re-runs the full suite + browser-validates before its slice.

---

## 8. Risks & gotchas

- **NodesTab is the hard one (WP6).** Its spiderfy bridge is bespoke: `handleMarkerRef` tags `_meshNodeId`, and the OMS click handler (selection + centerMapOnNode + conditional openPopup with `autoPan=false`) reads that tag. Moving to the keyed layer, `onOmsClick(marker, key)` replaces the tag lookup — verify selection/centering/popup still fire, especially the `showRoute` branch that defers zoom to `TracerouteBoundsController`. `MapContext`-fed refs (`processedNodesRef`, `showRouteRef`, `traceroutesRef`, `centerMapOnNodeRef`) must be captured in the consumer's `onOmsClick`, not the layer.
- **Obscured-marker fix (#4015, commits 40b6b1e6/ade691b1)** = OMS-click-only popup + `_openPopup` strip. The strip MUST run every render with a per-marker `_meshPopupStripped` tag (NodesTab/MeshCore proved a `renderedKeysSig`-keyed strip runs before markers mount and never re-fires). Centralize this exact variant in the layer.
- **#3685 fan-collapse:** stable position/icon refs across polls. The layer's caches (keyed by stable key + iconSig, opacity applied via leaflet prop not icon) preserve it. Selection/age-opacity must NEVER enter `iconSig`.
- **Marker-ref timing (memory):** `<Marker ref>` fires in the commit BEFORE the hook's init effect. `useMarkerSpiderfier` already buffers via `pendingRef` and flushes on spiderfier creation — the layer relies on this; do not reintroduce a per-host retry loop.
- **Spiderfy tests mock OMS (memory)** → they cannot catch fan/obscured-marker regressions. Browser validation on all four maps is the binding gate, not the unit suite.
- **React re-render cost at 3000+ markers:** NodesTab renders every node. Keep the per-key icon/position caches (avoid `setIcon`/`setLatLng` churn); do NOT introduce a new full rebuild. The layer's cache must be at least as cheap as today's memoized Maps.
- **MeshCore no `popupAnchor`:** `makeIcon` omits it (center-anchored 24px). Preserve exactly in the `variant:'meshcore'` branch, or the MeshCore popup shifts.
- **MapAnalysis popup `pane="popupPane"`** and MeshCore Tooltip+Popup are consumer children — the layer passes `children` through untouched (Phase 5 owns content).
- **No new `any`; lint baseline must not grow.** Type descriptors, the OMS callback (`LeafletMarker`), and the leaflet `_openPopup`/`_meshPopupStripped` private access via a local narrowing type (as the current code does), not `any`.
- **`getNodeTypeCategory` input shape differs per host** (`{advType}` for MeshCore, full node for MapAnalysis) — the consumer computes `roleCategory` and passes it; the factory never touches raw node data.

---

## 9. Orchestrator decisions to confirm before WP1

1. **D1** factory home = `src/components/map/markerIcons.ts` + re-export shim (recommend yes).
2. **D2** additive extension of `createNodeIcon` (recommend yes).
3. **D3** Widget endpoint dots: keep green/blue/gray semantic, relocate into factory module, delete TODO — zero pixel change (recommend yes; flag if orchestrator wants theme-match instead, which changes pixels and would move to the §5 approved list).
4. **D4** shared layer owns `useMarkerSpiderfier` directly, retiring `SpiderfierController` for the four maps (recommend yes). Decide whether to delete `SpiderfierController.tsx` now or after Phase 7.
5. **D5** WaypointsLayer `emojiDivIcon` out of scope (recommend yes).
6. Confirm the **empty approved-visible-changes list** (§5) is the intended bar — Phase 4 ships no pixel changes.
</content>
</invoke>


---

## Orchestrator resolutions (gate review 2026-07-10)

- **Pure-refactor property CONFIRMED as binding:** the approved-visible-changes list is
  empty. Any pixel difference on any map is a regression.
- **D3 → Option A:** widget endpoint dots keep their current colors, relocated verbatim
  into the factory (`createTracerouteEndpointIcon`). The Phase-3 `TODO(#4047 Phase 4)`
  comment is REPLACED with a constraint comment: endpoint colors encode endpoint
  identity (from/to), deliberately distinct from the theme leg color — not drift.
- **D4 → delete `SpiderfierController` in this phase** once WP4–WP6 land (its only
  consumers are NodesTab/Dashboard/MeshCore; MapAnalysis already uses the hook).
  Dead code does not wait for Phase 7.
- The centralized `_openPopup` strip must be the every-render variant (NodesTab's
  documented pattern at NodesTab.tsx:1386) — verified duplicated in MeshCoreMap:371.
