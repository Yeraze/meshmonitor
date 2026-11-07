# MeshCore Parity P1 (#6258) Spec: Settings parity for MeshCore sources

Paths are relative to the repo root. Decisions marked **[MAINTAINER]** were confirmed with the user; see the epic plan's Phase log.

## 0. Findings (where reality differs from the brief)

- **Telemetry keys are written globally today.** `telemetryVisualizationHours` / `favoriteTelemetryStorageDays` are not in `SETTINGS_TAB_PER_SOURCE_KEYS` (`src/constants/nodeDisplayDefaults.ts:237`), so SettingsTab `handleSave` puts them in `globalBody` (~1520-1545). The read side already supports a per-source override: `GET /api/settings?sourceId=` overlays `source:<id>:*` (`settingsRoutes.ts:328-368`), and the hourly purge resolves `source:<id>:favoriteTelemetryStorageDays` → global → default (`src/utils/telemetryRetention.ts` `buildFavoriteRetentions`, via `database.ts` `collectFavoriteRetentionsAsync`). The comment at `telemetryRetention.ts:4-10` claiming the Settings section saves with `?sourceId` is stale.
- **Meshtastic per-source "Purge telemetry" wipes every source.** `handlePurgeTelemetry` → `apiService.purgeTelemetry(0)` sends no `sourceId` (`api.ts:1591`); `POST /api/purge/telemetry` → `purgeAllTelemetryAsync(undefined)` deletes all telemetry incl. MeshCore (`purgeRoutes.ts:51`). The route already accepts `body.sourceId`. Erase-nodes (`purgeNodes(0)`) has the same shape.
- **Solar is global.** `solarMonitoringService.ts:71-81` uses bare `getSetting`; SettingsTab saves solar keys in `globalBody`. `GlobalSettingsPage.tsx` already passes every solar prop/setter to `SettingsTab mode="global"`; only section membership hides it.
- **Restart/shutdown is global and admin-only.** `POST /api/system/restart` uses `requireAdmin()` (`systemRoutes.ts:196`); the `isDocker` probe uses `GET /api/system/status`.
- **Why `MeshCoreNodeDisplaySection` left out dimming/hide-incomplete** (`:29-38`): no MeshCore view consumed them. `MeshCoreNodesView` / `MeshCoreMap` read only `maxNodeAgeHours` and `maxInfraNodeAgeHours`. Reversing it means adding consumers.
- **Meshtastic dims only map markers.** `calculateNodeOpacity` (private in `NodesTab.tsx:173-198`) is used for 2D/3D markers (~1995, ~2055); the list is never dimmed.
- **Dimming / hide-incomplete keys are already per-source** (`NODE_DISPLAY_SEEDED_KEYS`, `PER_SOURCE_SETTINGS_KEYS`, `SETTINGS_TAB_PER_SOURCE_KEYS`). `useNodeDisplaySettings(sourceId)` returns `hideIncompleteNodes`, `nodeDimmingEnabled`, `nodeDimmingStartHours`, `nodeDimmingMinOpacity`. No server change.
- **`meshcore_packet_log_*` per source: OUT OF SCOPE.** Meshtastic `packet_log_*` is global too (`packetLogService.ts:163-179`); per-source would need service rework + migration + key lists + view scoping.

## 1. Reuse inventory

