# MeshCore Parity P3 (#6259) Spec: Nodes and DM lists

**Mesh impact: none.** Everything runs on data the client already fetches (`/nodes`, contacts, messages, `dm-peers`). No new requests, no sends, no server or schema changes, and no `VALID_SETTINGS_KEYS` changes.

## Decisions (maintainer / orchestrator, 2026-11-07)
- **Q1 [maintainer]: the toolbar sort is saved for BOTH protocols** through the same `usePersistedListSort` hook. Meshtastic NodesTab uses key `meshtasticNodesSort` and MeshCore uses `meshcoreNodesSort`. Settings → Preferred sort is the default until the user picks a sort in the toolbar; after that the saved toolbar choice wins. UIContext `sortField`/`sortDirection` should seed from the saved toolbar choice when present, else from the Settings preference, and the toolbar writes it. Other UIContext consumers keep working.
- **Q2 [maintainer]: MeshCore battery shows voltage only** (e.g. `4.12V`, the same chip Meshtastic uses for voltage) and sorts by mV. No estimated percentage.
- **Q3 [orchestrator, one-implementation rule]: one "Group by role" preference** shared across protocols, using the localStorage key `groupNodesByRole`.
- **Q4 [maintainer]: DM preview only for threads in the live window.** Older `dm-peers`-only threads show no preview. No server change in this phase.
- **Q5 [orchestrator, one-implementation rule]: the favourites filter is added to both protocols** (`showFavorites?` in the shared popup).
- **#6185 (public-key sort) is already implemented**, in `MeshCoreNodesView.tsx:155-175` and `MeshCoreDirectMessagesView.tsx:427-430` with tests. The P3 PR closes it.

## 0. Findings
- **Already extracted:**
  - `src/utils/nodeSort.ts` (`nodeSortKey`, `sortNodesByField`; `DeviceInfo` only).
  - `src/utils/nodeExport.ts` (`buildNodeExportRows`, `nodesToCsv`, `nodesToHtml`, `downloadTextFile`; fixed `NodeExportRow`).
  - `src/utils/nodeGrouping.ts` (`buildGroupedNodeItems`, `countNodesByCategory`). This is already generic over `CategorizableNode` and maps MeshCore `advType` via `getNodeTypeCategory`, so grouping needs no new logic.
  - `src/components/AdvancedNodeFilterPopup/`, rendered globally by App.tsx:3427. Its role list (0–12) and section set are hardcoded.
- **Live filter predicate:** `passesAdvancedFilters`, inlined in `src/hooks/useSourceView.ts:412-533`. `useProcessedNodes.ts` holds a copy that production doesn't use (only its test calls it); leave it alone.
- **Still inline in NodesTab:**
  - `RoleDistributionSummary` (193-283) and the group header JSX (2684-2722).
  - Export menu state, outside-click effect and JSX (1746-1766, 2594-2640).
  - The sort select and direction button (2564-2593); the select has a baselined `as any`.
- **Persistence today:**
  - Sort: `UIContext.sortField`/`sortDirection` start from localStorage `preferredSortField`/`preferredSortDirection`, which only Settings writes (`SettingsContext.tsx:576-592, 890`). The toolbar choice is NOT saved.
  - Advanced filters: App.tsx `useState` plus localStorage `nodeFilters` (global), loaded with per-key fills (App.tsx:208-258) and written by an effect (App.tsx:1460).
  - Group by role: localStorage `groupNodesByRole` in UIContext.
  - DM filter: `UIContext.dmFilter`, kept for the session only.
- **The MeshCore page has no `UIProvider`** (`MeshCoreSourcePage.tsx:129-135`). Shared pieces must not depend on `useUI()`; use props plus localStorage helpers.
- **Data available on the client:**
  - `MeshCoreNode` (`useMeshCore.ts:108-147`): `batteryMv`, `uptimeSecs`, `snr`.
  - `MeshCoreContact`: `pathLen`, `snr`, `latitude`, `longitude`.
  - `MergedRow` (`MeshCoreNodesView.tsx:69-86`) currently drops `batteryMv`, `uptimeSecs`, `pathLen`, lat/lon and `firstHeard`.
- **Map popup:** it already shows hops (`MeshCoreDetails`, `sections.tsx:466-471`). Battery is missing: `toMeshCoreModel` (`nodeCardModel.ts:245`) never reads it, and contacts passed to `MeshCoreMap` carry no `batteryMv`.
- **Ignored nodes:** `MeshCorePage.tsx:133-142` filters ignored keys out before `MeshCoreNodesView` sees them. "Show ignored" needs the unfiltered lists plus the ignored-key set.

