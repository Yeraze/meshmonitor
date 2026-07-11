# Map Consolidation — Phase 5 Spec: Popup Unification

**Epic:** #4047 · **Phase:** 5 · **Branch:** `feature/4047-p5-popup-unify` (from `origin/4049-map-refactor`)
**Status:** Spec — no feature code written yet.
**Scope:** the node-info popups rendered by the app's node maps — NodesTab, DashboardMap, MapAnalysis, MeshCoreMap — **plus** the fixed-position chat overlay `NodePopup` (App.tsx sender-dot click), which is the third member of the "3 popup families" the epic survey named. EmbedMap popups are Phase 6/7 (out of scope). Traceroute-**segment** popups (recharts trees in `TraceroutePathsLayer`) are NOT node popups and are explicitly out of scope. Marker frames/spiderfy (Phase 4) are done — this phase is content-level only.

## 0. TL;DR for implementers

Today there are **four** node-info popup renderers that all show overlapping data with divergent chrome:

1. **`NodePopup`** (`src/components/NodePopup/NodePopup.tsx`) — **a fixed-position floating overlay, NOT a Leaflet map popup.** Opened by clicking a `.sender-dot` in chat (App.tsx:4503 `setNodePopup({nodeId, position:{x,y}})`), rendered once in App.tsx:5385 as `position:fixed` at mouse x/y. Its own stylesheet `NodePopup.css` uses **flat `.route-usage` rows** and *redefines* `.node-popup`, `.node-popup-tabs/-tab/-content/-traceroute/-no-traceroute/-danger-actions` — a parallel copy of the same class names nodes.css already defines (CSS drift/collision). Sole consumer of `NodePopup.css`.
2. **`MapNodePopupContent`** (`src/components/MapNodePopupContent.tsx`) — Leaflet `<Popup>` content, **NodesTab ONLY** (NodesTab.tsx:1493, gated on `!(showRoute && hasValidTraceroute)`). The `.node-popup-grid` card. **TO DELETE.**
3. **`DashboardNodePopup`** (`src/components/Dashboard/DashboardNodePopup.tsx`) — Leaflet `<Popup>` content, the **canonical card** since #3692. Consumers: DashboardMap:449, MapAnalysis `layers/NodeMarkersLayer.tsx`:172. Same `.node-popup-grid` chrome + "Seen by N sources" list.
4. **MeshCoreMap inline `<Popup>`** (`MeshCoreMap.tsx:258`) — inline-styled, **no `.node-popup` classes at all**; MeshCore-specific fields (key/RSSI/SNR/path/route/last-seen + "More Details").

Phase 5:

- **One content family** at `src/components/map/popups/`: a `NodeCard` chrome (`.node-popup` header + optional tab bar + `.node-popup-content` body) + a **section registry** of data-driven components + a per-source-tech **normalizer** (`toNodeCardModel`). Meshtastic vs MeshCore differences (hops/SNR/battery/hardware vs path-length/scope/key) become **section composition**, never separate components (per the user directive).
- **`MapNodePopupContent` is deleted**; NodesTab renders the family.
- **MeshCore's inline popup joins the family** (gains `.node-popup` chrome; keeps its Tooltip + all fields).
- **`DashboardNodePopup` is reconciled** into the family (it becomes a thin composition; canonical grid wins).
- **`NodePopup` is reconciled**: its fixed-overlay *frame* is legitimately different (a chat overlay, not a map anchor) and **survives as a frame**, but its *content* converges onto the canonical grid family — `NodePopup.css`'s flat `.route-usage` treatment and its duplicate class defs are deleted. Canonical `.node-popup-grid` (nodes.css) **wins** over `NodePopup.css`.

**This phase is NOT a pure refactor.** It ships an enumerated approved-visible-changes set (§4): MeshCore popup restyle, NodePopup restyle. NodesTab's popup and DashboardNodePopup must stay **pixel/byte-identical** (they are already the canonical card). Capability LOSS is forbidden — every field/action any current popup shows maps to a family section (§2.4 preservation matrix).

## 0.1 Premise verification (Phase-2 lesson: premises first)

All four epic-survey premises **verified accurate**, with three material corrections:

- **CORRECTION A — `NodePopup` is not a map popup.** The survey lists it among "popups," but it is a `position:fixed` chat overlay (sender-dot → App.tsx), not a Leaflet `<Popup>`. This changes the reconciliation verdict (§0.1-B) and means it needs a distinct *frame*, not just content. Triggers live in `MessagesTab.tsx`, `ChannelsTab.tsx`, `UIContext.tsx`, `App.tsx`.
- **CORRECTION B — reconciliation verdict for `NodePopup` vs `DashboardNodePopup`: BOTH drift AND genuine-frame-difference.** The *frame* genuinely differs (fixed overlay vs leaflet-anchored). The *content* is drift: `NodePopup` re-implements the same Meshtastic node card in `route-usage` flat rows via `NodePopup.css`, which **redefines the same `.node-popup*` class names** nodes.css owns (a live CSS collision resolved only by import order — a latent bug). **Canonical grid card (nodes.css) wins; `NodePopup.css` is deleted.**
- **CORRECTION C — `DashboardNodePopup` is NOT i18n-wrapped** (0 `t()` calls; hardcoded English: "Seen by", "hops", …), whereas `MapNodePopupContent` and `NodePopup` use `t()` with `node_popup.*` keys (defined in `public/locales/*.json`). Converging on the family means the sections use `t()`; **English output stays byte-identical**, and DashboardNodePopup *gains* translation (a capability gain, §4).