| Need | Existing mechanism | Use |
|---|---|---|
| Per-source settings write | `POST /api/settings?sourceId=` with `requirePermission('settings','write',{sourceIdFrom:'query'})` (`settingsRoutes.ts:385`) | All MeshCore saves. No new route. |
| Per-source settings read | `GET /api/settings?sourceId=`; `useNodeDisplaySettings(sourceId)` + `nodeDisplaySettingsQueryKey`; `useSettings()` context (provider in `MeshCoreSourcePage`) | Node display → hook; telemetry → context. |
| Section save pattern | `MeshCoreNodeDisplaySection`: draft/initial + `useSaveBar` + `NumberInputScope` + `csrfFetch` + `writeNodeDisplayLocal` + query invalidation | Template for the telemetry section. |
| Shared settings sub-form | `src/components/settings/SignFlipCorrectionSettings.tsx` (+ css, test) | Precedent for `NodeDimmingSettings`. |
| Opacity maths | `calculateNodeOpacity` in `NodesTab.tsx:173` | Extract to util. |
| Marker opacity | `NodeMarkerDescriptor.opacity` (`map/layers/NodeMarkersLayer.tsx:32`; NOT in `iconSig`, #3685) | MeshCoreMap sets it. |
| MeshCore age | `meshcoreLastHeardMs` / `meshcoreAgeCutoffMs` / `isWithinMeshcoreAge` (`src/utils/meshcoreAge.ts`); `isMeshCoreInfrastructureAdvType`; `MergedRow.lastHeard` (ms) | Dimming end + incomplete filter. |
| Telemetry purge | `POST /api/purge/telemetry {sourceId}` (admin); `purgeAllTelemetryAsync(sourceId)`; MeshCore telemetry is in shared `telemetry` table | Pass `sourceId`. |
| Outlier clean | `TelemetryOutlierDialog` (`isOpen`, `onClose`, `sourceId`, `sources`, `getTypeLabel`); `/api/purge/telemetry/outliers*` (admin, sourceId required) | Mount as is; `getTypeLabel = getTelemetryLabel` from `../TelemetryChart`. |
| Moved-control pointer | `MovedSettingNote` (`common/MovedSettingNote.tsx`); `GLOBAL_SETTINGS_PATH` (`nav/sourceNavEntries.ts:88`) | Pointers on Meshtastic per-source page. |
| Section placement | `GLOBAL_SETTINGS_SECTIONS` / `SOURCE_SETTINGS_SECTIONS` / `settingsNavItems` (`search/configSections.ts`), `adminOnly` | Move solar, add system. |
| Moved-section tests | `SettingsTab.movedSections.test.tsx`; `configSections.test.ts` (homeless / no overlap) | Extend. |
| Route tests | `createRouteTestApp`; `purgeRoutes.coverageCascade.test.ts` | Template. |

New, each justified: `src/utils/nodeDimming.ts` (extraction), `NodeDimmingSettings` (shared sub-form so inputs can't drift), `meshcoreNodeCompleteness.ts` (MeshCore has no NODEINFO, so `isNodeComplete` can't apply), `MeshCoreTelemetrySettingsSection` + `MeshCoreTelemetryDataSection` (MeshCore page never mounts SettingsTab), `SystemRestartSection` (restart lives in one place).

## 2. Decisions

- **D1. MeshCore telemetry editors write per-source** (`?sourceId=` → `source:<id>:telemetryVisualizationHours`, `source:<id>:favoriteTelemetryStorageDays`). Readers already resolve the override first; no override falls back to global. Meshtastic keeps writing the global default. Server unchanged; do NOT add these keys to `GLOBAL_ONLY_SETTINGS_KEYS` or `PER_SOURCE_SETTINGS_KEYS`. Fix the stale comment in `telemetryRetention.ts:4-10`.
- **D2. MeshCore Purge telemetry is scoped to the source** (`body.sourceId`); Clean outliers uses the dialog for this source only. Admin-only.
- **D3. Hide-incomplete for MeshCore** [MAINTAINER Q3]: a row is incomplete when it has no advertised name (raw name null/empty/whitespace, before the `'Unknown'` fallback in `mergeNodesAndContacts`) OR its `advType` is unknown (undefined / 0 / `MeshCoreDeviceType.UNKNOWN`). Favourites and the local node are exempt (like `isAgeExempt`). The filter runs in the `aged` memo so list and map (`visibleKeys`) both honour it.
- **D4. Dimming semantics match Meshtastic** [MAINTAINER Q4/Q5]: same keys and linear curve (1 up to `nodeDimmingStartHours`, down to `nodeDimmingMinOpacity` at the window end). Window end = the row's configured window (`maxInfraNodeAgeHours` for infra advTypes, else `maxNodeAgeHours`), from settings not the quick filter. Window 0 (show all) = no dimming. Dim MAP MARKERS ONLY — no list-row opacity. Local node never dimmed.
- **D5. Solar Monitoring moves to Global Settings.** Remove `settings-solar` from `SOURCE_SETTINGS_SECTIONS`, add to `GLOBAL_SETTINGS_SECTIONS`, `MovedSettingNote` on the source page. Add the five `solarMonitoring*` keys to `GLOBAL_ONLY_SETTINGS_KEYS` (not read per-source, not POSTed with `?sourceId`).
- **D6. Restart/shutdown moves to a new Global section `settings-system`** (admin-only) as `SystemRestartSection`; removed from per-source `settings-danger` with an admin-only `MovedSettingNote`. Moved, not mirrored.
- **D7 [MAINTAINER, approved]: scope Meshtastic per-source Purge telemetry and Erase nodes** to the page's source: SettingsTab passes the source id (as traceroutes do since #5089); `apiService.purgeNodes` gains an optional `sourceId` like `purgeTelemetry`. Global-mode buttons (if any) keep current behaviour. Route test proves only that source's rows go.
- Known limitation (unchanged): source-mode `handleSave` still POSTs every global key in the `const settings = {…}` literal, so a stale draft can re-post solar values. Follow-up: dirty-only global posting.

## 3. File-by-file changes

### WP1: Global moves (solar, restart) [+ Q2 scoping if approved]
- `src/components/search/configSections.ts`: move `'settings-solar'` SOURCE → GLOBAL (comment: global `getSetting` read). Add `'settings-system'` to GLOBAL and `adminOnly`. Nav item `{ id: 'settings-system', label: t('settings.system_section', 'Restart / Shutdown'), keywords: ['restart','shutdown','reboot','container','docker','power'] }`, last among global items.
- New `src/components/settings/SystemRestartSection.tsx` (+ module.css only if needed): `export default function SystemRestartSection(): JSX.Element | null`. Owns `isDocker` probe (`apiService.get('/api/system/status')`), `isRestarting`, `handleRestartContainer` — moved verbatim from `SettingsTab.tsx` ~704-719 and ~1895-1922. Renders `<div id="settings-system" className="settings-section">` with existing `danger-action`/`danger-button` markup, `UiIcon` refresh/power. Reuse `settings.restart_*` / `settings.shutdown_*` i18n.
- `src/components/SettingsTab.tsx`: render `{show('settings-system') && isAdmin && <SystemRestartSection />}` near the end of global sections; delete restart block + unused state from `settings-danger`; in `settings-danger` when `mode === 'source' && isAdmin` add `<MovedSettingNote testId="restart-moved" … to={`${GLOBAL_SETTINGS_PATH}#settings-system`} />`; when `mode === 'source'` render `<div id="settings-solar" className="settings-section"><MovedSettingNote testId="solar-moved" … to={`${GLOBAL_SETTINGS_PATH}#settings-solar`} /></div>`. Keep solar fields in `SettingsDraft` and the `settings` literal.
- `src/server/constants/settings.ts`: five `solarMonitoring*` keys → `GLOBAL_ONLY_SETTINGS_KEYS` with comment.
- `public/locales/en.json`: `settings.system_section`, `moved.restart`, `moved.solar`, `moved.open_global_settings` (if absent).
- Docs: `docs/features/settings.md`, `docs/features/solar-monitoring.md`, `docs/features/configuration-search.md` if it lists sections.

### WP2: MeshCore node dimming + hide-incomplete
- New `src/utils/nodeDimming.ts`: `export function calculateNodeOpacity(lastHeardSec: number | undefined, enabled: boolean, startHours: number, minOpacity: number, maxNodeAgeHours: number, nowMs: number = Date.now()): number` — body moved from `NodesTab.tsx:173-198` (inject `nowMs`). NodesTab imports it; no behaviour change.
- `src/constants/nodeDisplayDefaults.ts`: `export const NODE_DIMMING_RANGES = { nodeDimmingStartHours: { min: 0.5, max: 24, step: 0.5 }, nodeDimmingMinOpacity: { min: 0.1, max: 0.9, step: 0.1 } } as const;`
- New `src/components/settings/NodeDimmingSettings.tsx` (+ css, + test): props `{ enabled; startHours; minOpacity; disabled?; description?; onEnabledChange; onStartHoursChange; onMinOpacityChange }`. Keep input ids `nodeDimmingStartHours`/`nodeDimmingMinOpacity`. SettingsTab replaces its inline JSX (~2830-2876) with it (after WP1), same ids/i18n.
- New `src/utils/meshcoreNodeCompleteness.ts`: `export function isMeshCoreRowComplete(r: { rawName?: string | null; advType?: number }): boolean` (D3) + test.
- `MeshCoreNodeDisplaySection.tsx`: add `hideIncompleteNodes`, `nodeDimmingEnabled`, `nodeDimmingStartHours`, `nodeDimmingMinOpacity` to the draft (split bool/number typing). Hide-incomplete checkbox with hint `meshcore.settings.node_display.hide_incomplete_description`; `<NodeDimmingSettings description=… />`. POST booleans `'1'`/`'0'`, numbers `String(n)`. Mirror all keys with `writeNodeDisplayLocal`. Rewrite `:29-38` comment (only `localStatsIntervalMinutes` / `nodeHopsCalculation` remain Meshtastic-only); keep the `satisfies` guard.
- `MeshCoreNodesView.tsx`: add `hasName: boolean` to `MergedRow` (from raw `n.name` / `c.advName || c.name` before `'Unknown'`). Read the four keys from the existing `useNodeDisplaySettings(sourceId)`. In `aged` memo: `if (hideIncompleteNodes && !isAgeExempt(r) && !isMeshCoreRowComplete(...)) return false`. `opacityByKey` memo using `calculateNodeOpacity` with infra vs normal window; local node = 1. No list-row opacity (map only). Pass `markerOpacityByKey={opacityByKey}` to `<MeshCoreMap>`.
- `MeshCoreMap.tsx`: optional prop `markerOpacityByKey?: ReadonlyMap<string, number>`; in `markers` memo (~405) `opacity: markerOpacityByKey?.get(c.publicKey) ?? 1`; never in `iconSig`; add to deps.
- `public/locales/en.json`: the MeshCore hint keys. Docs: MeshCore Node Display docs under `docs/features/`.

### WP3: MeshCore telemetry settings + danger actions
- `src/services/api.ts`: `purgeTelemetry(olderThanHours: number, sourceId?: string)` includes `sourceId` in body when given.
- New `src/components/MeshCore/MeshCoreTelemetrySettingsSection.tsx` `{ baseUrl: string; sourceId: string }`: `MeshCoreNodeDisplaySection` pattern; baseline from `useSettings()` with re-seed effect; `NumberInput` 1-168 int and 7-90 int; save via `csrfFetch(`${baseUrl}/api/settings?sourceId=…`, POST, { telemetryVisualizationHours: String, favoriteTelemetryStorageDays: String })`; on success call `setTelemetryVisualizationHours` / `setFavoriteTelemetryStorageDays` and invalidate `['settings']`. `useSaveBar` id `meshcore-telemetry`; `canWrite = hasPermission('settings','write',{sourceId})`; 403 → toast. Reuse `settings.telemetry*` / `settings.fav_telemetry_*` i18n.
- New `src/components/MeshCore/MeshCoreTelemetryDataSection.tsx` `{ sourceId: string }`: `null` unless admin. Purge telemetry: confirm (reuse `settings.confirm_purge_telemetry_*` + "this source only"), `apiService.purgeTelemetry(0, sourceId)`, toast, reload or invalidate. Clean outliers: button + `<TelemetryOutlierDialog sourceId={sourceId} sources={[{ id: sourceId, name: sourceName }]} getTypeLabel={getTelemetryLabel} />` (`sourceName` from `useSource()`). Reuse `meshcore-purge-all-btn` class and `UiIcon delete`; new layout in a CSS module.
- `MeshCoreSettingsView.tsx`: mount telemetry settings after `MeshCoreNodeDisplaySection`; data section next to "Message data". Update module comment.
- `src/utils/telemetryRetention.ts`: comment fix (D1). en.json: `meshcore.settings.telemetry_data`, `meshcore.settings.confirm_purge_telemetry_source`, toasts. Docs: MeshCore settings section.

No new server routes.

## 4. Test plan

- **WP1:** extend `configSections.test.ts` (solar global-only; system global-only, admin-only, absent in source mode; homeless/overlap green); extend `SettingsTab.movedSections.test.tsx` (source mode shows `solar-moved` and admin-only `restart-moved`, no restart button; global mode renders `settings-solar` and `settings-system`); new `SystemRestartSection.test.tsx`; `settings.allowlist.test.ts` green (optionally assert solar in GLOBAL_ONLY). D7: route test that a scoped purge removes only that source's rows, and SettingsTab passes the id.
- **WP2:** new `nodeDimming.test.ts` (curve, disabled, missing lastHeard, range ≤ 0, clamp); new `meshcoreNodeCompleteness.test.ts`; new `NodeDimmingSettings.test.tsx`; update `MeshCoreNodeDisplaySection.test.tsx` (only two Meshtastic-only keys absent; POST body has the four new keys; localStorage mirrors; hydration); extend `MeshCoreNodesView.test.tsx` (hide-incomplete drops name-less / unknown-type rows except favourites and local, from list and map contacts; `markerOpacityByKey` with infra window; list rows NOT dimmed); extend `MeshCoreMap.test.tsx` (marker opacity from prop; `iconSig` unchanged). `SettingsTab.nodeDisplay.perSource.test.tsx` and NodesTab tests stay green.
- **WP3:** new `MeshCoreTelemetrySettingsSection.test.tsx` (POSTs `/api/settings?sourceId=<enc>` with exactly two keys; context setters; disabled without permission; 403 toast); new `MeshCoreTelemetryDataSection.test.tsx` (hidden for non-admins; purge sends sourceId; dialog opens with one source); extend `src/services/api.test.ts` (~679) for the sourceId body; new `src/server/routes/purgeRoutes.telemetryScope.test.ts` via `createRouteTestApp({ mount: app => app.use('/purge', purgeRoutes) })` (seed A and B, POST `{sourceId: A}`, only A gone; non-admin 403); extend `MeshCoreSettingsView` test to assert both sections mount.
- **Gates:** full Vitest (JSON `success: true`); `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` empty. No new `any`, no `exhaustive-deps` violations, no raw `fetch` in components, no hex/rgb colours.

## 5. Work packages

1. **WP1 Global moves** — configSections, SettingsTab, SystemRestartSection, settings constants, en.json, docs (+ D7 purge scoping). Accept: MeshCore-only install edits solar + restart at `/settings`; Meshtastic source page shows pointers, no duplicate editors; tests pass.
2. **WP2 Dimming + hide-incomplete** — after WP1 for the SettingsTab `NodeDimmingSettings` adoption (do that step last). Accept: keys save per source and survive reload; MeshCore list/map dim and hide; Meshtastic unchanged.
3. **WP3 Telemetry settings + danger** — independent. Accept: values persist per source and drive `MeshCoreTelemetryView`; purge removes only this source's telemetry; outlier dialog works for this source.

Order: WP1 ∥ WP3, then WP2. All touch `public/locales/en.json` (additive). One PR.

## 6. Risks

- R1. `meshcore_mqtt` ingest sources don't mount `MeshCoreSettingsView`; out of scope.
- R2. Source-page save re-POSTs solar keys from the shared literal (pre-existing for theme/units).
- R3. `NodesTab.tsx` / `SettingsTab.tsx` are large and ratchet-baselined — keep edits surgical; check `lint:ci` per file.