## 1. Reuse inventory
| Feature | Shared piece (existing Meshtastic → shared) | Meshtastic | MeshCore | New / why |
|---|---|---|---|---|
| Sort | `utils/nodeSort.ts`: add generic `sortByKey<T>` and `orderFavoritesFirst<T>`; `sortNodesByField` stays a thin wrapper with the same signature; shared `SortField` from `types/ui.ts` | `n => nodeSortKey(n, field, hopsOf)` | `r => meshcoreNodeSortKey(r, field)` in `utils/meshcoreNodeRows.ts` | MeshCore key adapter only. MeshCore subset: lastHeard, longName, id, snr, battery, uptime, hops (no shortName/hwModel; adverts lack them) |
| Sort controls | Extract to `components/nodes/NodeSortControls.tsx` | 9 options | 7 options | — |
| Sort persistence | New `hooks/usePersistedListSort.ts` (localStorage) | **Adopted (Q1)**, key `meshtasticNodesSort`, default from Settings preferred sort | key `meshcoreNodesSort`, default `{lastHeard, desc}`; DM list key `meshcoreDmSort` | New; nothing persisted toolbar choices before |
| Row stats | Extract `.node-stats` chips (`NodesTab.tsx:2937-2964`, `MessagesTab.tsx:1527-1547`) → `components/nodes/NodeStatChips.tsx` | snr, rssi, batteryLevel, voltage, effective hops, hopsSuffix | snr, rssi, `voltage = batteryMv/1000`, `hops = pathLen` | — |
| Map popup battery | `map/popups/sections.tsx`: export `BatteryItem` from `SignalItems`; `NodeCardModel.voltage?: number \| null` | unchanged output (voltage unset) | `toMeshCoreModel` sets `voltage` from `batteryMv`; `MeshCoreDetails` renders `BatteryItem` | — |
| Advanced filter | Configurable `AdvancedNodeFilterPopup`. Predicate extracted to `utils/nodeAdvancedFilter.ts` (`passesNodeFilters` over `NodeFilterSubject`) with defaults/normalize. `hooks/usePersistedNodeFilters.ts` replaces App.tsx load/effect. | all sections, `toMeshtasticFilterSubject`, key `nodeFilters` | features = position, unknown, ignored, favorites, hops, roles; `roleOptions` = advType 0–4; `toMeshCoreFilterSubject`; key `meshcoreNodeFilters` (role numbers differ per protocol) | New `showFavorites?` on `NodeFilters`, both protocols |
| Group by role | `nodeGrouping.ts` (logic unchanged). New `hooks/useNodeRoleGrouping.ts` takes `NodesTab.tsx:1697-1722`. `RoleDistributionSummary` + `RoleGroupHeader` move to `components/nodes/`. `readGroupNodesByRole`/`writeGroupNodesByRole` helpers. | UIContext toggle via helpers | local state via the same helpers and the same key | Rows set `isMeshCore: true` so a row with no `advType` isn't grouped as Meshtastic `mtClient` |
| Export | `utils/nodeExport.ts`: generic `ExportColumn<T>`, `rowsToCsv`, `rowsToHtml`, `exportNodeList`; `nodesToCsv`/`nodesToHtml` stay as byte-identical wrappers. Extract menu → `components/nodes/ExportMenuButton.tsx` | existing columns | `MESHCORE_NODE_EXPORT_COLUMNS` | column list only |
| DM filters | New `utils/dmListFilter.ts` `passesDmFilter` (from `MessagesTab.tsx:1134-1157`). New `components/messages/DmFilterSelect.tsx` (from `MessagesTab.tsx:1361-1374`). `DmFilter` type → `types/ui.ts` | all 7 options | `['all','unread','recent','favorites','withPosition']` (no `hops`: explicit sort control exists; no `noInfra`: type filter covers it), session `useState` | — |
| DM row metadata | `NodeStatChips` plus new `formatMessagePreview(text, max = 50)` in `utils/messagePreview.ts` (from `MessagesTab.tsx:1096-1098`) | MessagesTab uses both | preview from the live window, chips snr + pathLen | — |

**Stays protocol-specific:** the row containers (`.node-item` vs `.mc-node-row`; different layout and actions). The MeshCore merge/adapter lives in `utils/meshcoreNodeRows.ts`; it is an adapter, not a parallel implementation.

## 2. Changes

