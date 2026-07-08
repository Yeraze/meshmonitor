# Phase 1 Implementation Spec — Node Selection & Emphasis (issue #3788)

**Branch/worktree:** `feature/3788-node-select` @ `/home/yeraze/Development/meshmonitor-3788-p1`
**Scope:** Frontend only. No backend, schema, migration, or API change. No new `any`. No raw `fetch()` in components/pages.
**Goal:** Add a node multi-select to the `/analysis` toolbar; store `selectedNodeIds: string[]` in `MapAnalysisConfig` (persisted); when non-empty, dim unselected markers **and** trails; selection keyed on `mt:<nodeNum>` / `mc:<publicKey>` — the exact identity `mergeUnifiedSourceData` uses.

---

## 1. Reuse inventory (verified in worktree)

| Symbol | File:line | How Phase 1 uses it |
|---|---|---|
| `MapAnalysisConfig` (type) | `src/hooks/useMapAnalysisConfig.ts:40-52` | **Extend** with `selectedNodeIds: string[]`. |
| `DEFAULT_CONFIG` | `src/hooks/useMapAnalysisConfig.ts:58-75` | **Extend** with `selectedNodeIds: []`. |
| `load()` | `src/hooks/useMapAnalysisConfig.ts:87-103` | **Extend** to coerce a missing/garbage `selectedNodeIds` to `[]` (old-config safety). |
| `useMapAnalysisConfig()` | `src/hooks/useMapAnalysisConfig.ts:113-179` | **Add** setter `setSelectedNodeIds`; expose in return object. `reset()` already clears via `DEFAULT_CONFIG`. |
| `useMapAnalysisCtx()` / `MapAnalysisProvider` | `src/components/MapAnalysis/MapAnalysisContext.tsx:39-54` | **No edit needed.** Ctx type is `ReturnType<typeof useMapAnalysisConfig> & {…}`, so `config.selectedNodeIds` + `setSelectedNodeIds` propagate automatically. |
| `MapAnalysisToolbar` | `src/components/MapAnalysis/MapAnalysisToolbar.tsx:34-170` | **Edit** to mount the new `NodeMultiSelect` next to `NodeSearchControl`. |
| `SourceMultiSelect` (pattern) | `src/components/MapAnalysis/SourceMultiSelect.tsx:1-43` | **Template** for the new control (pill + `.map-analysis-source-popover` + Clear). Reuses existing CSS classes — no new CSS required. |
| `NodeTypeFilterControl` (pattern) | `src/components/MapAnalysis/NodeTypeFilterControl.tsx` | Secondary pattern (Show-all button, `useState(open)`). |
| `useDashboardUnifiedData(sources, enabled)` | `src/hooks/useDashboardData.ts:436-499` | Node feed for the picker + markers (already used by markers layer). Pass **full source objects** so merged `sources[]` is stamped. |
| `mergeUnifiedSourceData` | `src/hooks/useDashboardData.ts:332-427` | **Refactor** its inline `mt:`/`mc:` keying (lines 359-374) to call the new `unifiedNodeKey` helper — single source of truth. |
| `useDashboardSources()` | `src/hooks/useDashboardData.ts` | Source list (already used by toolbar + markers + trails). |
| `resolveNodeLatLng` / `MaybePositionedNode` | `src/components/MapAnalysis/nodePositionUtil` | Position resolution for the shared node hook. |
| `nodeMatchesSearch` | `src/components/MapAnalysis/nodeSearch` | Search filter (reused by shared node hook). |
| `getNodeTypeCategory` | `src/utils/nodeTypeCategory` | Type filter (reused by shared node hook). |
| `NodeMarkersLayer` filter block | `src/components/MapAnalysis/layers/NodeMarkersLayer.tsx:160-179` | **Extract** into `useAnalysisNodes()` so picker + markers share one filter; then **apply dimming** (opacity multiply) at the `<Marker opacity>` prop (:261). |
| `markerAgeOpacity` / `MIN_MARKER_OPACITY` | `src/utils/markerAgeOpacity` | Existing marker opacity; dimming multiplies on top (no conflict). |
| `PositionTrailsLayer` | `src/components/MapAnalysis/layers/PositionTrailsLayer.tsx:26-109` | **Apply dimming** at the `<Polyline pathOptions.opacity>` (:93). |

