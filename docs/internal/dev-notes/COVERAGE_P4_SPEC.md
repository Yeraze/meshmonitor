# Coverage Report Epic (#5277): Phase 4 Implementation Spec

**Phase:** P4 (final): gaps, surveys, summary, grid, export, node-details link.
**Status:** Approved (2026-09-24). User decisions U1–U7 are final in §5. P4a ships first as its own PR; P4b follows as a second PR.
**Branch:** `feature/coverage-p4-surveys` (from origin/main `94f411ed`, which holds P1 #5334, P2 #5336, P3 #5337).
**Inputs:** `COVERAGE_REPORT_EPIC.md`, `COVERAGE_P1/P2/P3_SPEC.md`, the #5277 plan comment, the current coverage code, `ARCHITECTURE_LESSONS.md` (Backup & Restore), `systemBackupService.ts` / `systemRestoreService.ts`.

## Split: P4a then P4b (two PRs)

P4 is ~10 Sonnet packages and ~7k LOC with tests. That is too big for one PR. Split on the schema line:

| | P4a: analysis of loaded data | P4b: saved surveys |
|---|---|---|
| Schema | none | new `coverage_surveys` table, migration 173 |
| Server | none | repository, purge exemption, routes, backup |
| Client | gap lines, summary panel + chart + per-receiver table, grid view, CSV/GeoJSON export, deep link, "Show coverage" links, sender search, `preferCanvas`, styled confirm | survey bar (start / stop / save range / pick / edit / delete), survey-driven filters |
| Decisions | U1, U7 (final) | U2–U6 (final) |
| Size | ~3.5k LOC, WP0 + 6 WPs | ~3.7k LOC, WP0 + 3 WPs |

P4a ships first: it needs no user policy calls, and every P4b feature (survey interval, survey window) plugs into P4a's pure functions. The boundary: **P4a never reads or writes a survey. P4b adds one new input (a selected survey) to the P4a report.**

---

## 0. Mesh impact checklist (copy into both PR bodies)

1. **Airtime: zero.** MeshMonitor sends nothing in P4. "Start survey" writes one DB row. It does not push config to the survey node, send a position request, or send an advert. Gaps come from packets we already have (no probe packets).
2. **Spam: none.** No messages, notifications, automation triggers or `dataEventEmitter` events. Survey create/stop/delete emit nothing onto the bus. No retries (a failed survey write returns an error to the UI; nothing re-sends).
3. **Timers: none new.**
   - A live survey has no timer. Its end is computed lazily: `effectiveEndAt = endAt ?? min(now, startAt + COVERAGE_SURVEY_LIVE_MAX_MS)`. `startAt` lives in the DB, so a restart neither resets nor extends a live survey. A settings save touches no survey.
   - The only timer stays P1's hourly retention sweep (`coverageRetentionService`). It keeps no last-fire state (cutoff-based), so a restart or save cannot burst it. P4b changes only the WHERE clause in `purgeOlderThan`.
   - Reverse failure checked: deleting a survey does not purge at once; its rows fall to the next hourly sweep (up to 1 h later). Nothing protective gets cleared by a save.

---

## 1. Reuse inventory (mandatory, read first)

| Need | Reuse / extend | Notes |
|---|---|---|
| Fix grouping | `groupReceptionsIntoFixes` (`src/utils/coverage.ts:220`) | Add `firstReceivedAt` (earliest reception in the group) to `CoverageFix`. Gaps use it: MQTT gateway copies can land seconds after the RF copy, and "newest" would jitter the spacing. |
| Distance | `calculateDistance(lat1, lon1, lat2, lon2)` → **km** (`src/utils/distance.ts:14`), `formatDistance` (same file, honours `distanceUnit`) | Haversine; do not fork. |
| SNR/RSSI colours | `snrToColor` / `rssiToColor` (`src/utils/mapHelpers.tsx`), `overlayColors.snrColors` | Grid cells and chart use the same bands as the dots. |
| Receiver identity | `receiverKey(sourceId, receiverId)` (`coverageReceiverFilter.ts:71`), `physicalReceiverKey` / `dedupeReceiverMarkers` (`coverageMapGrouping.ts`) | Per-receiver table keys by `receiverKey` (source-scoped, matches the filter UI). |
| Receiver filter wire format | `encodeReceiverFilter` / `parseReceiverFilter` / `buildReceiverQuery` (`coverageReceiverFilter.ts`) | P4b stores a survey's receivers as the **encoded wire string** and validates it with `parseReceiverFilter`. No new format. |
| Receptions loading | `useCoverageReceptions` (10 pages × 1000, `truncated` flag) | Summary, grid, gaps and export all run on its `items`. No new fetch in P4a. |
| Sender picker search | `SearchableSelect` (`src/components/common/SearchableSelect.tsx`; `options[{value,label,keywords}]`, `emptyLabel`, `maxVisible`) | Replaces the `<select>` (P2 Q3 carry-over). Used by `PacketMonitorPanel.tsx`. |
| Charts | **recharts ^3.9** (`package.json:96`); colours `var(--chart-1..8)` per theme in `src/App.css` (guarded by `semanticTokens.test.ts`); tooltip pattern in `LinkQualityChart.tsx`; jsdom note in `PacketStatsChart.test.tsx:8` | No ScatterChart exists yet; recharts ships one. The chart WP must load the `dataviz` skill before writing chart code. |
| CSV | `escapeCsv` + `downloadTextFile(filename, content, mime)` (`src/utils/nodeExport.ts:127,210`) | "Exported for reuse, do not fork." Add a formula-injection guard in the coverage builder (§2a.4), not in `escapeCsv`. |
| Median | none shared | `telemetryOutliers.ts` has a private one. Write a tiny `median()` in `coverageSummary.ts`. |
| Map shell | `BaseMap` (`src/components/map/BaseMap.tsx`) | Has **no** `preferCanvas` passthrough; P4a adds one (explicit, mount-only). |
| Modal | `Modal` (`src/components/common/Modal.tsx`: `isOpen`, `onClose`, `title`, `children`) | Styled confirm for the recording toggle and the P4b survey editor. |
| Deep link routing | react-router-dom `BrowserRouter basename={appBasename}` (`main.tsx:172`), `/reports` route → `ReportsPage` → `AnalysisTab` (local `useState` today) | `useSearchParams` in `AnalysisTab`; `useInRouterContext()` in the link component so node-detail tests that render without a Router keep passing. `appBasename` from `src/init.ts`. |
| Node details (Meshtastic) | `NodeDetailsBlock` (`src/components/NodeDetailsBlock.tsx`, used by `MessagesTab.tsx:2818`), `node.user.id` = `!xxxxxxxx` | |
| Node details (MeshCore) | `MeshCoreContactDetailPanel` (`publicKey` prop) | Sender id = lowercased 64-hex pubkey (matches `parseSenderParam`). |
| Existing coverage-grid | `/api/analysis/coverage-grid` + `analysis.getCoverageGrid` + `CoverageHeatmapLayer` | **Not reused.** It counts `telemetry` positions per degree bin keyed to zoom, server-side, with no signal values. P4 needs median SNR of loaded receptions, metre-sized cells. Reuse the pattern (bin by floor, cell centre) only. |
| Auth (P4b) | `requireAuth()` (`authMiddleware.ts:332`), `req.user.isAdmin`, `resolvePermittedSourceIds`, `buildPositionFilter` / `buildMeshCorePositionFilter` + `loadNodesBySource` / `loadMeshCoreNodesBySource` (`positionVisibility.ts`) | Survey visibility reuses the /senders sender gate (§2b.4). |
| Envelope | `ok()` / `fail()` (`src/server/utils/apiResponse.ts`) | All new handlers. |
| Route tests | `createRouteTestApp` harness; template `coverageRoutes.test.ts:59` | Mandatory for new routes. |
| Migration | `migration` skill; helpers `createTableIfMissingMysql`, `createIndexIfMissingMysql` (`src/server/migrations/helpers.ts`); template `172_create_coverage_receptions.ts` (+ `.test.ts`, `.pgmysql.test.ts`) | |
| Multi-backend repo tests | `createIsolatedPostgresDatabase` / `createIsolatedMysqlDatabase` (`test-utils.ts`), template `coverageReceptions.multiBackend.test.ts` (`isolationKey: 'covrx'`) | New key `covsv`. |
| Retention | `CoverageReceptionsRepository.purgeOlderThan` — **the single seam** P1 reserved | Only change to the sweep. |
| Backup | `BACKUP_TABLES` + `exportTable` (`systemBackupService.ts:18,184`), restore allowlist (`systemRestoreService.ts:357`) | See §2b.6 for the filtered exporter and the PG sequence trap. |

**New things, and why:**
- `src/utils/coverageGaps.ts`: pure gap rule. Nothing like it exists.
- `src/utils/coverageSummary.ts`: pure stats (heard/expected, best/worst, per-receiver, distance points).
- `src/utils/coverageGrid.ts`: pure metre-cell binning with median.
- `src/utils/coverageExport.ts`: CSV + GeoJSON builders.
- `src/utils/coverageDeepLink.ts`: build/parse `/reports?report=coverage&…`.
- P4b: `coverage_surveys` table + repository + routes + hooks + UI.

---

## 2a. P4a file-by-file

### 2a.1 WP0 (orchestrator commits before forking): constants, types, `firstReceivedAt`

**`src/utils/coverage.ts` (+ `coverage.test.ts`):**
- `CoverageFix` gains `firstReceivedAt: number` (min `receivedAt` in the group), set in `groupReceptionsIntoFixes`. Existing fields unchanged. Test: two receptions 3 s apart → `firstReceivedAt` is the earlier, `receivedAt` the later.
- Gap constants (U1 final). This is the single constants home; no other file defines thresholds:
  ```ts
  export const COVERAGE_DEFAULT_INTERVAL_SEC = { meshtastic: 30, meshcore: 60 } as const;
  export const COVERAGE_GAP_FACTOR = 2.5;          // gap if spacing > 2.5 × interval
  export const COVERAGE_GAP_MIN_SEC = 60;          // never call < 60 s a gap
  export const COVERAGE_GAP_MAX_SEC = 30 * 60;     // longer = session break, not a dead zone
  export const COVERAGE_GAP_MIN_DISTANCE_M = 200;  // shorter = sender stood still
  export const COVERAGE_INTERVAL_MIN_SAMPLES = 5;  // deltas needed to trust the estimate
  export const COVERAGE_INTERVAL_CLAMP_SEC = { min: 15, max: 900 } as const;
  export const COVERAGE_GRID_CELL_SIZES_M = [100, 250, 500, 1000] as const;
  export const COVERAGE_GRID_DEFAULT_CELL_M = 250;
  export const COVERAGE_CHART_MAX_POINTS = 3000;
  export const COVERAGE_CHART_MAX_SERIES = 7;     // + "Other"
  ```

**`src/types/coverageAnalysis.ts` (new, types only, no runtime code).** Every P4a WP imports result types from here, so WP2–WP6 can code in parallel with WP1:
```ts
import type { CoverageReceiverKind } from './coverage.js';
import type { CoverageRangePreset } from '../utils/coverageTimeRange.js';

export interface GapFixInput { packetKey: string; firstReceivedAt: number; latitude: number; longitude: number; }
export type IntervalSource = 'configured' | 'observed' | 'default';
export interface CoverageGap {
  from: GapFixInput; to: GapFixInput;
  durationSec: number; distanceM: number;
  missedEstimate: number;            // max(1, round(duration / interval) - 1)
}
export interface CoverageGapResult {
  intervalSec: number; intervalSource: IntervalSource;
  gaps: CoverageGap[];
  breaks: number;                    // spacings > MAX_GAP_SEC (not drawn, not counted)
  heard: number;                     // fixes
  expected: number;                  // heard + Σ missedEstimate
}
export interface CoverageReceiverStat {
  key: string; sourceId: string; receiverId: string; receiverKind: CoverageReceiverKind;
  fixesHeard: number; medianSnr: number | null; furthestDirectM: number | null;
}
export interface CoverageDistancePoint { distanceM: number; snr: number; receiverKey: string; }
export interface CoverageSummary {
  fixesHeard: number; receptions: number;
  bestSnr: number | null; worstSnr: number | null;
  bestRssi: number | null; worstRssi: number | null;
  receivers: CoverageReceiverStat[]; distancePoints: CoverageDistancePoint[];
}
export type CoverageGridCellSizeM = 100 | 250 | 500 | 1000;
export interface CoverageGridCell { key: string; south: number; west: number; north: number; east: number; medianValue: number | null; fixCount: number; }
export type CoverageMapView = 'dots' | 'grid';
export interface CoverageExportContext {
  senderNames: Map<string, string>; receiverNames: Map<string, string>; sourceNames: Map<string, string>;
  truncated: boolean; generatedAt: number; filters: Record<string, string | number | null>;
}
export interface CoverageDeepLink { sender?: string; range?: Exclude<CoverageRangePreset, 'custom'>; survey?: string; }
```
The util sections below repeat some shapes for easy reading; `coverageAnalysis.ts` is the source of truth. `src/types/**` and `src/utils/**` are in `tsconfig.server.json`'s include set, so every relative import in these files and in the new `src/utils/coverage*.ts` files carries a `.js` extension (#4596 lint rule).

### 2a.2 `src/utils/coverageGaps.ts` (new, + test) — WP1

Types come from `src/types/coverageAnalysis.ts` (WP0).
```ts
export function estimateIntervalSec(deltasSec: number[], protocol: CoverageProtocol, configuredSec?: number | null): { intervalSec: number; source: IntervalSource };
export function detectCoverageGaps(fixes: GapFixInput[], opts: { protocol: CoverageProtocol; configuredIntervalSec?: number | null }): CoverageGapResult;
```

**The rule** (one sender; the caller passes that sender's fixes after all current filters):

1. Sort fixes by `firstReceivedAt`. Drop exact duplicate `packetKey`s (already grouped, but be defensive).
2. `delta_i = (t[i+1] - t[i]) / 1000`. Ignore deltas < 1 s for estimation.
3. **Interval:**
   - `configuredSec` set (P4b survey `intervalSec`) → use it, source `configured`.
   - Else ≥ `COVERAGE_INTERVAL_MIN_SAMPLES` deltas → the **25th percentile** of deltas, clamped to `[15, 900]`, source `observed`. P25, not the median: gaps inflate the upper half; the fastest quarter of spacings is where the node was heard every time.
   - Else the protocol default (Meshtastic 30 s, the report's own guidance; MeshCore 60 s, the P3 guidance), source `default`.
4. **Gap** when all hold:
   - `delta > max(GAP_FACTOR × interval, GAP_MIN_SEC)`;
   - `delta ≤ GAP_MAX_SEC` (longer = drive paused / node off → counted in `breaks`, not drawn);
   - `calculateDistance(from, to) × 1000 ≥ GAP_MIN_DISTANCE_M` (Meshtastic smart position sends nothing while still, so a long pause in one spot is not a dead zone).
5. `missedEstimate = max(1, round(delta / interval) - 1)`; `expected = heard + Σ missed`.

**Receiver scope:** "any receiver in scope". The function takes the fixes the report shows. Untick all but one receiver and the gaps become that receiver's gaps with no extra code.

**Protocol** comes from the fixes' rows (`receptions[0].protocol`), never a source type. MeshCore adverts are manual, so `observed` needs 5 spacings and otherwise falls back to 60 s.

**When shown:** only when exactly one sender is selected (or, in P4b, a survey). With "All" senders, gaps and heard-vs-expected hide; the rest of the summary still shows.

Tests: steady 30 s with one 150 s hole → 1 gap, missed 4, expected = heard + 4; stationary pause (0 m) → no gap; 45-minute pause → `breaks: 1`; < 5 deltas → default by protocol; configured overrides observed; unsorted input; single fix → no gaps, expected 1; empty → zeros; MeshCore default 60 s; P25 not fooled by a run of long gaps.

### 2a.3 `src/utils/coverageSummary.ts` (new, + test) — WP1

```ts
export interface CoverageReceiverStat {
  key: string;                       // receiverKey(sourceId, receiverId)
  sourceId: string; receiverId: string; receiverKind: CoverageReceiverKind;
  fixesHeard: number;                // distinct packetKey
  medianSnr: number | null;
  furthestDirectM: number | null;    // hopsAway === 0 and receiver snapshot present
}
export interface CoverageDistancePoint { distanceM: number; snr: number; receiverKey: string; }
export interface CoverageSummary {
  fixesHeard: number; receptions: number;
  bestSnr: number | null; worstSnr: number | null;
  bestRssi: number | null; worstRssi: number | null;
  receivers: CoverageReceiverStat[];     // sorted fixesHeard desc
  distancePoints: CoverageDistancePoint[]; // 0-hop, snr non-null, receiver lat/lon non-null
}
export function summarizeCoverage(items: CoverageReceptionDto[]): CoverageSummary;
export function median(values: number[]): number | null;
```

- Distance uses the row's receiver **snapshot** (`receiverLatitude/Longitude`), which the server already nulls for hidden receivers. Right for moving receivers too.
- `distancePoints` is not capped here; the chart downsamples (§2a.6).
- Heard/expected and gap count come from `CoverageGapResult`, not from here.

### 2a.4 `src/utils/coverageGrid.ts` + `src/utils/coverageExport.ts` (new, + tests) — WP1

**Grid:**
```ts
export type CoverageGridCellSizeM = 100 | 250 | 500 | 1000;
export interface CoverageGridCell { key: string; south: number; west: number; north: number; east: number; medianValue: number | null; fixCount: number; }
export function binFixesToGrid(fixes: CoverageFix[], cellSizeM: CoverageGridCellSizeM, metric: CoverageMetric): CoverageGridCell[];
```
- One value per **fix**: its best value for `metric` (`bestSnr` / `bestRssi`), same as the dot colour (P1 D4). "Median per cell" = median of fix bests in the cell, so repeated drives through one cell vote once per pass, not once per receiver.
- Metre cells: `latStep = size / 111_320`; `lonStep = size / (111_320 × cos(refLat))`, `refLat` = mean latitude of the input (uniform cells across one survey area). Cell key `floor(lat/latStep):floor(lon/lonStep)`.
- A fix with a null best value still counts in `fixCount`; `medianValue` null if every fix in the cell is null.

**Export:**
```ts
export function buildCoverageCsv(items: CoverageReceptionDto[], ctx: CoverageExportContext): string;
export function buildCoverageGeoJson(items: CoverageReceptionDto[], ctx: CoverageExportContext & { gaps?: CoverageGap[] }): string;
export interface CoverageExportContext { senderNames: Map<string,string>; receiverNames: Map<string,string>; sourceNames: Map<string,string>; truncated: boolean; generatedAt: number; filters: Record<string, string | number | null>; }
export function coverageExportFilename(ext: 'csv'|'geojson', senderId: string | null, sinceMs: number, untilMs: number): string;
```
- **Client-side** from `receptionsQuery.data.items` (decision A4). One row/feature per reception.
- CSV columns: `receivedAt` (ISO), `receivedAtMs`, `protocol`, `senderId`, `senderName`, `latitude`, `longitude`, `altitude`, `precisionBits`, `sourceId`, `sourceName`, `receiverKind`, `receiverId`, `receiverName`, `receiverLatitude`, `receiverLongitude`, `distanceKm`, `snr`, `rssi`, `hopsAway`, `hopStart`, `hopLimit`, `relayNode`, `pathKey`, `packetKey`, `channel`. RFC 4180 via `escapeCsv`, CRLF.
- **Formula guard:** a text cell starting with `= + - @ \t \r` gets a leading `'`. Node names come off the mesh; a name like `=HYPERLINK(...)` must not run in a spreadsheet. Apply to text columns only (never to numbers, so `-7.5` SNR stays numeric).
- GeoJSON (RFC 7946): `FeatureCollection`, `Point` coordinates `[lon, lat]` (and altitude when present); properties = the CSV fields. Gaps as `LineString` features with `{ kind: 'likely_gap', durationSec, distanceM, missedEstimate }`. Top-level foreign member `meshmonitor: { generatedAt, truncated, filters }`.
- A truncated load exports what is loaded and says so (`truncated: true`; the button tooltip warns).

### 2a.5 `src/utils/coverageDeepLink.ts` (new, + test) — WP1

```ts
export interface CoverageDeepLink { sender?: string; range?: Exclude<CoverageRangePreset,'custom'>; survey?: string; }
export function buildCoverageReportPath(link: CoverageDeepLink): string;   // '/reports?report=coverage&sender=…&range=24h'
export function parseCoverageDeepLink(params: URLSearchParams): CoverageDeepLink | null; // null unless report=coverage
```
- `sender` accepted only if `^![0-9a-f]{8}$` (lowercased) or `isMeshCorePubKeyId` (lowercased). Anything else is dropped, never passed to the API.
- `range` accepted only from `RANGE_PRESETS` ids. `survey` (P4b) accepted as a UUID string; P4a parses and ignores it.

### 2a.6 Components — WP2 (map), WP3 (panel + export)

**WP2 — `CoverageMap.tsx` (+ test, CSS) and `BaseMap.tsx` (+ test):**
- `BaseMap`: add `preferCanvas?: boolean` passthrough to `MapContainer` (mount-only, documented like `center`).
- `CoverageMap` new props:
  ```ts
  gaps?: CoverageGap[];                 // drawn when present
  view?: 'dots' | 'grid';               // default 'dots'
  gridCells?: CoverageGridCell[];       // used when view === 'grid'
  ```
- Gaps: react-leaflet `Polyline` per gap, `dashArray: '6 6'`, colour `var(--color-text-muted)` resolved like the other overlay colours (no raw hex outside the existing constants), weight 2, drawn **under** the dots. Tooltip: "Likely gap: 2 min 30 s, ~4 fixes missed". Not clickable.
- Grid: `Rectangle` per cell, fill from `snrToColor`/`rssiToColor(medianValue)`, fillOpacity 0.55, thin stroke; tooltip "Median SNR −4.5 dB · 6 fixes". Receiver markers still show. Dots hidden in grid view.
- `preferCanvas`: **on** (decision A6). P4 adds rectangles and polylines on top of up to 10k circles; SVG with that many nodes lags on pan/zoom. Canvas `CircleMarker`/`Polyline`/`Rectangle` still get click, popup and tooltip. Browser validation must click a dot with a real mouse (canvas hit-testing ignores synthetic `dispatchEvent`, see memory "Real-mouse click validation").

**WP3 — new `CoverageSummaryPanel.tsx` (+ `.module.css`, test), `CoverageDistanceChart.tsx` (+ test), `CoverageExportButtons.tsx` (+ test):**
```ts
<CoverageSummaryPanel summary={CoverageSummary} gapResult={CoverageGapResult | null}
  receivers={CoverageReceiverDto[]} distanceUnit={...} truncated={boolean} />
<CoverageDistanceChart points={CoverageDistancePoint[]} receiverNames={Map<string,string>} distanceUnit />
<CoverageExportButtons items={CoverageReceptionDto[]} gaps={CoverageGap[]} ctx={CoverageExportContext}
  senderId={string|null} sinceMs untilMs disabled={boolean} />
```
- Summary tiles: Fixes heard / expected (and %) with the interval and its source ("interval 30 s, observed"); gap count; best / worst SNR; best / worst RSSI; receptions. When `gapResult` is null: "Pick one sender to see gaps and expected fixes."
- Per-receiver table: name (`longName || shortName || formatCoverageNodeId`), source name, kind, fixes heard, median SNR, furthest direct (formatted with `formatDistance`, "—" when none). Sortable by fixes heard (default) only; keep it simple.
- Distance chart: recharts `ScatterChart`, x = distance (km or mi from `distanceUnit`), y = SNR dB, axis labels with units. Series = top 7 receivers by point count in `var(--chart-1..7)`; the rest merged as "Other" in a neutral token. Downsample to ≤ 3000 points by a deterministic stride (no random). Empty state: "No direct (0-hop) receptions with a known receiver position." Load the `dataviz` skill first.
- Export buttons: "CSV" and "GeoJSON", via `downloadTextFile` (mime `text/csv` / `application/geo+json`). Disabled when `items.length === 0`. Tooltip when truncated: "Exports the first N receptions loaded."

### 2a.7 Report integration — WP4

**`CoverageReport.tsx` (+ tests, CSS):**
- Props: `initialLink?: CoverageDeepLink` — seeds `senderId` and `preset`/window once at mount (lazy `useState`, same rule as the P1 query-stability fix: never re-derive from props per render).
- Sender picker → `SearchableSelect`: options `{ value: senderId, label: "Name (id) — N", keywords: "longName shortName fullId" }`, `emptyLabel` "All". A deep-linked sender absent from `/senders` (no fixes in window) still shows as a synthetic option with its formatted id so the value never vanishes.
- View toggle "Dots | Grid" + cell size select (100/250/500/1000 m, default 250) shown in grid view.
- Derived, all `useMemo` on existing data:
  - `singleSender = senderId !== ''`;
  - `gapResult = singleSender ? detectCoverageGaps(fixesAsGapInputs, { protocol }) : null`;
  - `summary = summarizeCoverage(items)`;
  - `gridCells = view === 'grid' ? binFixesToGrid(fixes, cellSize, metric) : []`.
- Render order under the map: `CoverageSummaryPanel`, then `CoverageDistanceChart`, export buttons in the controls row.
- `fitKey` unchanged (view toggles must not re-fit).

**`AnalysisTab.tsx` (+ test):**
- `const [params, setParams] = useSearchParams()`; `const link = parseCoverageDeepLink(params)`. Initial `selected = link ? 'coverage' : null`. Pass `initialLink={link}`.
- Back button clears the params (`setParams({}, { replace: true })`) so Back does not reopen the report.
- `AnalysisTab.test.tsx` has no Router today: wrap its renders in `MemoryRouter` (and add deep-link cases).

### 2a.8 "Show coverage" links — WP5

- New `src/components/Analysis/ShowCoverageLink.tsx` (+ test): `({ senderId }: { senderId: string })`. Builds `buildCoverageReportPath({ sender: senderId, range: '24h' })`. If `useInRouterContext()` → `<Link to=…>`; else `<a href={appBasename + path}>`. `UiIcon name="radioSignal"` + "Show coverage". Renders nothing for an id `parseCoverageDeepLink` would reject.
- `NodeDetailsBlock.tsx`: add the link in the details header/actions area, using `node.user.id`. Hidden when `node` or `node.user?.id` is missing.
- `MeshCoreContactDetailPanel.tsx`: add it next to the existing action buttons with `publicKey.toLowerCase()`. Visible in read-only embeds too (it navigates; it changes nothing).
- The link is shown regardless of whether receptions exist; the report's empty state explains.
- Permissions: none needed on the link. The report applies per-source read and position gates as today.

### 2a.9 WP6: styled confirm in `CoverageMqttRecordingSection.tsx` (+ test)

Included (U7). Replace `window.confirm` with `Modal` (buttons: `common.cancel` / "Turn on recording"). Keep the two existing message keys (`settings.coverage_mqtt_enable_confirm`, `settings.coverage_observer_enable_confirm`) unchanged and render them split on `\n\n` into paragraphs, dropping the trailing "Continue?" line if present. Enabling happens only on the confirm button; Cancel and Esc leave the toggle off. Disabling still needs no confirm. Tests: open on enable, Cancel leaves it off, confirm saves, disable skips the modal, observer vs MQTT text. Only this file and its test.

### 2a.10 i18n + docs (orchestrator, after WPs merge)

- WPs use the keys below with these exact English defaults in `t(key, default)`. The orchestrator adds them to `public/locales/en.json` (flat keys) in one commit. No WP edits `en.json`. A WP that needs a key not listed adds it to its handback.
- Reuse, do not duplicate: `common.cancel`, `analysis.coverage.kind_local` / `kind_gateway` / `kind_observer`, `analysis.coverage.sender_all`, `analysis.coverage.metric_snr` / `metric_rssi`.

| Key | English | WP |
|---|---|---|
| `analysis.coverage.summary_title` | Summary | 3 |
| `analysis.coverage.summary_fixes_heard` | Fixes heard | 3 |
| `analysis.coverage.summary_heard_of_expected` | {{heard}} of {{expected}} expected ({{percent}}%) | 3 |
| `analysis.coverage.summary_interval` | Interval {{seconds}} s ({{source}}) | 3 |
| `analysis.coverage.summary_interval_configured` | configured | 3 |
| `analysis.coverage.summary_interval_observed` | observed | 3 |
| `analysis.coverage.summary_interval_default` | default | 3 |
| `analysis.coverage.summary_gaps` | Likely gaps | 3 |
| `analysis.coverage.summary_best_snr` | Best SNR | 3 |
| `analysis.coverage.summary_worst_snr` | Worst SNR | 3 |
| `analysis.coverage.summary_best_rssi` | Best RSSI | 3 |
| `analysis.coverage.summary_worst_rssi` | Worst RSSI | 3 |
| `analysis.coverage.summary_receptions` | Receptions | 3 |
| `analysis.coverage.summary_pick_sender` | Pick one sender to see gaps and expected fixes. | 3 |
| `analysis.coverage.receivers_table_title` | Receivers | 3 |
| `analysis.coverage.col_receiver` | Receiver | 3 |
| `analysis.coverage.col_source` | Source | 3 |
| `analysis.coverage.col_kind` | Kind | 3 |
| `analysis.coverage.col_fixes_heard` | Fixes heard | 3 |
| `analysis.coverage.col_median_snr` | Median SNR | 3 |
| `analysis.coverage.col_furthest_direct` | Furthest direct | 3 |
| `analysis.coverage.chart_title` | Distance vs SNR (direct receptions) | 3 |
| `analysis.coverage.chart_x_km` | Distance (km) | 3 |
| `analysis.coverage.chart_x_mi` | Distance (mi) | 3 |
| `analysis.coverage.chart_y_snr` | SNR (dB) | 3 |
| `analysis.coverage.chart_other` | Other | 3 |
| `analysis.coverage.chart_empty` | No direct (0-hop) receptions with a known receiver position. | 3 |
| `analysis.coverage.chart_downsampled` | Showing {{shown}} of {{total}} points. | 3 |
| `analysis.coverage.export` | Export | 3 |
| `analysis.coverage.export_csv` | CSV | 3 |
| `analysis.coverage.export_geojson` | GeoJSON | 3 |
| `analysis.coverage.export_truncated` | Exports the first {{count}} receptions loaded. | 3 |
| `analysis.coverage.gap_tooltip` | Likely gap: {{duration}}, about {{missed}} fixes missed | 2 |
| `analysis.coverage.grid_tooltip` | Median {{metric}} {{value}} · {{count}} fixes | 2 |
| `analysis.coverage.grid_no_value` | No {{metric}} data · {{count}} fixes | 2 |
| `analysis.coverage.view` | View | 4 |
| `analysis.coverage.view_dots` | Dots | 4 |
| `analysis.coverage.view_grid` | Grid | 4 |
| `analysis.coverage.cell_size` | Cell size | 4 |
| `analysis.coverage.sender_search_placeholder` | Search senders | 4 |
| `analysis.coverage.sender_no_matches` | No matching senders | 4 |
| `analysis.coverage.show_coverage` | Show coverage | 5 |
| `analysis.coverage.show_coverage_title` | Open the Coverage Report for this node (last 24 hours) | 5 |
| `settings.coverage_enable_confirm_title` | Turn on coverage recording? | 6 |
| `settings.coverage_enable_confirm_ok` | Turn on recording | 6 |

`{{duration}}` in `gap_tooltip` is pre-formatted by WP2 (e.g. "2 min 30 s") with a local helper; no extra keys for units.
- `docs/features/coverage-report.md`: new sections "Likely gaps", "Summary", "Grid view", "Export", "Opening from node details"; trim "What's next" to surveys.
- Epic doc: P4a phase log.

---

## 2b. P4b file-by-file (saved surveys)

### 2b.1 Why the table is **global**

A survey is "this sender, this time range". The sender is heard by receivers on many sources (radio + gateways + observers); one drive should be one survey. That is the same shape as the automations exception in CLAUDE.md (global by design, sub-scoped by a filter inside the row). Per-source privacy still holds because:
- the survey row holds **no reception data**: only name, sender id, window, optional receiver filter, interval, notes;
- the report reads a survey's receptions through the existing `/receptions` route, which scopes by the viewer's permitted sources and applies the position gates;
- the survey list itself is gated on sender visibility (§2b.4).

A per-source table would split one drive into N rows, and "delete the survey" would need N deletes. Decided global (U5).

### 2b.2 Schema `src/db/schema/coverageSurveys.ts` (new) + `index.ts` export + `activeSchema.ts` — WP1

| Column | SQLite | PG | MySQL | Notes |
|---|---|---|---|---|
| `id` | text PK | text PK | varchar(36) PK | `crypto.randomUUID()`. **Not serial**: see §2b.6 PG sequence trap; also an opaque deep-link id. |
| `name` | text NN | text NN | varchar(120) NN | 1–120 chars, trimmed. |
| `senderId` | text NN | text NN | varchar(80) NN | Canonical form (`!xxxxxxxx` or lowercased 64-hex), via the same parser as `/receptions`. |
| `startAt` | integer NN | bigint NN | bigint NN | unix ms. |
| `endAt` | integer | bigint | bigint | null = live. |
| `receivers` | text | text | text | Encoded receiver-filter wire string or null (= every receiver). View preference only; **not** part of the retention exemption. |
| `intervalSec` | integer | integer | int | Optional configured interval for gap detection (15–3600). |
| `notes` | text | text | text | ≤ 2000 chars. |
| `createdBy` | integer | integer | int | `users.id`; null if created by an admin script. No FK (users can be deleted; admins still manage the row). |
| `createdAt`, `updatedAt` | integer NN | bigint NN | bigint NN | unix ms. |

Indexes: `cov_sv_sender_start_idx (senderId, startAt)`, `cov_sv_created_by_idx (createdBy)`.

### 2b.3 Migration `173_create_coverage_surveys.ts` (+ `.test.ts`, `.pgmysql.test.ts`) + registry — WP1

Use the `migration` skill. `CREATE TABLE IF NOT EXISTS` (SQLite/PG), `createTableIfMissingMysql` with inline indexes (MySQL), `CREATE INDEX IF NOT EXISTS` for SQLite/PG. `settingsKey: 'migration_173_create_coverage_surveys'`. Check `origin/main` for a new 173 right before committing (none as of `94f411ed`; open PR #5328 adds none).

### 2b.4 Repository `src/db/repositories/coverageSurveys.ts` (new) + `coverageReceptions.ts` purge seam — WP1

```ts
createSurvey(p): Promise<DbCoverageSurvey>
getSurvey(id): Promise<DbCoverageSurvey | null>
listSurveys(): Promise<DbCoverageSurvey[]>          // newest startAt first; route filters visibility
updateSurvey(id, patch: { name?, notes?, intervalSec?, receivers?, endAt? }): Promise<boolean>
deleteSurvey(id): Promise<boolean>
countSurveys(): Promise<number>; countSurveysByUser(userId): Promise<number>
getLiveSurveyForSender(senderId, nowMs): Promise<DbCoverageSurvey | null>   // endAt null and not past the live cap
getExemptionWindows(nowMs): Promise<Array<{ senderId: string; startAt: number; endAt: number }>>  // effective ends
```
Wire into `DatabaseService` (`coverageSurveysRepo` + getter, init next to `coverageReceptionsRepo`).

**Purge seam** (`CoverageReceptionsRepository.purgeOlderThan(cutoffMs, exemptions = [])`):
```ts
where(and(
  lt(receivedAt, cutoffMs),
  exemptions.length ? not(or(...exemptions.map(w => and(eq(senderId, w.senderId), gte(receivedAt, w.startAt), lte(receivedAt, w.endAt))))) : undefined,
))
```
- `coverageRetentionService.runCleanup` loads `getExemptionWindows(Date.now())` and passes them. The repository stays free of a survey import; the seam is still one method.
- No NULL trap: `senderId` and `receivedAt` are NOT NULL.
- Bound params ≈ 3 × surveys. `COVERAGE_SURVEY_MAX_TOTAL` (U4) keeps the single DELETE under every backend's limit; the route enforces the cap.
- Exemption covers **every source's** rows for that sender in the window, regardless of `receivers`. The receiver filter is a view preference; storing more than the view needs is cheap and keeps a survey re-filterable later.
- `deleteForSource` / `deleteAll` (source delete, purge nodes) stay as they are and **do** delete survey rows: those are explicit wipes. The survey row stays and shows 0 receptions (U6).

### 2b.5 Routes — WP2 (`coverageRoutes.ts` + new `coverageSurveyRoutes.ts` mounted inside it, + harness tests)

Mount under the existing router as `/surveys` (so `/api/analysis/coverage/surveys`). All use `ok()`/`fail()`.

| Method + path | Gate | Behaviour |
|---|---|---|
| `GET /surveys` | `optionalAuth` (router-wide) | Anonymous → `[]`. Admin → all. Others → own surveys + surveys whose sender passes the /senders visibility gate on ≥ 1 permitted source (Meshtastic `buildPositionFilter` by `(sourceId, nodeNum)` over nodes that exist on that source; MeshCore `buildMeshCorePositionFilter`). DTO adds `effectiveEndAt`, `isLive`, `canEdit` (creator or admin), `createdByMe`; `createdBy` id is not exposed. |
| `POST /surveys` | `requireAuth()` | Body `{ name, senderId, startAt?, endAt?, live?: boolean, receivers?, intervalSec?, notes? }`. `live` → `startAt = now`, `endAt = null`; else both required, `endAt ≥ startAt`, `endAt ≤ now + 60 s`, `endAt - startAt ≤ COVERAGE_SURVEY_MAX_RANGE_MS`. Sender must pass the visibility gate for non-admins (`SENDER_NOT_VISIBLE`, 403). One live survey per sender (`SURVEY_ALREADY_LIVE`, 409). Caps (`SURVEY_LIMIT_REACHED`, 409). `receivers` must pass `parseReceiverFilter` (`INVALID_RECEIVERS`). |
| `PATCH /surveys/:id` | `requireAuth()` + creator/admin | `name`, `notes`, `intervalSec`, `receivers`. Not `senderId`/`startAt` (make a new survey). |
| `POST /surveys/:id/stop` | `requireAuth()` + creator/admin | Live only: `endAt = min(now, startAt + LIVE_MAX)`. Else `SURVEY_NOT_LIVE` (409). |
| `DELETE /surveys/:id` | `requireAuth()` + creator/admin | Row only; receptions fall to the next sweep. |
| `GET /receivers` | unchanged gate | **Add optional `since`/`until`** (default: retention window). A survey older than the retention window has rows only inside the survey; without this, its receivers would be missing from the filter list and the map. |

Codes: `SURVEY_NOT_FOUND` (404), `FORBIDDEN` (403) for non-creator edits, `INVALID_SURVEY` (400) for field errors. CSRF is applied globally to `apiRouter` (`server.ts:1135`); harness tests must send the token the way `sourceRoutes.permissions.test.ts` does.

Audit: log create / stop / delete with the existing audit helper if coverage-adjacent routes use one; otherwise `logger.info` with user id and survey id (implementer checks `automationRoutes.ts` for the pattern).

### 2b.6 Backup / restore — WP1 (repo) + WP2 (service)

- Add `coverage_surveys` to `BACKUP_TABLES` (user data, tiny). Update `systemBackupService.test.ts` manifest assertions.
- **Survey receptions** (U3: **included**): add a per-table exporter override in `systemBackupService`:
  ```ts
  const FILTERED_EXPORTERS: Record<string, () => Promise<unknown[]>> = {
    coverage_receptions: () => databaseService.coverageReceptions.exportSurveyReceptions(windows),
  };
  ```
  `exportSurveyReceptions(windows)` is a Drizzle query in the repository (rows inside any survey's effective window, all sources), **with the `id` column omitted**. Add `coverage_receptions` to `BACKUP_TABLES` after `sources` and `coverage_surveys`.
  - Restore DELETEs the whole `coverage_receptions` table first, then inserts the survey rows. Non-survey rows are lost on restore. That is fine: they are regenerable and a restore rewinds time anyway. Document it.
  - **PG sequence trap (why `id` is omitted):** restore inserts explicit ids and never resets PG sequences (`systemRestoreService.ts` has no `setval`). `insertIgnore` on PG is `onConflictDoNothing()` with **no target**, so a later reception whose serial id collides with a restored id is **silently dropped**. Recording would quietly lose rows until the sequence passes the max restored id. Omitting `id` makes every restored row take a fresh id. The same trap is why `coverage_surveys.id` is a UUID.
  - Size: a 1 h drive at 30 s heard by 30 gateways ≈ 3.6k rows ≈ 2 MB JSON. The caps (U4) bound the worst case.
- Pre-existing, **not fixed here**: the missing `setval` affects every serial table in `BACKUP_TABLES` on PG. File a separate issue.

### 2b.7 Survey UI — WP3

- `src/hooks/useCoverageSurveys.ts` (+ test): `useCoverageSurveys()` (key `['analysis','coverageReport','surveys']`), `useCreateSurvey`, `useUpdateSurvey`, `useStopSurvey`, `useDeleteSurvey` (TanStack `useMutation`, invalidate the list key). Fetchers in `src/services/analysisApi.ts` read `body.data`.
- `src/types/coverage.ts`: `CoverageSurveyDto`, `CreateCoverageSurveyBody`, `UpdateCoverageSurveyBody` (WP0).
- New `CoverageSurveyBar.tsx` (+ module CSS, test):
  - Survey picker (`SearchableSelect`, "No survey" empty option). Picking one sets sender, a custom window `[startAt, effectiveEndAt]` (live → `now` at resolve time; Refresh re-anchors), the deselected-receiver set from `receivers` (new helper `deselectedFromReceiverFilter(receivers, entries)` in `coverageReceiverFilter.ts`), and passes `intervalSec` to `detectCoverageGaps` as `configuredIntervalSec`.
  - "Start survey" (needs a sender; authenticated only; hidden for anonymous): name defaults to `"<sender name> <local date time>"`, confirms via `Modal` with a one-line "MeshMonitor sends nothing; set up the survey node per the guidance."
  - "Stop survey" on a live selection with `canEdit`.
  - "Save as survey" (sender + current window + current receiver filter).
  - Edit (name, notes, interval) and Delete (confirm `Modal`), `canEdit` only.
  - Live badge with elapsed time and "auto-ends at …" (the cap).
- `CoverageReport.tsx`: holds `selectedSurveyId`; deep link `survey=<id>` selects it at mount. Changing sender/window by hand clears the survey selection.

### 2b.8 Constants (WP0, `src/utils/coverage.ts`), final per U4

```ts
export const COVERAGE_SURVEY_LIVE_MAX_MS = 24 * 3_600_000;   // live survey auto-ends
export const COVERAGE_SURVEY_MAX_RANGE_MS = 7 * 86_400_000;  // saved past range
export const COVERAGE_SURVEY_MAX_PER_USER = 50;
export const COVERAGE_SURVEY_MAX_TOTAL = 500;
export function effectiveSurveyEndAt(s: { startAt: number; endAt: number | null }, nowMs: number): number;
```

---

## 3. Test plan (standard Vitest; PG/MySQL containers up for P4b)

**P4a**
- Pure: `coverageGaps.test.ts` (§2a.2 cases), `coverageSummary.test.ts` (median odd/even/empty; furthest-direct ignores relayed and null-snapshot rows; best/worst with nulls), `coverageGrid.test.ts` (cell size in metres at 0° and 60° latitude; median per cell; null bests), `coverageExport.test.ts` (RFC 4180 quoting; formula guard on `=cmd` name but not `-7.5` SNR; GeoJSON `[lon, lat]` order; gap LineStrings; `truncated` flag), `coverageDeepLink.test.ts` (round trip; rejects bad sender/range; ignores other `report=`), `coverage.test.ts` (`firstReceivedAt`).
- Components: `CoverageMap.test.tsx` (polylines per gap; rectangles in grid view, no dots; `preferCanvas` passed), `BaseMap` test (passthrough), `CoverageSummaryPanel.test.tsx` (single vs all senders; table rows), `CoverageDistanceChart.test.tsx` (series cap + Other; downsample ≤ 3000; empty state), `CoverageExportButtons.test.tsx` (disabled when empty; calls `downloadTextFile` with the right mime), `CoverageReport.test.tsx` (deep link seeds sender + preset once; `SearchableSelect` filters senders; synthetic option for an unknown deep-linked sender; view toggle keeps `fitKey`), **`CoverageReport.queryStability.test.tsx` extended**: deep-link props and the grid/summary memos must not change the receptions query key across renders; `AnalysisTab.test.tsx` (MemoryRouter; `?report=coverage` opens the report; Back clears params); `ShowCoverageLink.test.tsx` (Link inside a Router, `<a href>` with basename outside; hides for bad ids); `NodeDetailsBlock` + `MeshCoreContactDetailPanel` tests (link present with the right href).
- No route or DB tests change in P4a.

**P4b**
- Migration: `173_create_coverage_surveys.test.ts` (SQLite, idempotent re-run), `.pgmysql.test.ts` (isolated DBs).
- Repository: `coverageSurveys.test.ts` (CRUD, live lookup, `getExemptionWindows` caps live at `startAt + LIVE_MAX`), `coverageSurveys.multiBackend.test.ts` (`isolationKey: 'covsv'`; UUID PK and bigint times round-trip on PG/MySQL), `coverageReceptions.retention.test.ts` extended (row inside a survey window survives; same sender outside the window purged; other sender inside the window purged; live survey past its cap stops exempting; empty exemptions = P1 behaviour), multi-backend retention case on PG/MySQL (the `not(or(and…))` SQL must run on all three).
- Routes (harness, `coverageSurveyRoutes.test.ts`): anonymous list = `[]`, anonymous POST = 401; user without read on the sender's source cannot see or create a survey for it (403 `SENDER_NOT_VISIBLE`); a MeshCore sender with no `meshcore_nodes` row is invisible even to its would-be creator unless admin; creator can edit/stop/delete, other user 403, admin allowed; `SURVEY_ALREADY_LIVE`; caps; range validation; `/receivers?since=` returns receivers from an old survey window.
- `coverageSurveys.perSource.test.ts`: two sources, sender only on source A; a user limited to source B sees no survey and gets no rows from `/receptions` for the survey window.
- Backup: `systemBackupService.test.ts` (manifest has `coverage_surveys`, and `coverage_receptions` if U3 = include; exported survey receptions have no `id` and only in-window rows); restore test (restored receptions get fresh ids; a new `recordReception` after restore inserts, does not silently drop — run on PG).
- Retention service test: `runCleanup` passes the windows from the survey repo.
- Hooks/UI: `useCoverageSurveys.test.ts` (invalidation), `CoverageSurveyBar.test.tsx` (start needs sender; anonymous hides write buttons; picking a survey sets sender/window/receivers/interval; stop only when live + canEdit), `coverageReceiverFilter.test.ts` (`deselectedFromReceiverFilter`).
- Full suite with PG (5433) and MySQL (3307) containers; confirm `numPendingTests` did not jump. `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` empty.

**Browser validation (both PRs):** a single-sender window with a known hole shows a dashed line and the matching gap count; grid view at 250 m; CSV and GeoJSON open cleanly (GeoJSON in geojson.io); "Show coverage" from both node detail views lands on the report with the sender and 24 h set; real-mouse click on a canvas dot opens the popup. P4b: start a live survey, stop it, restart the container and confirm the survey and its end survive; set retention to 1 day on the dev box with an older survey and confirm the sweep keeps its rows.

---

## 4. Work packages

### P4a

**Order:**
1. **WP0** (orchestrator, one commit before forking): §2a.1 — `firstReceivedAt` + constants in `src/utils/coverage.ts` (+test), and the types-only `src/types/coverageAnalysis.ts`.
2. **WP1–WP6 in parallel** from WP0. WP2–WP5 import WP1's functions by the signatures in §2a.2–§2a.5 and mock them in their own tests where needed.
3. **Merge order:** WP1 first (the others' real imports resolve against it), then WP2, WP3, WP5, WP6 in any order, **WP4 last** (it wires WP1–WP3 together). Re-run WP4's tests after the merge.
4. Orchestrator: en.json keys (§2a.10), docs, epic phase log, full suite, lint ratchet.

| WP | Scope | Est. LOC (incl. tests) |
|---|---|---|
| WP0 | `coverage.ts` constants + `firstReceivedAt`; `types/coverageAnalysis.ts` | ~120 |
| WP1 | Pure utils: `coverageGaps`, `coverageSummary`, `coverageGrid`, `coverageExport`, `coverageDeepLink` | ~1,250 |
| WP2 | `BaseMap` `preferCanvas` passthrough, `CoverageMap` gaps + grid + canvas | ~450 |
| WP3 | `CoverageSummaryPanel`, `CoverageDistanceChart`, `CoverageExportButtons` | ~800 |
| WP4 | `CoverageReport` integration, sender search, view toggle, `AnalysisTab` deep link | ~550 |
| WP5 | `ShowCoverageLink`, `NodeDetailsBlock`, `MeshCoreContactDetailPanel` | ~250 |
| WP6 | Styled confirm in `CoverageMqttRecordingSection` | ~150 |

| File | WP0 | WP1 | WP2 | WP3 | WP4 | WP5 | WP6 |
|---|---|---|---|---|---|---|---|
| `src/utils/coverage.ts` (+test) | **owns** | import | import | import | import | import | — |
| `src/types/coverageAnalysis.ts` | **owns** (new) | import | import | import | import | import | — |
| `src/utils/coverageGaps.ts`, `coverageSummary.ts`, `coverageGrid.ts`, `coverageExport.ts`, `coverageDeepLink.ts` (+tests) | — | **owns** (new) | import | import | import | import | — |
| `src/components/map/BaseMap.tsx` (+test) | — | — | **owns** | — | — | — | — |
| `src/components/Analysis/CoverageMap.tsx` (+test, `CoverageMap.module.css`) | — | — | **owns** | — | — | — | — |
| `CoverageSummaryPanel.tsx`, `CoverageDistanceChart.tsx`, `CoverageExportButtons.tsx` (+tests, `CoverageSummaryPanel.module.css`) | — | — | — | **owns** (new) | import | — | — |
| `CoverageReport.tsx` (+ `.test.tsx`, `.queryStability.test.tsx`, `.module.css`), `AnalysisTab.tsx` (+test) | — | — | — | — | **owns** | — | — |
| `src/components/Analysis/ShowCoverageLink.tsx` (+test), `NodeDetailsBlock.tsx` (+ new `NodeDetailsBlock.showCoverage.test.tsx`), `MeshCore/MeshCoreContactDetailPanel.tsx` (+test) | — | — | — | — | — | **owns** | — |
| `src/components/settings/CoverageMqttRecordingSection.tsx` (+test) | — | — | — | — | — | — | **owns** |
| `public/locales/en.json`, `docs/**` | orchestrator only, after all WPs |||||||

No two WPs edit the same file. `CoverageReceiverFilter.tsx`, `useCoverageData.ts`, `analysisApi.ts` and every server file stay untouched in P4a.

### P4b

**Order:** WP0 (orchestrator: DTO types in `src/types/coverage.ts`, survey constants + `effectiveSurveyEndAt` in `coverage.ts` with tests). Then WP1 and WP2 in parallel (WP2 codes against the repository interface in §2b.4; merge WP1 first). WP3 after WP0, in parallel with WP1/WP2, merges last. Orchestrator: i18n, docs, epic log.

| WP | Scope | Est. LOC |
|---|---|---|
| WP0 | Types + constants | ~150 |
| WP1 | Schema, migration 173, `coverageSurveys` repo, purge seam, retention service wiring, `exportSurveyReceptions`, `DatabaseService` wiring, all DB tests | ~1,500 |
| WP2 | Survey routes, `/receivers` since/until, backup service + tests | ~1,300 |
| WP3 | Fetchers, hooks, `CoverageSurveyBar`, `deselectedFromReceiverFilter`, `CoverageReport` survey wiring | ~900 |

| File | WP0 | WP1 | WP2 | WP3 |
|---|---|---|---|---|
| `src/types/coverage.ts`, `src/utils/coverage.ts` (+test) | **owns** | import | import | import |
| `src/db/schema/coverageSurveys.ts`, `schema/index.ts`, `db/activeSchema.ts` | — | **owns** | — | — |
| `src/server/migrations/173_*` (+tests), `src/db/migrations.ts` | — | **owns** | — | — |
| `src/db/repositories/coverageSurveys.ts` (+tests), `coverageReceptions.ts` (+retention/multiBackend tests), `repositories/index.ts` | — | **owns** | — | — |
| `src/services/database.ts` | — | **owns** | — | — |
| `src/server/services/coverageRetentionService.ts` (+test) | — | **owns** | — | — |
| `src/server/routes/coverageRoutes.ts`, new `coverageSurveyRoutes.ts` (+tests, perSource test) | — | — | **owns** | — |
| `src/server/services/systemBackupService.ts` (+tests), `systemRestoreService` tests | — | — | **owns** | — |
| `src/services/analysisApi.ts`, `src/hooks/useCoverageSurveys.ts`, `src/utils/coverageReceiverFilter.ts` (+tests) | — | — | — | **owns** |
| `CoverageSurveyBar.tsx` (+test, CSS), `CoverageReport.tsx` (+tests) | — | — | — | **owns** |
| `en.json`, `docs/**` | orchestrator only |

---

## 5. Decisions and open questions

### User decisions (final, 2026-09-24)

- **Split:** P4a then P4b, separate PRs; P4a ships first.
- **U1. Gap rule: accepted as proposed.** Interval = configured, else P25 of spacings (≥ 5 samples, clamped 15–900 s), else 30 s Meshtastic / 60 s MeshCore. Gap if spacing > max(2.5 × interval, 60 s), ≤ 30 min, and the sender moved ≥ 200 m. Gaps only with one sender selected, "any receiver in scope". Every threshold lives in one place: the constants block in `src/utils/coverage.ts` (§2a.1).
- **U2. Survey permissions.** List: admins see all; others see their own plus surveys whose sender they can see; anonymous sees none. Create: any logged-in user who can see the sender. Stop/edit/delete: creator or admin.
- **U3. Backup:** back up `coverage_surveys` **and** the receptions inside survey windows, with `id` dropped (§2b.6).
- **U4. Caps:** a live survey auto-ends 24 h after its stored start, computed at read time (no timer); a saved range is ≤ 7 days; 50 surveys per user, 500 total.
- **U5. Global table: yes.** The P4b PR adds `coverage_surveys` to the CLAUDE.md global-by-design exceptions list.
- **U6. Wipes:** source deletion and purge-all-nodes still delete receptions, survey windows included; the survey row stays and shows 0 receptions.
- **U7.** SF-aware link margin deferred again (MQTT gateways and MeshCore observers report no spreading factor). Styled confirm included in P4a (WP6). `preferCanvas` on; browser validation must click canvas dots with real mouse events.
- **PG restore sequence bug:** out of this epic; the coordinator handles it separately. The note under "Flagged, not changed" stays.

### Architect decisions

- **A1.** Split P4 into P4a (no schema) and P4b (surveys).
- **A2.** Gaps, summary, grid and export are pure client-side functions over already-loaded, already-privacy-filtered rows. No new endpoint in P4a, so no new privacy surface.
- **A3.** Grid median uses one value per fix (its best reception), matching the dot colour; metre cells, not zoom-keyed degree bins. The existing `/coverage-grid` is not reused (different data, no signal).
- **A4.** Export is client-side and matches what the user sees (filters, privacy, 10k cap). It says when it is truncated.
- **A5.** CSV guards against formula injection; `escapeCsv` stays untouched.
- **A6.** `preferCanvas` on, via a new explicit `BaseMap` prop.
- **A7.** Deep link = `/reports?report=coverage&sender=…&range=24h[&survey=…]`, parsed once at mount. `ShowCoverageLink` falls back to `<a href>` outside a Router.
- **A8.** Survey ids are UUIDs; exported survey receptions omit `id` (PG sequence trap).
- **A9.** The retention exemption keys on sender + window only, across all sources; the survey's receiver filter is a view preference.
- **A10.** Live survey end is lazy (no timer); `startAt` in the DB makes it restart-safe.
- **A11.** `/receivers` gains `since`/`until` so surveys older than the retention window still list their receivers.
- **A12.** i18n keys land in one orchestrator commit per PR; no WP edits `en.json`.

### Open questions for implementers (no user input needed)

- P4a WP4: the summary and chart sit below the map; if the page gets long on mobile, collapse the chart behind a disclosure (keep the tiles visible).
- P4a WP2: gap line colour must come from a theme token; if no suitable overlay colour exists, use `var(--color-text-muted)` read via `getComputedStyle` the same way `LinkQualityChart` reads chart colours.
- P4b WP2: if no shared audit helper fits, log with `logger.info` and note it in the PR.

### Flagged, not changed

- PG restore never resets sequences for serial tables (`systemRestoreService.ts`); combined with target-less `onConflictDoNothing()` in `insertIgnore`, restored PG installs can silently drop inserts into any restored serial table until the sequence catches up. P4b avoids it for its own tables; the coordinator tracks the general fix outside this epic.
- MySQL `insertIgnore` swallows every insert error, not just duplicates (`base.ts:219`). Pre-existing.