### Shared utilities
- `utils/nodeSort.ts`:
  ```ts
  export type SortKey = string | number;
  export function sortByKey<T>(items: readonly T[], keyOf: (item: T) => SortKey | undefined, direction: SortDirection): T[];
  // decorate-sort-undecorate, stable, shared collator; input order unchanged if the first key is undefined
  export function orderFavoritesFirst<T extends { isFavorite?: boolean }>(items: readonly T[], sort: (xs: T[]) => T[]): T[];
  ```
  `sortNodesByField` keeps its signature and delegates.
- `utils/nodeExport.ts`:
  ```ts
  export interface ExportColumn<T> { key: string; label: string; value: (item: T) => string }
  export function rowsToCsv<T>(cols: readonly ExportColumn<T>[], items: readonly T[]): string;
  export function rowsToHtml<T>(cols: readonly ExportColumn<T>[], items: readonly T[], opts?: NodesToHtmlOptions): string;
  export function exportNodeList<T>(format: 'csv'|'html', cols: readonly ExportColumn<T>[], items: readonly T[], opts: { filenamePrefix: string; title?: string }): void; // BOM + timestamp + downloadTextFile, from NodesTab.handleExportNodes
  ```
  `nodesToCsv`/`nodesToHtml` wrap `NODE_EXPORT_COLUMNS`; output must be byte-identical.
- New `utils/nodeAdvancedFilter.ts`:
  ```ts
  export const DEFAULT_NODE_FILTERS: NodeFilters;  // incl. showFavorites: false
  export function normalizeNodeFilters(raw: unknown): NodeFilters;
  // {...DEFAULT, ...parsed}; filterMode not show|hide → 'show'; non-array deviceRoles/channels → []
  export interface NodeFilterSubject {
    viaMqtt?: boolean; hasTelemetry?: boolean; hasEnvironment?: boolean;
    batteryLevel?: number | null;            // undefined = skip power filter (today's `!== undefined`)
    hasPosition: boolean; hops?: number | null; hasPKI?: boolean; hasRemoteAdmin?: boolean;
    isUnknown: boolean; isIgnored: boolean; isAgedOutAircraft?: boolean; isFavorite: boolean;
    favoriteLocked?: boolean; hiddenFromMap?: boolean; role: number; channel: number;
  }
  export function passesNodeFilters(s: NodeFilterSubject, f: NodeFilters, opts?: { allowAgedOut?: boolean }): boolean;
  export function toMeshtasticFilterSubject(node: DeviceInfo, sets: { nodesWithTelemetry: Set<string>; nodesWithWeather: Set<string>; nodesWithPKC: Set<string> }): NodeFilterSubject;
  ```
  Keep today's order and semantics exactly: the hops check only when `hops != null`; role = `typeof role === 'number' ? role : parseInt(role || '0')`; channel = `channel ?? -1`. Favourites use the standard show/hide pattern.
- New `hooks/usePersistedNodeFilters.ts`: `usePersistedNodeFilters(storageKey): [NodeFilters, Dispatch<SetStateAction<NodeFilters>>]`. Lazy normalized read, write on change, try/catch.
- New `hooks/usePersistedListSort.ts`:
  ```ts
  usePersistedListSort<F extends string>(storageKey, allowed: readonly F[], defaults: { field: F; direction: SortDirection }):
    { field; direction; setField(f); toggleDirection(); }
  ```
  Stores JSON `{field, direction}`; a value not in `allowed` falls back to the default. For Meshtastic, the default comes from the Settings preferred sort (Q1).
- `utils/nodeGrouping.ts`: `readGroupNodesByRole()` / `writeGroupNodesByRole(v)` (key `groupNodesByRole`).
- New `hooks/useNodeRoleGrouping.ts`:
  ```ts
  useNodeRoleGrouping<T extends CategorizableNode>(nodes, orderWithinGroup, enabled, flatOrdered):
    { items: GroupedNodeListItem<T>[]; distribution: RoleGroupCount[] | null; toggleCollapsed(c) }
  ```
- New `utils/dmListFilter.ts`:
  ```ts
  export interface DmFilterSubject { unread: boolean; lastMessageTime: number /*ms*/; isFavorite: boolean; hasPosition: boolean; isInfrastructure: boolean }
  export function passesDmFilter(s: DmFilterSubject, filter: DmFilter, nowMs = Date.now()): boolean;
  // 'hops' and 'all' pass; 'recent' = within 24h
  ```