**Genuinely new files (justified):**
- `src/utils/nodeIdentity.ts` — no identity-key helper exists today; keying is inlined in the merge and cannot be imported. A neutral `utils` home lets both the hook (`useDashboardData`) and the MapAnalysis components import it without an inverted dependency (component-dir → hook).
- `src/components/MapAnalysis/useAnalysisNodes.ts` — extracts the duplicated markers filter so the picker and the map agree on identity/visibility (reuse, not duplication).
- `src/components/MapAnalysis/NodeMultiSelect.tsx` — the toolbar control (mirrors `SourceMultiSelect`).

---

## 2. Canonical node-identity helper

**There is NO existing reusable helper.** Verified:
- `mergeUnifiedSourceData` inlines the keying (`useDashboardData.ts:359-374`): MeshCore → `mc:${publicKey}` (fallback `mc:${nodeId}`); Meshtastic → `mt:${nodeNum}`.
- `NodeMarkersLayer.keyOf` (`:136-137`) is a **different** *spiderfier* key (`mc:${nodeId}` / `${sourceId}:${nodeNum}`) — **do NOT reuse it for selection.**

**Add** `src/utils/nodeIdentity.ts`:

```ts
export interface IdentifiableNode {
  nodeNum?: number | null;
  isMeshCore?: boolean | null;
  publicKey?: string | null;
  nodeId?: string | null;
}

/** Canonical cross-source node key — MUST match mergeUnifiedSourceData's keying. */
export function unifiedNodeKey(n: IdentifiableNode): string | null {
  if (n.isMeshCore) {
    if (typeof n.publicKey === 'string' && n.publicKey.length > 0) return `mc:${n.publicKey}`;
    if (typeof n.nodeId === 'string' && n.nodeId.length > 0) return `mc:${n.nodeId}`;
    return null;
  }
  if (typeof n.nodeNum === 'number') return `mt:${n.nodeNum}`;
  return null;
}

/** Dim factor applied to unselected markers/trails when a selection is active. */
export const SELECTION_DIM_OPACITY = 0.3;

/** With an empty selection everything is full-emphasis; otherwise only members are. */
export function isNodeEmphasized(key: string | null, selectedNodeIds: readonly string[]): boolean {
  if (selectedNodeIds.length === 0) return true;
  return key != null && selectedNodeIds.includes(key);
}

/** Base opacity scaled down when the node is not emphasized. */
export function selectionOpacity(base: number, emphasized: boolean): number {
  return emphasized ? base : base * SELECTION_DIM_OPACITY;
}
```

**Refactor** `mergeUnifiedSourceData` (`useDashboardData.ts:359-374`) to call `unifiedNodeKey(n)` instead of the inline block, so the two can never drift. (The raw per-source node record carries `isMeshCore`/`publicKey`/`nodeNum`/`nodeId`; `mergeNodeRecords` at :257-291 copies all of those onto the merged record, so `unifiedNodeKey` works identically on raw and merged nodes.)

---

## 3. File-by-file changes

### 3a. `src/hooks/useMapAnalysisConfig.ts` (modify)
- `MapAnalysisConfig`: add `selectedNodeIds: string[];`.
- `DEFAULT_CONFIG`: add `selectedNodeIds: [],`.
- `load()`: after the existing spreads, add an explicit coercion so an old persisted config (no field) or garbage does not crash:
  ```ts
  selectedNodeIds: Array.isArray(parsed.selectedNodeIds) ? parsed.selectedNodeIds : [],
  ```
  (Placed inside the returned object literal, after `timeSlider: …`.) The `{ ...DEFAULT_CONFIG, ...parsed }` already backfills it to `[]`; this line hardens against a non-array value.
- Add setter, mirroring `setSources` (:154-156):
  ```ts
  const setSelectedNodeIds = useCallback((ids: string[]) => {
    setConfig((prev) => ({ ...prev, selectedNodeIds: ids }));
  }, []);
  ```