Confirmed accurate: `MapNodePopupContent` is NodesTab-only; `DashboardNodePopup` serves DashboardMap + MapAnalysis (#3692); MeshCore popup is inline JSX moved verbatim into a Phase-4 descriptor (`MeshCoreMap.tsx:258`); no node-marker popup uses `DraggablePopup` (it's used only by `TraceroutePathsLayer` segment popups + `DashboardSidebar` — both out of scope).

## 0.2 Orchestrator decisions — proposed (gate review needed)

| # | Question | Recommendation |
|---|---|---|
| D1 | Family home directory? | **`src/components/map/popups/`** (`NodeCard.tsx`, `sections.tsx`, `nodeCardModel.ts`, `+ tests`). Matches P3/P4 (`src/components/map/…`). |
| D2 | Is `NodePopup` (chat overlay) in Phase-5 scope, or deferred? | **In scope** — the task names it and it is a live CSS-collision drift of the canonical card. Migrate its *content* to the family; keep its *frame*. Sequenced LAST (highest risk, touches App.tsx), mirroring Phase-4's NodesTab ordering. Fallback: if the orchestrator wants tighter scope, defer NodePopup to a follow-up issue and land only the three map popups + family — but then the "families reconciled" exit is only partially met (flag). |
| D3 | Canonical card: which chrome wins? | **`.node-popup-grid` (nodes.css)** used by DashboardNodePopup/MapNodePopupContent. `NodePopup.css`'s `.route-usage` flat rows lose and the file is deleted; the overlay's fixed-frame positioning (currently inline in NodePopup.tsx) is preserved via a distinct **`.node-popup-overlay`** wrapper class. |
| D4 | Section granularity — one big `NodeCard` with boolean flags, or discrete section components composed by each consumer? | **Discrete section components + per-consumer composition list.** Matches the "section registry / composition" directive; keeps Meshtastic-only and MeshCore-only sections as data, not branches. |
| D5 | MeshCore popup: fold into `.node-popup` chrome (restyle) or keep inline? | **Fold in** (restyle — approved visible change §4). It is the whole point of "MeshCore popup content joins the family." Keep the separate `<Tooltip>` untouched (Phase-4 descriptor child). |
| D6 | `NodeCardModel` normalizer: one function with a `variant` discriminant, or per-consumer inline mapping? | **One `toNodeCardModel(raw, variant)`** in `nodeCardModel.ts` — subsumes DashboardNodePopup's `pick()` flat-or-nested coalescing; the MeshCore branch maps a contact. Consumers that need extra derived values (NodesTab `getEffectiveHops`, `isNodeComplete`) inject them via options. |
| D7 | `DashboardNeighborPopup` (neighbor-LINK popup) — in scope? | **No.** It is a link popup, not a node popup, though it reuses `.node-popup-*` chrome. Leave as-is; note it shares chrome so the family's chrome CSS must not regress it. |

---

## 1. Reuse inventory & feature matrix (serena/grep-verified 2026-07-10)

### 1.1 The four renderers — frame + data + chrome

| Renderer | Frame | Opened by | Data shape | Chrome / CSS | i18n |
|---|---|---|---|---|---|
| **NodePopup** | `position:fixed` div (inline style: left/top, `translateX(-50%) translateY(-100%)`, z-index 10002), click-outside close (App.tsx:4513, selector `.node-popup, .sender-dot`) | chat sender-dot → App.tsx:4503 | `DeviceInfo` looked up from `nodes` by `nodePopup.nodeId` | `.route-popup .node-popup` + **`NodePopup.css`** (flat `.route-usage` rows) | `t()` full |
| **MapNodePopupContent** | Leaflet `<Popup autoPan={false}>` | NodesTab marker (NodesTab.tsx:1493) | `DeviceInfo` (`node.user?.*`) | `.node-popup` + `.node-popup-grid` (nodes.css) | `t()` partial |
| **DashboardNodePopup** | Leaflet `<Popup>` (DashboardMap) / `<Popup pane="popupPane">` (MapAnalysis) | Dashboard & MapAnalysis markers | `node: any` flat-or-nested via `pick()`; `pos:{lat,lng}` | `.node-popup` + `.node-popup-grid` (nodes.css) | **none** (hardcoded EN) |
| **MeshCore inline `<Popup>`** | Leaflet `<Popup>` (+ sibling `<Tooltip>`) | MeshCoreMap marker (MeshCoreMap.tsx:258) | MeshCore contact `c` | **inline styles, no `.node-popup`** | none |

### 1.2 Field / section matrix (what each renderer shows)

Legend: ✅ shown · — absent · (note).

| Section / field | NodePopup | MapNodePopupContent | DashboardNodePopup | MeshCore popup |
|---|---|---|---|---|
| **Header** longName + shortName badge | ✅ (h4 + inline pill) | ✅ (title/subtitle divs) | ✅ (title/subtitle divs) | ✅ (name `<strong>`, no shortName) |
| **Tab bar** info \| traceroute | ✅ (perm-gated) | ✅ (perm-gated) | — | — |
| Node ID 🆔 | ✅ (`route-usage`) | ✅ (grid) | ✅ (grid, full) | ✅ (Key, first 16 chars) |
| Role 👤 | ✅ | ✅ | ✅ | — |
| Hardware 🖥️ | ✅ | ✅ (full) | ✅ (full) | "MeshCore Device" literal |
| Hops 🔗 | — | ✅ (`getEffectiveHops`, <999) | ✅ (`hopsAway`) | Path len (`hopCountLabel`) |
| SNR 📶 | ✅ (`toFixed(1)` dB, inline row) | — | ✅ (`{snr} dB`) | ✅ RSSI + SNR |
| Battery 🔋 | ✅ (101 ⇒ "🔌 Plugged In") | — | ✅ (`{battery}%`) | — |
| Altitude ⛰️ | — | ✅ | ✅ | — |
| Position 📍 lat,lng coords | — | — | ✅ (5-dp) | — |
| Route / outPath | — | — | — | ✅ |
| Last seen / heard 🕐 | ✅ (`formatDateTime`) | ✅ footer (`formatDateTime`) | ✅ footer (`formatRelativeTime`) | ✅ (`toLocaleString`) |
| **Sources** "Seen by N sources" | — | — | ✅ (clickable → `onSourceSelect`) | — |
| **Traceroute tab** fwd/return + run btn | ✅ + **View History** btn | ✅ (no history btn) | — | — |
| Action: More Details / DM 🔍 | ✅ (`onDMNode`) | ✅ (`onDMNode`) | — | ✅ ("More Details" → `onNavigateToDm`) |
| Action: Show on Map 🗺️ | ✅ (`onShowOnMap`) | — | — | — |
| Action: Copy NodeInfo 📋 | — | ✅ (`!isNodeComplete` && nodes.write) | — | — |
| Action: Delete 🗑️ | ✅ | ✅ | — | — |
| Action: Purge ⚠️ | ✅ (connected) | ✅ (connected) | — | — |

This matrix IS the section registry. Every ✅ cell must survive as a section the family can compose (§2.4).

### 1.3 CSS collision (the cascade gotcha for this phase)

`.node-popup` is defined **three times in nodes.css** (L1442 legacy `.popup-header/.popup-details` variant, L1510 mobile `@media`, L1791 the live scrollable map-card: max-height, custom scrollbar) **and again in `NodePopup.css` L2** (overlay: background/border/padding/min-max-width/box-shadow). Both stylesheets are global once any consumer imports them (`NodesTab` and `MapAnalysis/layers/NodeMarkersLayer` import nodes.css; `NodePopup` imports NodePopup.css). Today the overlay's final `.node-popup` styling is **decided by import order** — a latent bug. `NodePopup.css` also redefines `.node-popup-tabs/-tab/-content/-traceroute/-no-traceroute/-danger-actions` with values that differ from nodes.css. **Deleting `NodePopup.css` (D3) removes the collision**; the overlay frame must then carry a distinct `.node-popup-overlay` wrapper for its fixed-position box (background/border/shadow/min-max-width), and the App.tsx click-outside selector updates from `.node-popup` to `.node-popup-overlay` (or keeps `.node-popup` on the wrapper — see §5 risk). Remember the nodes.css ordering trap (base `.map-controls` declared *after* the mobile `@media`): any new rule added to nodes.css must go **after** the L1791 block, not into an earlier `@media`.

### 1.4 Existing tests
- `src/components/Dashboard/DashboardNodePopup.test.tsx` — asserts longName/shortName/ID/hops/altitude/coords/"Seen by 2 sources"/source-row click + disabled + absent-when-single.
- `src/components/Dashboard/DashboardNeighborPopup.test.tsx` — link popup (out of scope; must stay green — chrome regression guard).
- `src/components/MapAnalysis/MapAnalysisCanvas.test.tsx` — mocks `<Popup>`, asserts the marker popup renders `DashboardNodePopup` content incl. `/Seen by 2 sources/` (#3692). Update to the family output.
- `src/components/Dashboard/DashboardMap.test.tsx` — popup/source-select coverage.
- No dedicated `NodePopup.test.tsx` or `MapNodePopupContent.test.tsx` exists (grep-confirmed) — new family tests fill the gap.

---

## 2. Family API design — `src/components/map/popups/`

### 2.1 Chrome — `NodeCard.tsx`

```tsx
export interface NodeCardProps {
  model: NodeCardModel;
  /** Ordered content sections composed below the header (and inside the active tab). */
  sections: React.ReactNode;
  /** Optional tabbed layout. When present, `sections` is the INFO tab body and
   *  `tracerouteBody` is the TRACEROUTE tab body; a tab bar renders. */
  tracerouteBody?: React.ReactNode;
  /** extra class on the root (e.g. 'node-popup-overlay' for the fixed frame). */
  className?: string;
}
```

Renders exactly the canonical structure (byte-identical to today's `.node-popup` card):
```
<div className={`node-popup ${className ?? ''}`}>
  <NodeCardHeader model={model} />
  {tracerouteBody && <TabBar active=… />}     // only when tabs requested
  <div className="node-popup-content">{active tab ? sections : tracerouteBody}</div>
</div>
```
Tab state (`'info' | 'traceroute'`) lives in `NodeCard` (lifts the identical `useState` from MapNodePopupContent/NodePopup). No tabs ⇒ `sections` render directly in `.node-popup-content`.

### 2.2 Sections — `sections.tsx` (the registry)

Each is a pure component reading `NodeCardModel` (+ its own props), emitting the exact current markup/classes. All strings via `t()` with existing `node_popup.*` keys.

| Section | Emits | Used by (composition) |
|---|---|---|
| `NodeCardHeader` | `.node-popup-header` + title + `.node-popup-subtitle` badge | all |
| `IdentityItems` | grid items 🆔 ID, 👤 role, 🖥️ hardware(full) | all Meshtastic; MeshCore maps Key→ID |
| `SignalItems({showAltitude})` | grid items 🔗 hops(<999), 📶 snr, 🔋 battery, ⛰️ altitude | Meshtastic maps |
| `PositionItem` | grid item 📍 `lat,lng` (5-dp) | Dashboard/MapAnalysis |
| `LastHeardFooter({mode:'absolute'\|'relative'})` | `.node-popup-footer` 🕐 | all |
| `SourcesList({onSourceSelect})` | `.node-popup-sources` "Seen by N" clickable rows | Dashboard/MapAnalysis (unified) |
| `MeshCoreDetails` | grid items: Key, RSSI, SNR, Path, Route, last-seen | MeshCore |
| `TracerouteBody({recentTraceroute, onViewHistory?, onRunTraceroute?, …})` | `.node-popup-traceroute` fwd/return + optional History btn + run btn | NodePopup, NodesTab |
| `NodeActions({buttons})` | `.node-popup-btn` / `.node-popup-danger-actions` buttons | per-consumer |

`NodeActions` takes a typed button list so each consumer supplies exactly its set (More Details, Show on Map, Copy NodeInfo, Navigate-to-DM, Delete, Purge) — no boolean soup. The traceroute recency computation (`recentTraceroute` useMemo — identical logic in NodePopup L59 and MapNodePopupContent L58) moves to a shared `useRecentTraceroute(traceroutes, currentNodeId, node)` hook in `nodeCardModel.ts`.

Grid items reuse the existing `.node-popup-item` / `.node-popup-item-full` / `.node-popup-icon` / `.node-popup-value` classes verbatim.

### 2.3 Normalizer — `nodeCardModel.ts`

```ts
export interface NodeCardModel {
  longName: string; shortName?: string; nodeId?: string;
  roleName?: string | null; hwModelName?: string | null;
  hops?: number | null; snr?: number | null; battery?: number | null; altitude?: number | null;
  position?: { lat: number; lng: number };
  lastHeard?: number | null;            // epoch seconds
  sources?: NodeSourceRef[];
  meshcore?: { publicKey: string; rssi?: number; snr?: number; pathLen?: number; outPath?: string; lastSeen?: number };
}
export function toNodeCardModel(
  raw: unknown,
  variant: 'meshtastic' | 'meshcore',
  opts?: { effectiveHops?: number; pos?: { lat: number; lng: number } },
): NodeCardModel;
```
- `'meshtastic'`: subsumes `DashboardNodePopup.pick()` (flat-or-nested coalescing) — handles both `DeviceInfo` (`node.user?.*`) and unified merged nodes (flat `node.longName` + `node.sources`). Role/hardware name via `getRoleName`/`getHardwareModelName` (existing utils). `hops` from `opts.effectiveHops` when the consumer computes it (NodesTab), else `hopsAway`.
- `'meshcore'`: maps a contact → `{longName:name, meshcore:{publicKey,rssi,snr,pathLen,outPath,lastSeen}}`.

### 2.4 Composition per consumer (+ capability-preservation)

| Consumer | frame | tabs | INFO sections | traceroute | actions | model |
|---|---|---|---|---|---|---|
| **NodesTab** (was MapNodePopupContent) | leaflet `<Popup autoPan={false}>` | ✅ (perm) | Header, IdentityItems, SignalItems{altitude}, LastHeadFooter{absolute} | `TracerouteBody` (no history) | More Details, Copy NodeInfo, Delete, Purge | meshtastic, `effectiveHops` injected |
| **DashboardMap / MapAnalysis** (DashboardNodePopup) | leaflet `<Popup>` / `pane="popupPane"` | — | Header, IdentityItems, SignalItems{altitude}+battery+snr, PositionItem, LastHeardFooter{relative}, SourcesList | — | — | meshtastic (flat/nested), `pos` |
| **MeshCoreMap** | leaflet `<Popup>` (+ Tooltip) | — | Header, MeshCoreDetails, LastHeardFooter | — | Navigate to DM | meshcore |
| **NodePopup** (chat overlay) | `.node-popup-overlay` fixed div | ✅ (perm) | Header, IdentityItems, SignalItems (snr+battery, no altitude — preserve today's set) | `TracerouteBody` + **History** | More Details, Show on Map, Delete, Purge | meshtastic |

**Preservation matrix (no capability loss):** every ✅ in §1.2 appears in a cell above. Notably: NodePopup's **Show on Map** and **View History** ⇒ `NodeActions`/`TracerouteBody` props (kept, only for NodePopup). NodesTab's **Copy NodeInfo** (gated `!isNodeComplete && nodes.write`) ⇒ `NodeActions` button injected by NodesTab. MeshCore **Route/Key** ⇒ `MeshCoreDetails`. Sources list ⇒ `SourcesList`. MeshCore keeps its `<Tooltip>` unchanged (Phase-4 descriptor child).

---

## 3. File-by-file changes

### Created
- `src/components/map/popups/NodeCard.tsx` — chrome + tab host. (+ `NodeCard.test.tsx`)
- `src/components/map/popups/sections.tsx` — section registry (§2.2). (+ `sections.test.tsx`)
- `src/components/map/popups/nodeCardModel.ts` — `NodeCardModel`, `toNodeCardModel`, `useRecentTraceroute`, re-export `NodeSourceRef`. (+ `nodeCardModel.test.ts`)

### Modified
- `src/components/Dashboard/DashboardNodePopup.tsx` — becomes a **thin composition** over `NodeCard` (`toNodeCardModel(node,'meshtastic',{pos})` → Header+Identity+Signal+Position+LastHeard{relative}+Sources). Keep its export name/props (`node`, `pos`, `onSourceSelect`) so DashboardMap:449 & MapAnalysis:172 are untouched. `pick()` moves into `toNodeCardModel`. **Output byte-identical** (adds `t()` with EN-identical strings).
- `src/components/NodesTab.tsx` — replace `<MapNodePopupContent …/>` (L1494) with `<NodeCard …/>` composition (tabs; Identity+Signal+LastHeard{absolute}; TracerouteBody; actions More Details/Copy NodeInfo/Delete/Purge). Preserve `<Popup autoPan={false}>` frame, the `getEffectiveHops` injection, `isNodeComplete` gate, all handlers. Delete the `MapNodePopupContent` import (L47).
- `src/components/MeshCore/MeshCoreMap.tsx` — replace the inline `<Popup>` body (L258–293) with `<NodeCard model={toNodeCardModel(c,'meshcore')} sections={<>…MeshCoreDetails + Navigate-to-DM action…</>}/>`. Keep the `<Tooltip>` (L252) verbatim.
- `src/components/NodePopup/NodePopup.tsx` — keep the **fixed-frame wrapper** (`position:fixed` inline style + click-outside contract) but swap the inner body to `<NodeCard className="node-popup-overlay" tabs … />`. Delete `import './NodePopup.css'`. Preserve every prop/handler (Show on Map, View History, Delete, Purge, traceroute run).
- `src/App.tsx` — click-outside selector `.node-popup, .sender-dot` → `.node-popup-overlay, .sender-dot` (L4515) to match the wrapper (or add `node-popup-overlay` to the wrapper while keeping the selector — pick one; see risk R1).
- `src/styles/nodes.css` — add `.node-popup-overlay` fixed-frame rules (background/border/radius/padding/min-max-width/box-shadow — the salvaged base from NodePopup.css L2), appended **after** L1791 (ordering trap). If NodePopup previously relied on `.route-usage`/traceroute overlay-specific styling that differs from the grid, decide per-item (most should just disappear as the card converges).
- `src/components/MapAnalysis/MapAnalysisCanvas.test.tsx`, `src/components/Dashboard/DashboardNodePopup.test.tsx`, `src/components/Dashboard/DashboardMap.test.tsx` — update to the family output (assertions largely unchanged since chrome is preserved; see §5).

### Deleted
- `src/components/MapNodePopupContent.tsx` (+ no test exists). **Epic exit criterion.**
- `src/components/NodePopup/NodePopup.css` — its live `.node-popup*` styling is either subsumed by nodes.css (grid) or salvaged into `.node-popup-overlay`.

---

## 4. Approved-visible-changes list (this phase is NOT pure-refactor)

1. **MeshCore map popup restyle** — from inline-styled plain text to the canonical `.node-popup` card (header, grid items, footer, themed buttons/scrollbar). Same fields (name, Key/16, RSSI, SNR, Path, Route, last-seen, More Details). **Gain:** consistent chrome, shortName badge slot, theme styling. **No field lost.**
2. **NodePopup (chat overlay) restyle** — from `NodePopup.css` flat `.route-usage` rows to the canonical `.node-popup-grid` card in a `.node-popup-overlay` fixed frame. **Gains:** grid layout, icons, consistent buttons. **Preserved:** tabs, traceroute tab + **View History**, **Show on Map**, Delete/Purge, More Details, click-outside close, fixed positioning at cursor. Minor: SNR was `toFixed(1)` "X.X dB" inline; the grid `SignalItems` renders `{snr} dB` — **keep `toFixed(1)` in `SignalItems`** to avoid a numeric-format change (decision: preserve one decimal everywhere; verify Dashboard's existing `{snr} dB` unrounded values in browser — if they differ, gate behind a `snrDecimals` prop rather than silently changing Dashboard).
3. **DashboardNodePopup gains i18n** — English output byte-identical; now translatable in non-EN locales (capability gain, not a visible EN change).

**Must stay pixel/byte-identical (regressions if not):** NodesTab marker popup (already the grid card), DashboardMap & MapAnalysis popups (already `DashboardNodePopup`), the neighbor-link popup (`DashboardNeighborPopup`, untouched — chrome-regression guard).

---

## 5. Test plan

### Update
- `DashboardNodePopup.test.tsx` — keep every assertion (longName/shortName/ID/"3 hops"/coords/"Seen by 2 sources"/click/disabled/absent-single). They should pass unchanged since the composition preserves markup; if the source-row markup moves into `SourcesList`, keep identical classes/roles so `getByText(...).closest('button')` still resolves.
- `MapAnalysisCanvas.test.tsx` — the `/Seen by 2 sources/` assertion (#3692) must still pass via the family; verify the mocked `<Popup>` renders `NodeCard`+`SourcesList`.
- `DashboardMap.test.tsx` — source-select/popup assertions against family output.

### New
- `nodeCardModel.test.ts` — `toNodeCardModel` meshtastic flat vs nested coalescing (matches old `pick()`); meshcore contact mapping; `effectiveHops` override; `useRecentTraceroute` window/relevance/sort (port the logic assertions from the two inline useMemos).
- `sections.test.tsx` — each section renders its exact classes/emoji/`t()` keys; `SignalItems` battery 101 ⇒ "Plugged In"; hops ≥999 hidden; `SourcesList` absent when <1 source; `MeshCoreDetails` fields; `TracerouteBody` fwd/return/failed/history-btn gating.
- `NodeCard.test.tsx` — no-tabs renders sections directly; with `tracerouteBody` renders tab bar + switches; `className` applied; header shortName optional.

### Browser validation (mandatory gate — per source tech)
On the dev container, **per source technology**:
1. **NodesTab** (Meshtastic) — marker popup identical to baseline (grid, tabs, traceroute tab, Copy NodeInfo appears only for incomplete nodes, Delete/Purge gating). Screenshot-diff vs pre-migration.
2. **DashboardMap + MapAnalysis** — identical card + "Seen by N sources" clickable → navigates; MapAnalysis popup still paints above markers (`pane="popupPane"`).
3. **MeshCoreMap** — restyled card shows every field (Key/RSSI/SNR/Path/Route/last-seen), More Details → DM, Tooltip still works. **NB (Phase-4 memory): MeshCore sources failed to connect in the last validation container** — if unavailable, cover with a fixture/DOM test and flag "re-verify visually when a meshcore source connects."
4. **NodePopup** — click a chat sender-dot: overlay opens at cursor, new grid card, tabs, View History, Show on Map, click-outside closes, doesn't collide with map card styling.

### Gate
Full Vitest `success:true` (verify via `--reporter=json` — rtk line masks suite-collection failures, per memory). `npm run lint:ci` exits 0 (no baseline growth; **no new `any`** — type `node: unknown` + narrow, or a `RawNode` type, not `any`; note DashboardNodePopup currently uses `node: any` — do not propagate it). typecheck clean.

---

## 6. Work packages (Sonnet-sized, disjoint, ordered)

### WP1 — Family scaffolding *(no deps)*
`nodeCardModel.ts` (+test), `NodeCard.tsx` (+test), `sections.tsx` (+test). **Acceptance:** model normalizer (meshtastic flat/nested + meshcore) + `useRecentTraceroute` + chrome + all sections, all `t()`-wired, no `any`, tests per §5; no consumer wired. suite+lint+typecheck green.

### WP2 — DashboardNodePopup → family *(deps: WP1)* — lowest risk, do first
`DashboardNodePopup.tsx`, its test, `MapAnalysisCanvas.test.tsx`, `DashboardMap.test.tsx`. **Acceptance:** thin composition; props/export unchanged; DashboardMap & MapAnalysis untouched; byte-identical EN output; "Seen by N" + source-select preserved; browser-validated on Dashboard + MapAnalysis; suite green. (Closest analog — validates the API before the harder consumers, mirroring Phase-4 WP3.)

### WP3 — MeshCoreMap popup → family *(deps: WP1; parallel to WP2)*
`MeshCoreMap.tsx`. **Acceptance:** inline `<Popup>` body replaced by `NodeCard`+`MeshCoreDetails`; Tooltip untouched; all fields + More Details preserved; restyle matches approved change §4.1; browser-validated (or fixture-gated if no meshcore source); suite green.

### WP4 — NodesTab popup → family, delete MapNodePopupContent *(deps: WP1)*
`NodesTab.tsx`, delete `MapNodePopupContent.tsx`. **Acceptance:** `<Popup autoPan={false}>` frame preserved; tabs/traceroute/Copy-NodeInfo/`getEffectiveHops`/`isNodeComplete`/Delete/Purge all preserved; `MapNodePopupContent` file + import removed; **pixel-identical** to baseline; browser-validated on NodesTab; suite green.

### WP5 — NodePopup overlay → family, delete NodePopup.css *(deps: WP1; LAST, highest risk)*
`NodePopup.tsx`, delete `NodePopup.css`, `nodes.css` (+`.node-popup-overlay`), `App.tsx` (click-outside selector). **Acceptance:** fixed frame + click-outside preserved; body is the family grid card; View History + Show on Map + tabs + Delete/Purge preserved; CSS collision gone; overlay styling correct in browser (open from chat, verify positioning + no bleed from/into the map card); suite green.

**Dependency graph:** WP1 → {WP2 ∥ WP3 ∥ WP4 ∥ WP5}; WP5 last. Each consumer WP re-runs the full suite + browser-validates its surface before the PR.

---

## 7. Risks & gotchas

- **R1 — CSS collision / cascade (§1.3).** `.node-popup` is defined in both nodes.css (3×) and NodePopup.css; the overlay's current styling is import-order-dependent (latent bug). Deleting NodePopup.css must not strip the overlay's fixed-frame box — salvage it into `.node-popup-overlay`, appended **after** nodes.css L1791 (the nodes.css ordering trap: rules in an earlier `@media` block are silently overridden by later same-specificity base rules). Keep the App.tsx click-outside selector in sync with whatever class the overlay wrapper carries, or the overlay won't close on outside-click.
- **R2 — MapAnalysis popup `pane="popupPane"`** (z-index 700 vs markers pane 600). The family renders *inside* the consumer's `<Popup>`, so the pane is unaffected — but re-verify the popup still paints above markers after the swap.
- **R3 — MeshCore `<Tooltip>` is a separate descriptor child** (Phase-4). Only the `<Popup>` body changes; leave the Tooltip verbatim, or MeshCore hover labels regress.
- **R4 — NodesTab pixel parity.** MapNodePopupContent is already the canonical card; the swap must be output-identical (same classes, same `t()` keys, same `getEffectiveHops`/`isNodeComplete` gating, same `autoPan={false}`). Any diff is a regression (§4). The NodesTab popup is gated on `!(showRoute && hasValidTraceroute)` — preserve that guard exactly.
- **R5 — SNR numeric format drift.** NodePopup uses `snr.toFixed(1)`; Dashboard uses raw `{snr}`. Unify to `toFixed(1)` in `SignalItems` but **verify Dashboard's live values in browser** — if Dashboard SNR is already integer, no visible change; if fractional, `toFixed(1)` is a (benign, approved) change — else gate via a `snrDecimals` prop to keep Dashboard byte-identical.
- **R6 — `node: any` proliferation.** DashboardNodePopup's `node: any` must NOT spread into the family (lint baseline: no new `any`). Type the normalizer input `unknown` and narrow, or define a `RawNode` union.
- **R7 — recharts/traceroute-segment popups are NOT in scope.** Those live in `TraceroutePathsLayer` (Phase 3) and `DraggablePopup`; do not touch. Node popups have no recharts.
- **R8 — i18n keys.** Reuse existing `node_popup.*` + `nodes.copy_nodeinfo_title` keys; DashboardNodePopup's newly-`t()`-wrapped strings ("Seen by N sources", "hops", position) need keys — add them to `public/locales/en.json` (and stubs) with EN text byte-identical to today, so English output never changes.
- **R9 — `DashboardNeighborPopup` shares `.node-popup-*` chrome** but is out of scope; its test is a chrome-regression guard — keep it green.

## 8. Orchestrator decisions to confirm before WP1

1. **D1** family home `src/components/map/popups/` (recommend yes).
2. **D2** include `NodePopup` (chat overlay) in this phase, sequenced last — vs defer to a follow-up (recommend include; the task requires the reconciliation and it's a live CSS drift).
3. **D3** canonical = `.node-popup-grid` (nodes.css); delete `NodePopup.css`; overlay frame → `.node-popup-overlay` (recommend yes).
4. **D4** discrete section components + per-consumer composition (recommend yes).
5. **D5** restyle MeshCore popup into the card — an approved visible change (recommend yes).
6. **D6** single `toNodeCardModel(raw, variant, opts)` normalizer (recommend yes).
7. **D7** `DashboardNeighborPopup` out of scope (recommend yes).
8. Confirm the **approved-visible-changes set** (§4: MeshCore restyle + NodePopup restyle + DashboardNodePopup i18n) is the intended bar — NodesTab & Dashboard/MapAnalysis stay pixel-identical.


---

## Orchestrator resolutions (gate review 2026-07-10)

- **D2 YES** — NodePopup (chat overlay) is IN, as WP5, strictly last. Rationale: the live
  NodePopup.css / nodes.css class collision is exactly the divergence class this epic
  kills, and the epic exit names the reconciliation. Escape hatch: if WP5 exceeds one
  fix iteration, it detaches into a follow-up PR without blocking Phase 5.
- **D3 YES** — canonical `.node-popup-grid` card (nodes.css) wins; NodePopup.css deleted;
  the overlay frame survives as `.node-popup-overlay` appended AFTER nodes.css's popup
  rules (cascade-order trap acknowledged).
- **D5 YES** — MeshCore popup restyle to the canonical card is approved (same fields,
  canonical chrome + MeshCoreDetails section).
- **D6 YES** — single `toNodeCardModel` normalizer; `variant` discriminates source tech.
- Approved-visible-changes list (§4) is binding as written; NodesTab and
  Dashboard/MapAnalysis popups must be pixel-identical.