- New `utils/messagePreview.ts`: `formatMessagePreview(text, max = 50)` (exact `substring(0, 50) + '...'`).
- New `utils/hopLabel.ts`: export the `hopCountLabel` that is privately duplicated in `sections.tsx:435` and `MeshCoreMap.tsx:70`.

### Types and shared components
- `types/ui.ts`: `NodeFilters.showFavorites?: boolean`; `export type DmFilter = 'all'|'unread'|'recent'|'hops'|'favorites'|'withPosition'|'noInfra'`.
- `components/nodes/NodeSortControls.tsx`: `<NodeSortControls<F> value direction options onChange onToggleDirection className? ariaLabel?>`.
  - Renders `.sort-controls` containing `select.sort-dropdown` (title and aria-label = the sort label; MeshCore tests use `getByTitle('Sort by')`) and `button.sort-direction-btn`.
  - The button stops propagation on click and mousedown, as NodesTab does today.
- `components/nodes/ExportMenuButton.tsx`: `<ExportMenuButton disabled? onExport(format)>`. Owns open state, outside-click/Escape, `.export-dropdown`/`.export-menu`, and the `nodes.export*` i18n keys.
- `components/nodes/NodeStatChips.tsx`: `<NodeStatChips snr? rssi? batteryLevel? voltage? hops? hopsSuffix? children?>`.
  - Renders a fragment of `span.stat` in order: SNR `toFixed(1)dB`, RSSI, battery (101 shows Plugged In), voltage `toFixed(2)V` with the `zap` icon, hops (only `< 999`, `t('nodes.hop', {count})`), then children.
  - Callers decide when SNR/RSSI shows (Meshtastic keeps its `hopsAway === 0` rule at the call site).
- `components/nodes/RoleDistributionSummary.tsx` and `RoleGroupHeader.tsx` (moved from NodesTab): use `useTranslation` directly. `RoleGroupHeader` is a `forwardRef` that spreads `style` and `data-index` (the virtualizer measures it). `NodeRoleGrouping.module.css` moves alongside or is imported from its current path.
- `components/messages/DmFilterSelect.tsx`: `<DmFilterSelect value onChange options?>` with the existing `messages.*` keys and `messages.filter_conversations_title`.
- `AdvancedNodeFilterPopup.tsx`:
  - New props:
    - `features?: Partial<Record<NodeFilterFeature, boolean>>` over 'security'|'telemetry'|'environment'|'position'|'pki'|'remoteAdmin'|'mqtt'|'unknown'|'ignored'|'favorites'|'favoriteLocked'|'hiddenFromMap'|'powerSource'|'hops'|'roles'|'channels'. Omitted = on, so App.tsx is unchanged except the new favourites checkbox.
    - `roleOptions?: ReadonlyArray<{value; label}>`.
  - `securityFilter`, `onSecurityFilterChange` and `channels` become optional.
  - `handleRoleChange` derives "all roles" from `roleOptions` (no hardcoded `[0..12]` / `length === 13`).
  - `DEFAULT_FILTERS` → import `DEFAULT_NODE_FILTERS`.
  - New i18n key `node_filter.favorites`.
- `map/popups/nodeCardModel.ts` + `sections.tsx`: `voltage?: number | null`. `toMeshCoreModel` sets `voltage = batteryMv > 0 ? batteryMv/1000 : null`. Export `BatteryItem`, used by `SignalItems` and `MeshCoreDetails`.

### Meshtastic consumers (surgical)
- `NodesTab.tsx` (WP-A):
  - Imports `RoleDistributionSummary`; `useNodeRoleGrouping` replaces 1697-1722; `orderFavoritesFirst(xs, sortNodes)`.
  - `<ExportMenuButton>`, with `handleExportNodes` → `exportNodeList`.
  - `<NodeSortControls>` (removes one `as any`), with the toolbar sort persisted via `usePersistedListSort('meshtasticNodesSort', …)` per Q1.
  - `<RoleGroupHeader ref style>`; `<NodeStatChips …><DistanceDisplay/></NodeStatChips>`.
  - Don't touch dependency arrays except where a memo is removed.
- `UIContext.tsx` (WP-A):
  - `groupNodesByRole` uses the nodeGrouping helpers.
  - `sortField`/`sortDirection` seed from the saved `meshtasticNodesSort` when present, else the Settings preferred sort.
  - Toolbar changes write the saved value.
  - (WP-B) `dmFilter` uses the `DmFilter` type.