- Add `setSelectedNodeIds` to the returned object (:168-178).

**No migration needed** — persistence is localStorage; old configs load safely (see exit criteria "persists across reload").

### 3b. `src/utils/nodeIdentity.ts` (new) — see §2.

### 3c. `src/hooks/useDashboardData.ts` (modify) — refactor merge keying to `unifiedNodeKey` (see §2).

### 3d. `src/components/MapAnalysis/useAnalysisNodes.ts` (new)
Extract the markers filter so picker and map share identity + visibility. Returns positioned, filtered nodes (position required — these are the nodes that can be emphasized/followed, keeping picker ⇄ map in agreement).

```ts
// Signature (implementation mirrors NodeMarkersLayer.tsx:139-179 exactly)
export interface AnalysisNode { node: NodeRecord; latLng: [number, number]; key: string; }
export function useAnalysisNodes(): AnalysisNode[]
```
- Internally: `useDashboardSources()` → full source objects; `useDashboardUnifiedData(sources, sourceIds.length > 0)`; then the same predicate as markers (`hideFromMap`, `nodeMatchesSearch(node, nodeFilter)`, `config.nodeTypes[getNodeTypeCategory(node)] !== false`, and the `config.sources` allow-list over `node.sources[]`). Attach `key = unifiedNodeKey(node)`; drop nodes whose `key` is `null`.
- `NodeRecord` type: reuse the interface currently declared in `NodeMarkersLayer.tsx:21-35` — **move it into this hook file and re-export**, so the markers layer imports it from here (avoids duplication). Add `publicKey?: string | null;` to it (needed by `unifiedNodeKey`; safe additive field).