- `useSourceView.ts` (WP-B): `passesAdvancedFilters` → `passesNodeFilters(toMeshtasticFilterSubject(node, sets), nodeFilters, { allowAgedOut })`.
- `App.tsx` (WP-B): lines 208-258 and the 1460 effect → `usePersistedNodeFilters('nodeFilters')`.
- `MessagesTab.tsx` (WP-D): `passesDmFilter` (sticky bypass stays), `<DmFilterSelect>`, `formatMessagePreview`, and `<NodeStatChips>` in DM rows (the direct-only SNR/RSSI rule stays at the call site).

### MeshCore consumers
- New `utils/meshcoreNodeRows.ts` (WP-C):
  ```ts
  export interface MeshCoreNodeRow { /* MergedRow + batteryMv?, uptimeSecs?, pathLen?, latitude?, longitude?, firstHeard?, isIgnored, readonly isMeshCore: true */ }
  export function mergeNodesAndContacts(nodes, contacts, ignoredKeys?: ReadonlySet<string>): MeshCoreNodeRow[];
  export const MESHCORE_NODE_SORT_FIELDS: readonly SortField[]; // lastHeard,longName,id,snr,battery,uptime,hops
  export function meshcoreNodeSortKey(r, f): SortKey | undefined;
  // longName→name; id→publicKey.toLowerCase() (#6185); lastHeard→??0; snr→??-999;
  // battery→batteryMv??-1; uptime→uptimeSecs??-1; hops→pathLen??999
  export function toMeshCoreFilterSubject(r): NodeFilterSubject; // role=advType??0; isUnknown=!hasName; hops=pathLen; channel -1
  export const MESHCORE_NODE_EXPORT_COLUMNS: ExportColumn<MeshCoreNodeRow>[];
  // Name, Public Key, Type, Hops, SNR, RSSI, Battery (V), Uptime (s), Latitude, Longitude, Last Heard, First Heard
  export const MESHCORE_ROLE_FILTER_OPTIONS; // from MESHCORE_DEVICE_TYPE_LABELS 0–4; labels via meshcoreRoleLabelKey
  ```
- `MeshCoreNodesView.tsx` (WP-C):
  - Remove the local `MergedRow`/`SortField`/`sortRows`/merge code.
  - Props: `ignoredKeys?`; `nodes`/`contacts` are now unfiltered.
  - Pipeline: aged → ignored (hidden unless `showIgnored`) → `passesNodeFilters` → search → `orderFavoritesFirst(sortByKey)` → `useNodeRoleGrouping`.
  - Toolbar: `NodeSortControls` (7 options, `nodes.sort_*` keys); a filter icon opening a local `<AdvancedNodeFilterPopup features roleOptions>`; a group-by-role toggle; `<ExportMenuButton>` (exports the displayed flat order).
  - Rows: `<NodeStatChips rssi snr voltage hops/>` in `.mc-node-row-meta`.
  - `MeshCoreVirtualList` takes `GroupedNodeListItem<MeshCoreNodeRow>` (header keys `group:${category}`).
  - Map `visibleKeys` uses the same filtered set as the list. `visibleContacts` copies `batteryMv` from node rows.
- `MeshCorePage.tsx` (WP-C): pass unfiltered `nodes`/`contacts` + `ignoredKeys={hiddenKeys}` to the Nodes view only.
- `meshcoreHelpers.ts`: `MeshCoreContact.batteryMv?: number` (copied in by views from the node row).
- `MeshCoreDirectMessagesView.tsx` (WP-D):
  - `lastMessageByPeer: Map<key,{ts,text}>` memo (`serverPeers` contribute `ts` only; Q4).
  - `dmFilter` `useState<DmFilter>('all')` plus `<DmFilterSelect options=[…]>`. `passesDmFilter` in `filteredPeers` with `unread = unreadPeers.has(key)`, `isFavorite` from `favoriteByKey`, `hasPosition` from contact lat/lon, `isInfrastructure = isMeshCoreInfrastructureAdvType`. The selected peer always passes.
  - The sort select → `<NodeSortControls>` via `usePersistedListSort('meshcoreDmSort', ['lastMessage','name','publicKey'], {lastMessage, desc})`.
  - Rows: `.last-message-preview` (`formatMessagePreview`; `messages.no_messages_preview` only when no known message) plus `<NodeStatChips snr={c?.snr} hops={c?.pathLen}/>`.
  - `estimateSize` about 72.
- i18n (`en.json`): `node_filter.favorites`, MeshCore empty states (e.g. `meshcore.no_filter_results`). Sort labels reuse `nodes.sort_*`.

## 3. Tests
- **Shared:**
  - `nodeSort.test.ts`: `sortByKey` (stable, direction, undefined first key), `orderFavoritesFirst`; existing cases unchanged.
  - `nodeExport.test.ts`: existing unchanged (byte-identical); `rowsToCsv`/`rowsToHtml` with custom columns and escaping.
  - `nodeAdvancedFilter.test.ts`: each filter in show and hide mode, hops null passes, `allowAgedOut`, `showFavorites`, `normalizeNodeFilters` (legacy, garbage, `filterMode: ''`), and a parity test of `toMeshtasticFilterSubject` on `useSourceView.test.ts` fixtures.
  - `usePersistedNodeFilters`, `usePersistedListSort` (load, write, invalid fallback, throwing storage, Meshtastic default from Settings), `useNodeRoleGrouping`, `dmListFilter`, `messagePreview`.
  - `NodeSortControls`, `ExportMenuButton` (open, Escape, outside-click, `onExport`), `NodeStatChips` (101 shows Plugged In, ≥999 hops hidden, order), `DmFilterSelect` (subset).
  - `AdvancedNodeFilterPopup`: features hide sections; `roleOptions` drive the checkboxes and the all/empty logic with 5 options; favourites checkbox.
  - `meshcoreNodeRows.test.ts`: merge carries the new fields; sort keys; filter subject; export columns.
  - `nodeCardModel` / `sections`: MeshCore voltage from `batteryMv`; Meshtastic `SignalItems` unchanged.
- **Regression (stay green):** `NodesTab.test.tsx`, `useSourceView.test.ts`, `nodeGrouping.test.ts`, all `MessagesTab.*.test.tsx` (`nodeOrdering`, `rowRenders`, `unreadDropdown`), `useProcessedNodes.test.ts`. In `MeshCoreNodesView.test.tsx`, only the dropdown values change (`'name'` → `'longName'`, `'publicKey'` → `'id'`); assertions are the same (#5936 two-row header).
- **New view tests:**
  - `MeshCoreNodesView.listTools.test.tsx`: battery/uptime/hops/SNR sort with missing values last when descending; sort survives remount; battery and hops chips; favourites/role/hops/ignored filters with show-ignored; group headers and collapse; export columns.
  - `MeshCoreDirectMessagesView.filters.test.tsx`: unread/favourites/with-position filters; selected peer stays visible; preview, hops and SNR in rows.
  - A NodesTab test that the toolbar sort persists across remount and the Settings preferred sort is the default.
- **Gate:** `lint:ci` with no FAIL lines; NodesTab, MessagesTab and App must not grow baselined counts. Code moved into new files must use CSS modules / `var(--color-*)` tokens, not inline colours.

## 4. Work packages
- **WP-A shared node-list primitives + Meshtastic NodesTab adoption:**
  - `nodeSort`, `nodeExport`, `nodeGrouping`, `hopLabel`, `usePersistedListSort`, `useNodeRoleGrouping`
  - `components/nodes/{NodeSortControls, ExportMenuButton, NodeStatChips, RoleDistributionSummary, RoleGroupHeader}`
  - `map/popups/{nodeCardModel, sections}`, `MeshCoreMap.tsx` (`hopCountLabel` import only)
  - `UIContext.tsx` (group helpers + sort persistence), `NodesTab.tsx`
- **WP-B shared advanced filter + Meshtastic adoption** (parallel with A): `nodeAdvancedFilter.ts`, `usePersistedNodeFilters.ts`, `types/ui.ts`, `AdvancedNodeFilterPopup` + test, `useSourceView.ts`, `App.tsx`, `UIContext.tsx` (`DmFilter` type only), `en.json` (`node_filter.favorites`).
- **WP-C MeshCore Nodes view** (after A + B): `meshcoreNodeRows.ts`, `MeshCoreNodesView` (+ css + tests), `MeshCorePage.tsx`, `meshcoreHelpers.ts`, `en.json`.
- **WP-D DM lists, both protocols** (after A + B; parallel with C): `dmListFilter.ts`, `messagePreview.ts`, `DmFilterSelect.tsx`, `MessagesTab.tsx`, `MeshCoreDirectMessagesView` + tests, `en.json`.
- **Overlap:**
  - `UIContext.tsx`: A and B touch different lines; re-read before editing.
  - `en.json`: additive only; re-read before editing.
  - NodesTab is WP-A only; MessagesTab is WP-D only.
  - Every extraction is cut-and-replace with no reformatting.