### 3e. `src/components/MapAnalysis/layers/NodeMarkersLayer.tsx` (modify)
- Replace the inline `filteredNodes` computation (:160-179) with `const analysisNodes = useAnalysisNodes();`. Keep all spiderfy machinery unchanged (it still iterates the returned `{node, latLng}` list; `keyOf` for the spiderfier stays as-is — that is a separate concern from selection identity).
- Read selection: `const { config } = useMapAnalysisCtx();` → `config.selectedNodeIds`.
- At the `<Marker>` (:255-261), dim: compute
  ```ts
  const emphasized = isNodeEmphasized(unifiedNodeKey(n), config.selectedNodeIds);
  const finalOpacity = selectionOpacity(markerOpacity, emphasized);
  ```
  and pass `opacity={finalOpacity}`. **Dimming is via the leaflet `opacity` prop only** — do NOT fold it into `iconSig`/the divIcon, so the spiderfy fan and icon cache do not churn (react-leaflet applies opacity via `setOpacity`, no marker recreation). Empty selection → `emphasized` always true → `finalOpacity === markerOpacity` (today's behavior).

### 3f. `src/components/MapAnalysis/layers/PositionTrailsLayer.tsx` (modify)
- Read `config.selectedNodeIds` from `useMapAnalysisCtx()` (already destructures `config`).
- Trail rows carry only `{sourceId, nodeNum}` (the `/api/analysis/positions` feed is Meshtastic lat/lon telemetry keyed by `nodeNum` — `analysis.ts` getPositions; MeshCore does not populate this layer). So the trail identity is `unifiedNodeKey({ nodeNum: t.nodeNum, isMeshCore: false })` → `mt:${nodeNum}`. A `mc:` selection correctly never matches a trail (MeshCore has no trail here) — graceful.
- At the `<Polyline>` (:90-93): `const emphasized = isNodeEmphasized(\`mt:${t.nodeNum}\`, config.selectedNodeIds);` and set `pathOptions={{ color: t.color, weight: 2, opacity: selectionOpacity(0.7, emphasized) }}`. `pathOptions` is already recomputed inline each render — no caching concern.

### 3g. `src/components/MapAnalysis/NodeMultiSelect.tsx` (new)
Mirror `SourceMultiSelect` (pill + `.map-analysis-source-popover`, reuse existing classes). Props:
```ts
interface NodeMultiSelectProps {
  nodes: Array<{ key: string; label: string }>;  // deduped, sorted
  value: string[];
  onChange: (next: string[]) => void;
}
```
- Pill label: `value.length === 0 ? 'All nodes' : \`${value.length} selected\`` (only counts keys still present optional; keep simple).
- Popover: one checkbox per node (`checked={value.includes(n.key)}`, toggle like SourceMultiSelect:15-17).
- **Select all**: `onChange(nodes.map(n => n.key))`. **Clear**: `onChange([])` (shown when `value.length > 0`).
- Long lists: include an internal text filter input inside the popover (optional; the global `NodeSearchControl` already narrows `nodes` upstream — acceptable to ship without it).

### 3h. `src/components/MapAnalysis/MapAnalysisToolbar.tsx` (modify)
- `const { config, …, setSelectedNodeIds } = useMapAnalysisCtx();`
- `const analysisNodes = useAnalysisNodes();`
- Build deduped, sorted options:
  ```ts
  const nodeOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const { key, node } of analysisNodes) {
      if (!byKey.has(key)) byKey.set(key, node.longName || node.shortName || node.nodeId || key);
    }
    return [...byKey].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [analysisNodes]);
  ```
- Mount after `<NodeSearchControl />` (:113):
  ```tsx
  <NodeMultiSelect nodes={nodeOptions} value={config.selectedNodeIds} onChange={setSelectedNodeIds} />
  ```

---

## 4. Test plan (Vitest, standard suite — no standalone scripts)

1. **`src/utils/nodeIdentity.test.ts` (new)**
   - `unifiedNodeKey`: Meshtastic `{nodeNum:5}` → `mt:5`; MeshCore `{isMeshCore:true, publicKey:'ab'}` → `mc:ab`; MeshCore `{isMeshCore:true, nodeId:'mc:x'}` (no key) → `mc:mc:x`; MeshCore with neither → `null`; Meshtastic missing `nodeNum` → `null`.
   - **Drift guard:** feed a small `perSource` array through `mergeUnifiedSourceData` and assert each merged node's key (recomputed via `unifiedNodeKey`) is what the merge bucketed on (one Meshtastic, one MeshCore across two sources → 2 nodes, keys `mt:*`/`mc:*`).
   - `isNodeEmphasized`: empty selection → `true` for any key incl. `null`; non-empty → `true` only for members; `null` key with non-empty selection → `false`.
   - `selectionOpacity`: `(1, true) === 1`; `(1, false) === SELECTION_DIM_OPACITY`; `(0.7, false) === 0.7 * SELECTION_DIM_OPACITY`.

2. **`src/hooks/useMapAnalysisConfig.test.ts` (extend)**
   - `DEFAULT_CONFIG.selectedNodeIds` is `[]`; fresh hook returns `[]`.
   - `setSelectedNodeIds(['mt:1','mc:ab'])` updates `config.selectedNodeIds` and persists (assert `JSON.parse(localStorage[KEY]).selectedNodeIds`).
   - **Old-config load:** seed `localStorage` with a valid `version:1` config JSON that omits `selectedNodeIds`; assert hook loads with `selectedNodeIds === []` and does not throw.
   - **Garbage coercion:** seed with `selectedNodeIds: "oops"`; assert coerced to `[]`.
   - `reset()` clears `selectedNodeIds` back to `[]`.

3. **`src/components/MapAnalysis/useAnalysisNodes.test.tsx` (new)** — mock `useDashboardUnifiedData` + `useDashboardSources` (pattern from `PositionTrailsLayer.test.tsx:25-27`). Provide a Meshtastic node (positioned), a MeshCore node (positioned, `isMeshCore`+`publicKey`), one unpositioned, one `hideFromMap`. Assert: returns only positioned+visible nodes; `key` values are `mt:*` / `mc:*`; source/type/search filters exclude as expected.

4. **`src/components/MapAnalysis/NodeMultiSelect.test.tsx` (new)** — render with 3 options + spy `onChange`. Assert: checking a box calls `onChange` with the `mt:`/`mc:` key added; unchecking removes it; **Select all** calls `onChange` with all keys; **Clear** calls `onChange([])` and only shows when `value` non-empty.

5. **`src/components/MapAnalysis/layers/PositionTrailsLayer.test.tsx` (extend)** — change the `Polyline` mock to capture opacity: `Polyline: (p) => <div data-testid="poly" data-opacity={p.pathOptions?.opacity} />`. With mock trails for nodeNum 1 & 2 and `selectedNodeIds:['mt:1']` (seed via localStorage config), assert the `mt:1` polyline has `data-opacity === "0.7"` and the `mt:2` polyline has the dimmed value (`0.7 * SELECTION_DIM_OPACITY`). Empty selection → both `0.7` (existing test still green).

6. **Marker dimming** — proven at the pure-helper level (`isNodeEmphasized` + `selectionOpacity` in test #1). No `NodeMarkersLayer.test.tsx` exists today and the layer is spiderfy/leaflet-heavy; a full render test is out of scope. (Optional stretch: a thin render test mocking react-leaflet `Marker` to capture the `opacity` prop, same pattern as the trails test — include only if cheap.)

**Also:** `npm run typecheck` clean; `npm run lint:ci` exits 0 (no new `any`, no raw `fetch()` — all data via existing hooks).

---

## 5. Work-package decomposition

Sized for one Sonnet agent each. **WP-A is the foundation; WP-B/WP-C/WP-D depend on it and may run in parallel with each other.**

### WP-A — Identity helper + config field (foundation, do FIRST)
- Create `src/utils/nodeIdentity.ts` (§2) + `src/utils/nodeIdentity.test.ts` (test #1).
- Refactor `mergeUnifiedSourceData` keying to `unifiedNodeKey`; run `useDashboardData.test.ts` — must stay green.
- Extend `MapAnalysisConfig`/`DEFAULT_CONFIG`/`load()`/`useMapAnalysisConfig` with `selectedNodeIds` + `setSelectedNodeIds` (§3a) + extend `useMapAnalysisConfig.test.ts` (test #2).
- **Accept:** new + existing config/merge tests green; typecheck clean; `unifiedNodeKey` drift-guard passes.

### WP-B — Shared node hook + picker + toolbar wiring (depends on WP-A)
- Create `useAnalysisNodes.ts` (move/extend `NodeRecord`, add `publicKey`) + refactor `NodeMarkersLayer` to consume it (no behavior change to markers yet) (§3d/§3e-first-half).
- Create `NodeMultiSelect.tsx` (§3g); wire into toolbar (§3h).
- Tests #3 (`useAnalysisNodes`) + #4 (`NodeMultiSelect`).
- **Accept:** picker lists nodes from selected sources with select-all/clear; `NodeMarkersLayer.test`-adjacent suites + spiderfy tests still green; typecheck clean.

### WP-C — Marker dimming (depends on WP-A; parallel with WP-B, but touches NodeMarkersLayer → sequence after WP-B's markers refactor to avoid conflict, OR fold WP-C into WP-B)
- In `NodeMarkersLayer`, apply `selectionOpacity(markerOpacity, isNodeEmphasized(unifiedNodeKey(n), config.selectedNodeIds))` at the `opacity` prop only (§3e).
- **Accept:** with a non-empty `selectedNodeIds`, unselected markers render reduced opacity, selected full; empty selection unchanged; spiderfy fan intact; typecheck clean.

> **Sequencing note:** WP-B and WP-C both edit `NodeMarkersLayer.tsx`. Recommended: **merge WP-B and WP-C into a single agent** (the markers-layer refactor and its dimming land together), running in parallel with WP-D. If split, WP-C runs strictly after WP-B.

### WP-D — Trail dimming (depends on WP-A only; fully parallel)
- Apply trail dimming in `PositionTrailsLayer` (§3f); extend its test (test #5).
- **Accept:** selected trail full opacity, unselected dimmed; empty selection unchanged; existing trails tests green; typecheck clean.

**Final integration gate (after all WPs):** full Vitest suite 0 failures; `npm run typecheck` clean; `npm run lint:ci` exits 0; browser-validate on `/analysis` (pick Meshtastic + MeshCore nodes → unselected markers & trails dim, reload persists selection).
```
