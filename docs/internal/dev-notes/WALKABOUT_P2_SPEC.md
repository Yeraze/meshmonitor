# Walkabout Coverage Epic (#5891): Phase 2 Implementation Spec

Phase 2 = the H3 hex view. Plan and binding decisions:
`WALKABOUT_COVERAGE_EPIC.md`. What P1 built: `WALKABOUT_P1_SPEC.md` (read
its "Resolutions"). Read both first, then this.

Sections: 1 reuse inventory · 2 file-by-file · 3 mesh impact · 4 tests ·
5 work packages · 6 open questions.

**Five decisions shape the rest. Each is argued where it lands:**

1. **No schema change.** The server computes cell ids on read from the
   `latitude`/`longitude` P1 already stores on every sample and reception
   (§2.2). No migration 249.
2. **Bin at res 9, then take the parent.** A coarser cell is always
   `cellToParent(latLngToCell(p, 9), res)`, never `latLngToCell(p, res)`.
   Measured on 200k random points: the two rules disagree for 6.1 % of points
   at res 7 and 7.2 % at res 8. One rule keeps the hexes, the popup and the
   tests in agreement (§2.3).
3. **Hide before binning.** A reception whose credited node fails
   `buildPositionFilter` / `buildMeshCorePositionFilter` is dropped before it
   touches a cell, so best SNR and counts cannot place a hidden node. The
   response reports one window-wide `hiddenReceptionCount` (§2.4, Q1).
4. **Stable requests.** The client sends `window=24h|7d|14d|30d` or
   `sessionId` (or, from the Coverage report, its already-resolved
   `since`/`until`), plus `res=7|8|9`. No bounding box and no `Date.now()`
   in a query key. Fit-to-bounds uses a res-independent box from the server
   and runs once per source + window, never on a res change (§2.10).
5. **`h3-js` loads with the map, client and server.** On the client, one
   lazily loaded module, `WalkaboutHexMap.tsx`, is the only importer. The
   server imports it normally (§2.6, §2.9).

---

## 1. Reuse inventory (read first)

### 1.1 Map shell and layers

| Reuse | Where | Use |
|---|---|---|
| `BaseMap` | `src/components/map/BaseMap.tsx` | The hex map composes it (CLAUDE.md rule) with `preferCanvas` (Coverage decision A6: thousands of polygons pan smoothly on canvas). Settings via `useBaseMapSettings()`; centre/zoom defaults via `useSettings()` as `CoverageMap.tsx:258-295` does. |
| `FitCoverageBounds` | private in `src/components/Analysis/CoverageMap.tsx:154` | **Extract** to `src/components/map/FitBoundsOnce.tsx` (same body, renamed) and use it from both `CoverageMap` and the hex map. Fits once per `fitKey`; the hex map passes a key without `res`, which is what stops the fit → zoom → res → refetch loop. Three other private fit controllers exist (`RouterClusterMap`, `ExplorerMap`, `RouteFlowMap`; not checked whether each is fit-once); leave them. |
| react-leaflet `Polygon`, `Polyline`, `Popup`, `useMapEvents` | as in `CoverageMap.tsx:40` and `GeofenceMapEditor.tsx` | Hexes are `Polygon`s, the track a `Polyline`, zoom tracking `useMapEvents({ zoomend })`. No new layer type. |
| `lazyWithPreload` | `src/utils/lazyWithPreload.ts` (precedent: MapLibre in `BaseMap.tsx:11`) | The split point for the hex map. The `eagerCss` plugin (`vite.config.ts:63-135`) follows `lazyWithPreload(() => import('x'))`, keeps the CSS module in the entry sheet, and skips `node_modules` JS, so `h3-js` stays in the lazy chunk. Keep the call in that exact shape. |
| `Coverage` legend pieces | `CoverageMap.tsx:633-660` (`.legend`, `.legendRow`, `.legendSwatch`, `LegendRow`) | Copy the markup shape into the hex map's own CSS module (CSS containment rule: a new component gets its own module; do not import another component's module). |

### 1.2 Colours

| Reuse | Where | Use |
|---|---|---|
| `overlayColors.snrColors` | `src/config/overlayColors.ts:16,44,76` via `useSettings().overlayColors` | Bucket fills. Theme-aware and already resolved hex literals, which a canvas renderer needs (`CoverageMap.tsx:71-76` explains why `var(--x)` fails on canvas). Mapping: strong → `excellent`, medium → `good`, weak → `fair`, none → `poor`, unknown → `noData`. |
| `snrToColor` | `src/utils/mapHelpers.tsx:191` | **Not reused.** Its bands (≥5 / ≥0 / ≥−5) differ from the epic's (≥0 / ≥−5 / ≥−10), and it has no "walked here, heard nothing" case. A new pure `walkaboutBucket()` (§2.6) feeds the same palette. |
| New key `overlayColors.walkaboutTrack` | `src/config/overlayColors.ts` | The track line. No existing key means "the walker's route"; reusing a traceroute or SNR colour would read as signal. Dark: Mocha blue; light: darkened Latte blue that clears the file's AA-on-cream bar (state the measured ratio in the comment, as the file does). |

### 1.3 Filters, windows, names, visibility

| Reuse | Where | Use |
|---|---|---|
| `buildPositionFilter`, `buildMeshCorePositionFilter`, `loadNodesBySource`, `loadMeshCoreNodesBySource`, `loadSourcePermissions` | `src/server/utils/positionVisibility.ts:53,82,177,210`, `sourcePermissions.ts` | Credited-node gate (§2.4). Load nodes once per request and reuse them for names, as `coverageRoutes.ts:700-716` does. |
| `parseSenderParam` | `src/server/utils/coverageSenderParam.ts:23` | Parses the `node` query param (`!hex`, decimal, or 64-hex key) into the canonical form P1 stores in `creditedKey`. The Coverage report's `senderId` is already that form. |
| `walkaboutEndsAt`, `isWalkaboutLive` | `src/utils/walkabout.ts:31,36` | The clip end for an open session (`startedAt + cap`). |
| Window chips | `reports-btn reports-btn--ghost` + `activePreset` (`CoverageReport.tsx:540-557`), presets as in `DirectRfContactsReport.tsx:40` | Same markup for 24h/7d/14d/30d. |
| `resolveCoverageWindow` rule | `src/utils/coverageTimeRange.ts` + `CoverageReport.tsx:168-179` comment | **Not reused for chips.** The walkabout chips send the preset name and the server resolves "now", so a key never carries a fresh timestamp. Inside the Coverage report the hex view takes that report's already-resolved `sinceMs`/`untilMs` (stable state), so the documented refetch loop cannot recur. |
| `getUserDisplayName` / `formatCoverageNodeId` | `src/utils/nodeHelpers.ts:374`, `src/utils/coverage.ts:330` | Popup row names: long name, else short name, else id (MeshCore key abbreviated). Tolerates null names (redaction rule). |
| `useWalkaboutSources`, `walkaboutKeys`, `walkaboutApi` | `src/hooks/useWalkabout.ts`, `src/services/walkaboutApi.ts` | Extend; the source list is fetched once, never polled. |
| `ok` / `fail`, `requireAuth`, `requirePermission(..., { sourceIdFrom: 'params.id', requireSourceId: true })`, `WALKABOUT_READ_GRANT` | `walkaboutRoutes.ts:31-39` (`canRead`) | Every new route uses `canRead`. |

### 1.4 Considered and not reused

| Piece | Why not |
|---|---|
| `CoverageReceiverFilter` | It picks among many fixed receivers per source. A walkabout has one receiver, the source radio, so there is nothing to pick. The hex view uses a source `<select>` and a session `<select>`. |
| `binFixesToGrid` / `CoverageGridCell` (`src/utils/coverageGrid.ts`) | Metre squares, median of one sender's fixes. The epic fixes H3 hexes and best-per-cell. |
| `/api/analysis/coverage-grid` + `CoverageHeatmapLayer` | Counts `telemetry` positions per degree bin; no signal values. |
| `CoverageMap` | Built around fixes and receiver markers. The hex map is a separate component so the two coverage models never share one map (§2.10). |

### 1.5 New pieces, and the closest existing one

- `src/server/utils/walkaboutH3.ts` (server h3 wrapper): nothing in the tree uses H3.
- `src/server/services/walkaboutCells.ts` (clip, gate, bin): closest is `coverageRoutes.ts /receptions` (fetch, gate, shape). Kept out of the route file so the binning is pure and unit-tested.
- `src/components/Analysis/WalkaboutHexMap.tsx`: closest is `CoverageMap`; see §1.4.
- `src/components/Analysis/WalkaboutMapPanel.tsx`: chips + session picker + lazy map for the Walkabout report; closest is `CoverageReport`'s control row, which carries far more.

---

## 2. File-by-file changes

### 2.1 Dependency: `h3-js@4.5.0` (WP0)

`npm install h3-js@4.5.0` into **`dependencies`** (the server needs it at
runtime; Docker, LXC and desktop install `dependencies`). Commit
`package.json` + `package-lock.json`. No `@types` package: it ships
`dist/types.d.ts`.

Checked in a scratch install:
- Node ESM named imports work: `import { latLngToCell, cellToParent, cellToChildren, cellToBoundary, isValidCell, getResolution } from 'h3-js'`.
- Speed: 100k `latLngToCell` in 93 ms, 100k `cellToParent` in 21 ms.
- The browser build (`dist/browser/h3-js.es.js`, picked by Vite through the
  `browser` field) is 546 KB raw, **96 KB gzip**. Far under the 3.6 MiB
  single-asset cap; it must not reach `main-*.js` (350 KiB budget) or the
  Reports chunk.
- Average edge (h3-js `getHexagonEdgeLengthAvg`): res 7 = 1 406 m, res 8 =
  531 m, res 9 = 201 m. Width across flats = √3 × edge: 2.44 km, 920 m, 348 m.

### 2.2 Store the cell id, or compute it on read? Compute. No migration.

P1 copies `latitude`/`longitude` onto every reception and keeps them on every
sample, so the inputs are already there.

- **Cost on read is small.** 100k points bin in ~0.1 s (above). A 2 h
  session holds ≤ 1 440 samples and a few thousand receptions; 30 days of
  daily walks is ~100k rows.
- **The rows reach Node anyway.** The visibility gate (§2.4) runs per credited
  node in JS, so a SQL `GROUP BY cell` would still have to carry the
  credited key and could not shrink the transfer much.
- **A stored column costs more than it saves.** Migration 249 on three
  backends, the hand-written PG/MySQL bootstrap in
  `coverageWalkabout.multiBackend.test.ts`, and a second path for rows
  without a cell: P1 rows, and any backup restored from before 249, since
  backup is a full-table dump. Two code paths for one value.
- **Caps keep it bounded**: ≤ 100 000 reception rows and ≤ 100 000 sample
  rows per request; past either, the response says `truncated: true` (§2.5).

If a deployment ever hits the cap in normal use, a stored `h3Res9` column is
the follow-up, behind the same service functions. Not now.

**Query paths** use P1's indexes: sessions by `(sourceId, startedAt)`, then
receptions by `(sessionId, heardAt)` and samples by `(sessionId, fixAt)` with
`sessionId IN (...)`. The window query never scans a source by time alone.

### 2.3 Server H3 wrapper `src/server/utils/walkaboutH3.ts` (new) — WP1

```ts
import type { WalkaboutH3Res } from '../../types/walkabout.js';
/** Res-9 cell, then its parent: the only binning rule (decision 2). */
export function walkaboutCellOf(lat: number, lon: number, res: WalkaboutH3Res): string;
/** isValidCell + getResolution in 7..9. */
export function parseWalkaboutCell(raw: unknown): { cell: string; res: WalkaboutH3Res } | null;
/** Bounding box of every res-9 child of `cell` (children stick out past the
 *  parent's outline, so the parent's own boundary is too small). null when
 *  the box spans more than 180° of longitude (antimeridian): skip the prefilter. */
export function walkaboutCellBBox(cell: string): { south: number; north: number; west: number; east: number } | null;
```
`WALKABOUT_H3_BASE_RES = 9` lives in `src/utils/walkabout.ts`. A res-7 cell has
49 res-9 children; computing their boundaries for one popup is trivial.

### 2.4 Visibility: who sees which receptions

**Rule (decision 3, Q1):** before binning, drop every reception whose credited
node fails the gate, for the row's own `sourceId`:
- Meshtastic (`protocol === 'meshtastic'`): `posFilter({ sourceId, nodeNum: creditedNodeNum })`.
  A null `creditedNodeNum` drops the row (P1 always sets it for Meshtastic).
- MeshCore: `mcFilter({ sourceId, publicKey: creditedKey })`.

Why the position gate and not just `nodes:read`: the hex says "node X was
heard here", and a direct reception puts X within radio range of that hex.
That is position data about X, so X's map rules apply, as the Coverage report
applies them to senders (`coverageRoutes.ts:718-736`).

What follows, stated so nobody is surprised:
- Admins still lose `hideFromMap` nodes and nodes no longer on the source
  (display gates apply to everyone).
- A `nodes:read` holder without `channel_N:viewOnMap` (Meshtastic) or
  `nodes:viewOnMap` (MeshCore) sees the track and sample-only "no signal"
  cells, but no hexes from those nodes. The map shows a banner with
  `hiddenReceptionCount` ("12 receptions from nodes you cannot see on the map
  are not shown") so an all-red map is explained, without saying where.
- With `node=X` and X failing the gate, the route returns `cells: []` and
  `hiddenReceptionCount: 0`, so it does not confirm X was heard anywhere.

**The walker's track and the sample cells are not node positions.** They are
the phone's GPS, which the maintainer made visible to any `nodes:read` holder
on the source (P1 Q6). No node gate applies to them.

**Public instance.** Every route sits behind `requireAuth()`; anonymous
callers get 401, which the sentinel audit counts as denied. That is the only
reason the response may carry H3 cell ids: **a cell id is a position the
redaction catalogue does not recognise.** These routes must never drop
`requireAuth()`. Field names still follow the catalogue as defence in depth:
`positions` (coordinate array), `longName`, `shortName`, `publicKey`, `*At`.

### 2.5 Repository additions `src/db/repositories/coverageWalkabout.ts` — WP1

All take `sourceId` and scope with `withSourceScope` on every table read.
Bigint columns `Number()` on read, as the existing mappers do.

```ts
export interface WalkaboutReceptionPoint {
  sessionId: string; protocol: 'meshtastic' | 'meshcore';
  creditedKey: string; creditedNodeNum: number | null;
  snr: number | null; heardAt: number; latitude: number; longitude: number;
}
export interface WalkaboutSamplePoint { sessionId: string; fixAt: number; latitude: number; longitude: number; }
export interface WalkaboutBBox { south: number; north: number; west: number; east: number; }

/** Sessions that may overlap [sinceMs, untilMs]: startedAt <= untilMs AND
 *  startedAt >= sinceMs - WALKABOUT_MAX_DURATION_MS (no session outlives the
 *  cap). The caller applies the exact overlap test with walkaboutEndsAt.
 *  Newest first, `limit` rows. */
listSessionsInRange(sourceId: string, sinceMs: number, untilMs: number, limit: number): Promise<DbWalkaboutSession[]>

/** Raw points; no clipping (the service clips per session). `limit` rows max,
 *  ordered by heardAt DESC then id DESC (deterministic; a cap drops old rows). */
getReceptionPoints(sourceId: string, q: {
  sessionIds: string[]; sinceMs: number; untilMs: number;
  creditedKey?: string; bbox?: WalkaboutBBox; limit: number;
}): Promise<WalkaboutReceptionPoint[]>

/** Same shape for samples, on fixAt; ordered by fixAt DESC then id DESC. */
getSamplePoints(sourceId: string, q: {
  sessionIds: string[]; sinceMs: number; untilMs: number; bbox?: WalkaboutBBox; limit: number;
}): Promise<WalkaboutSamplePoint[]>
```
Order **newest first** (`heardAt` / `fixAt` descending, then id), so a capped
read drops the oldest rows, not the newest. Empty `sessionIds` returns `[]`
with no query. Select only the listed columns.
Use Drizzle `between` / `inArray` / `gte` / `lte`; no raw SQL needed.

### 2.6 Shared constants and pure functions `src/utils/walkabout.ts` + `src/types/walkabout.ts` — WP0

**`src/utils/walkabout.ts`** stays frontend-safe and **must not import
`h3-js`** (`WalkaboutReport` imports it statically, which would pull the
library into the Reports chunk). Add:

```ts
export const WALKABOUT_H3_BASE_RES = 9;
export const WALKABOUT_MAP_WINDOWS_MS = {
  '24h': 86_400_000, '7d': 7 * 86_400_000, '14d': 14 * 86_400_000, '30d': 30 * 86_400_000,
} as const;
export const WALKABOUT_MAX_RANGE_MS = 31 * 86_400_000;      // since/until span cap
export const WALKABOUT_MAX_RX_ROWS = 100_000;
export const WALKABOUT_MAX_SAMPLE_ROWS = 100_000;
export const WALKABOUT_MAX_CELLS = 5_000;
export const WALKABOUT_MAX_CELL_NODES = 200;
export const WALKABOUT_MAX_TRACK_POINTS = 2_000;            // 2 h / 5 s = 1 440, plus slack
export const WALKABOUT_MAX_RANGE_SESSIONS = 500;
/** Epic defaults, dB. A value equal to a bound belongs to the band above it. */
export const WALKABOUT_SNR_STRONG_DB = 0;    // strong:  snr >= 0
export const WALKABOUT_SNR_MEDIUM_DB = -5;   // medium: -5 <= snr < 0
export const WALKABOUT_SNR_WEAK_DB = -10;    // weak:  -10 <= snr < -5;  none: snr < -10
export type WalkaboutBucket = 'strong' | 'medium' | 'weak' | 'none' | 'unknown';
/** receptionCount 0 (walked here, heard nothing) -> 'none'.
 *  receptions but every SNR null -> 'unknown'. */
export function walkaboutBucket(c: { bestSnr: number | null; receptionCount: number }): WalkaboutBucket;
/** zoom >= 14 -> 9; 12..13 -> 8; <= 11 -> 7. */
export function walkaboutResForZoom(zoom: number): WalkaboutH3Res;
```

**Zoom thresholds, justified by hex width on screen.** Metres per pixel =
156 543 × cos(lat) / 2^zoom. At 40° latitude:

| Zoom | m/px | Res | Hex width | On screen |
|---|---|---|---|---|
| 14 | 7.3 | 9 | 348 m | 47 px |
| 13 | 14.6 | 8 | 920 m | 63 px (res 9 would be 24 px) |
| 12 | 29.3 | 8 | 920 m | 31 px |
| 11 | 58.6 | 7 | 2.44 km | 42 px |
| 10 | 117 | 7 | 2.44 km | 21 px |

So each switch keeps a hex at ~30–60 px, a fingertip on a phone. At the
equator the numbers shrink by ~25 % (z14 → 36 px, z12 → 24 px); nearer the
poles they grow. Below zoom 10 hexes get small, but nobody taps a single hex
at country scale. One more level up, res 6, would add a fetch for little use.

**`src/types/walkabout.ts`** add:

```ts
export type WalkaboutH3Res = 7 | 8 | 9;
export type WalkaboutMapWindow = '24h' | '7d' | '14d' | '30d';
/** Exactly one of the three; `node` narrows to one credited node. */
export type WalkaboutMapQuery =
  | { kind: 'window'; window: WalkaboutMapWindow; node?: string }
  | { kind: 'session'; sessionId: string; node?: string }
  | { kind: 'range'; sinceMs: number; untilMs: number; node?: string };
export interface WalkaboutCellDto {
  cell: string;                 // H3 index (15 hex chars). A position; see §2.4.
  bestSnr: number | null;       // max non-null SNR in the cell
  receptionCount: number;
  nodeCount: number;            // distinct credited nodes (visible only)
  sampleCount: number;          // GPS samples in the cell; > 0 with receptionCount 0 = "no signal"
}
export interface WalkaboutCellsResult {
  res: WalkaboutH3Res;
  windowStartAt: number; windowEndAt: number;
  cells: WalkaboutCellDto[];
  truncated: boolean;           // any row/session/cell cap hit
  hiddenReceptionCount: number;
  /** Box around every clipped, visible reception and sample (raw lat/lon, not
   *  hex outlines), so it does not depend on res. null when empty. Catalogue
   *  names (bboxNorth etc. are latitude/longitude keys). */
  bounds: { bboxSouth: number; bboxNorth: number; bboxWest: number; bboxEast: number } | null;
}
export interface WalkaboutCellNodeDto {
  protocol: 'meshtastic' | 'meshcore';
  nodeId: string | null;        // Meshtastic '!xxxxxxxx'
  nodeNum: number | null;       // Meshtastic
  publicKey: string | null;     // MeshCore, 64-hex lowercase
  longName: string | null; shortName: string | null;
  bestSnr: number | null; receptionCount: number; lastHeardAt: number;
}
export interface WalkaboutCellNodesResult { cell: string; nodes: WalkaboutCellNodeDto[]; truncated: boolean; }
export interface WalkaboutTrackResult { sessionId: string; positions: Array<[number, number]>; truncated: boolean; }
```

### 2.7 Service `src/server/services/walkaboutCells.ts` (new) — WP1

Pure functions first, then three async entry points the routes call. No
`dataEventEmitter`, no timers, no writes.

```ts
export interface ResolvedRange { sinceMs: number; untilMs: number; sessions: DbWalkaboutSession[]; truncated: boolean; }
/** session: [startedAt, walkaboutEndsAt(s)]. window: [now - W, now].
 *  range: as given. Window/range: listSessionsInRange + exact overlap test. */
export async function resolveWalkaboutRange(sourceId: string, q: WalkaboutMapQuery, nowMs?: number): Promise<ResolvedRange | null>; // null = session not found

/** Keep rows with session.startedAt <= t <= walkaboutEndsAt(session), and
 *  inside [sinceMs, untilMs]. Receptions clip on heardAt, samples on fixAt. */
export function clipToSessions<T extends { sessionId: string }>(
  rows: T[], sessions: DbWalkaboutSession[], at: (r: T) => number, sinceMs: number, untilMs: number,
): T[];

/** Bin with walkaboutCellOf. Per cell: max non-null snr, count, distinct
 *  creditedKey, sample count. Sort receptionCount desc, then sampleCount
 *  desc, then cell; cut at WALKABOUT_MAX_CELLS (truncated). */
export function binWalkaboutCells(rx: WalkaboutReceptionPoint[], samples: WalkaboutSamplePoint[], res: WalkaboutH3Res): { cells: WalkaboutCellDto[]; truncated: boolean };

/** Rows of one cell grouped by creditedKey. Sort bestSnr desc (nulls last),
 *  then receptionCount desc; cut at WALKABOUT_MAX_CELL_NODES. */
export function groupCellNodes(rx: WalkaboutReceptionPoint[], cell: string, res: WalkaboutH3Res, names: (row) => { longName; shortName }): { nodes: WalkaboutCellNodeDto[]; truncated: boolean };

/** One loader per request: nodes for [sourceId] (both protocols), the two
 *  position filters with one shared grants object, and name lookups. */
export async function loadWalkaboutVisibility(user: unknown, sourceId: string): Promise<{
  visible: (r: WalkaboutReceptionPoint) => boolean;
  names: (r: WalkaboutReceptionPoint) => { longName: string | null; shortName: string | null };
}>;

export async function getWalkaboutCells(user: unknown, sourceId: string, q: WalkaboutMapQuery, res: WalkaboutH3Res): Promise<WalkaboutCellsResult | null>;
export async function getWalkaboutCellNodes(user: unknown, sourceId: string, q: WalkaboutMapQuery, cell: string, res: WalkaboutH3Res): Promise<WalkaboutCellNodesResult | null>;
export async function getWalkaboutTrack(sourceId: string, sessionId: string): Promise<WalkaboutTrackResult | null>;
```

`getWalkaboutCells` order:
1. `resolveWalkaboutRange` (null → caller 404s).
2. Read `getReceptionPoints` (`limit: MAX_RX_ROWS + 1`, `creditedKey: q.node`) and `getSamplePoints` (`MAX_SAMPLE_ROWS + 1`) in parallel. A read that returns limit + 1 rows sets `truncated` and keeps `limit`.
3. `clipToSessions` both.
4. If `q.node` is set and that node fails the gate: return `cells: []`, `hiddenReceptionCount: 0`. Otherwise drop failing receptions and count them.
5. `binWalkaboutCells`; `bounds` = min/max of the clipped, visible points.

`getWalkaboutCellNodes`: same steps 1–4, but step 2 passes
`bbox: walkaboutCellBBox(cell)` to both reads (no sample read needed), and
then keeps rows with `walkaboutCellOf(lat, lon, res) === cell` before
`groupCellNodes`. The bbox only narrows the SQL; the exact test decides.

Names: Meshtastic `longName`/`shortName` from the loaded `DbNode`; MeshCore
`longName = node.name`, `shortName = null`, as `/senders` does
(`coverageRoutes.ts:565-575`).

`getWalkaboutTrack`: the session (null → 404), `getSamplePoints` over
`[startedAt, walkaboutEndsAt]` with `MAX_TRACK_POINTS + 1`, clip, map to
`[latitude, longitude]` sorted by `fixAt` ascending (the repo reads newest first).

**Why tracks only for one session.** In window mode the sample-only cells
already show where people walked; drawing up to 500 tracks would pile lines on
a phone and cost up to 720k points. A specific session shows its track.

**Clipping, named precisely.** Receptions clip on `heardAt` (server ms, set at
capture). Samples clip on `fixAt` (server ms, `receivedAt − ageMs`: when the
phone was there). End = `endedAt`, or `startedAt + cap` while open
(`walkaboutEndsAt`). Bounds are inclusive. Why it is needed: P1's
`addSamples` (`walkaboutService.ts:335-338`) admits one in-flight row when a
stop races a post, and the async advert check (`walkaboutService.ts:527-530`)
writes only after a signature check that can finish after a stop.

**Not in P2:** filtering drives by `sampleAgeMs`. P1 §2.10 shows walking at 25 s
stays inside a res-9 cell; a drive filter can come later without new capture.

### 2.8 Routes, added to `src/server/routes/walkaboutRoutes.ts` — WP1

Every route: `...canRead` (`requireAuth()` +
`requirePermission(WALKABOUT_READ_GRANT, { sourceIdFrom: 'params.id', requireSourceId: true })`),
`ok()` / `fail()`, errors through the existing `handleError`. CSRF is not
involved (GET).

| Method + path | Query | Result (`data`) | Errors |
|---|---|---|---|
| `GET /cells` | mode (below), `res` 7\|8\|9 (default 9), `node`? | `WalkaboutCellsResult` | 400 `INVALID_WALKABOUT`; 404 `WALKABOUT_NOT_FOUND` (session) |
| `GET /cell-nodes` | mode, `cell` (res 7–9; res read from the cell), `node`? | `WalkaboutCellNodesResult` | 400 `INVALID_WALKABOUT`; 404 |
| `GET /sessions/:sessionId/track` | none | `WalkaboutTrackResult` | 404 |

**Mode, exactly one:** `sessionId=<uuid>` | `window=24h|7d|14d|30d` |
`since=<ms>&until=<ms>` (both integers; `since ≤ until`; span ≤ 31 days).
Zero or two modes → 400. `node` goes through `parseSenderParam` (400 on junk).
`res` and `cell` invalid → 400. The cell id goes in the query string, not the
path, so the sentinel audit needs no new `PARAM_DEFAULTS` entry.

One shared `parseMapQuery(req): { q: WalkaboutMapQuery } | { error: string }`
in the route file. Declare `/sessions/:sessionId/track` after `/sessions/live`
(it has an extra segment, so no clash, but keep the order readable).

**Sizes.** Typical walk: 30–60 res-9 cells, a few KB. Worst case 5 000 cells
at ~110 bytes ≈ 550 KB; popups ≤ 200 rows; tracks ≤ 2 000 points ≈ 40 KB.

**Audit:** no `logger.info` (reads). `logger.error` on 500 via `handleError`.

### 2.9 Frontend data layer — WP2

**`src/services/walkaboutApi.ts`** add (read `body.data`, like the rest):
```ts
export function walkaboutMapParams(q: WalkaboutMapQuery): Record<string, string>; // pure; used by keys + fetchers
export async function fetchWalkaboutCells(sourceId: string, q: WalkaboutMapQuery, res: WalkaboutH3Res): Promise<WalkaboutCellsResult>;
export async function fetchWalkaboutCellNodes(sourceId: string, q: WalkaboutMapQuery, cell: string): Promise<WalkaboutCellNodesResult>;
export async function fetchWalkaboutTrack(sourceId: string, sessionId: string): Promise<WalkaboutTrackResult>;
```

**`src/hooks/useWalkabout.ts`** add:
```ts
walkaboutKeys.cells = (sourceId, q, res) => ['walkabout', sourceId, 'cells', walkaboutMapParams(q), res] as const;
walkaboutKeys.cellNodes = (sourceId, q, cell) => ['walkabout', sourceId, 'cell-nodes', walkaboutMapParams(q), cell] as const;
walkaboutKeys.track = (sourceId, sessionId) => ['walkabout', sourceId, 'track', sessionId] as const;
export function useWalkaboutCells(sourceId: string | null, q: WalkaboutMapQuery | null, res: WalkaboutH3Res);
export function useWalkaboutCellNodes(sourceId: string | null, q: WalkaboutMapQuery | null, cell: string | null); // enabled only while a popup is open
export function useWalkaboutTrack(sourceId: string | null, sessionId: string | null);
```
All three: `staleTime: 60_000`, `refetchOnWindowFocus: false`, no
`refetchInterval`. Refresh = `invalidateQueries(['walkabout', sourceId, 'cells'])`
(and `track`). Keys hold only the preset name, the session id, or the
caller's stable `since`/`until`, plus `res`: never a fresh `Date.now()`.

**The lazy boundary: `src/components/Analysis/walkaboutHexMapLazy.ts`** (new)
```ts
export const WalkaboutHexMapLazy = lazyWithPreload(() => import('./WalkaboutHexMap'));
```
The **only** way any file reaches the hex map. Both `WalkaboutMapPanel` and
`CoverageReport` import this, inside `<Suspense fallback={<MapLoadingOverlay/>}>`
(`src/components/map/MapLoadingOverlay.tsx`).

### 2.10 `src/components/Analysis/WalkaboutHexMap.tsx` (+ `.module.css`) — WP2

The **only** client file that imports `h3-js` (`cellToBoundary`). Default export.

```ts
export interface WalkaboutHexMapProps {
  sourceId: string;
  query: WalkaboutMapQuery;
  /** Changes when source or window/session changes. Never includes res. */
  fitKey: string;
}
```
- `BaseMap` with `preferCanvas`, `scrollWheelZoom`.
- `res` state from `walkaboutResForZoom(map.getZoom())`, updated on `zoomend` by a tiny child controller. Initial res from the initial zoom.
- `useWalkaboutCells(sourceId, query, res)`. Keep the old hexes on screen **only across a res change**: `placeholderData: (prev, prevQuery) => sameSourceAndMode(prevQuery, key) ? prev : undefined`. A new window, session or source must not show the old data, or the fit below would land on it.
- One `Polygon` per cell: positions `cellToBoundary(cell)` (h3-js v4 returns `[lat, lng]` pairs, which Leaflet wants), memoised per cell id. `pathOptions`: `color` and `fillColor` from the bucket → `overlayColors.snrColors` map (§1.2), `fillOpacity` 0.45, `weight` 1.
- `FitBoundsOnce` with the response's `bounds` (two corner points) and `fitKey`, mounted only when `!isPlaceholderData` and `bounds` is non-null. Why `bounds` and not hex outlines: the first fetch runs at the default zoom, so res 7, and 2.4 km hexes around a 1 km walk would fit to about zoom 12 (res 8) instead of street level. The raw-point box fits a short walk to street zoom (`maxZoom: 16`). Because `fitKey` excludes `res`, the res-9 fetch that follows the fit does not fit again. Cost: one extra res-7 fetch on first open, which is small.
- Track: `query.kind === 'session'` → `useWalkaboutTrack`, `Polyline` in `overlayColors.walkaboutTrack`, weight 3, drawn under the hexes.
- Popup on polygon click: opens at the cell; `useWalkaboutCellNodes(sourceId, query, cell)` while open. Content: title "{{count}} nodes heard here" (`nodes.length`; with `truncated`, "200+"); a sample-only cell shows "Walked here, nothing heard"; rows `name · {{snr}} dB · ×{{count}}`, name via `getUserDisplayName({ longName, shortName, id: nodeId ?? formatCoverageNodeId(publicKey) }, nodeNum ?? 0)`; null SNR shows "SNR —". `max-width` 240 px, names ellipsised.
- Legend below the map (not in the sidebar, so it never covers a phone map): four bucket rows with their dB ranges from the constants, plus "Heard, no SNR" only when some cell is `unknown`. One line: "Colour shows the best signal heard in each hex, from the last hop."
- Banners: `truncated` ("Showing part of this window. Pick a session or a shorter window."), `hiddenReceptionCount > 0` (§2.4), empty ("No walkabout data in this window.").
- CSS module, `var(--color-*)` tokens, no fallbacks, no hex in TSX styles; `UiIcon` only; map height `clamp(280px, 60vh, 520px)`; nothing wider than its container (375 px safe).

### 2.11 `src/components/Analysis/WalkaboutMapPanel.tsx` (+ `.module.css`) — WP3

```ts
export interface WalkaboutMapPanelProps {
  sourceId: string;
  sessions: WalkaboutSessionDto[];
  /** A session picked from the list ("Map" button); null = window mode. */
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
}
```
Chips 24h / 7d / 14d / 30d (default 7d) and a session `<select>` ("All
sessions in window" + each session by name or date). Picking a session
overrides the chips; picking a chip clears the session. A Refresh button
invalidates `cells` and `track`. Renders `WalkaboutHexMapLazy` with
`fitKey = `${sourceId}|${kind}|${window or sessionId}``. Chips wrap; the select
is full width under 480 px.

### 2.12 `src/components/Analysis/WalkaboutReport.tsx` changes — WP3

- **Fix P1's source picker.** Today a user with write on any source sees only
  writable sources (`WalkaboutReport.tsx:59-71`), so they cannot open a
  source they may only read. New rule: `options` = every enabled
  `meshtastic_tcp` / `meshcore` source with `WALKABOUT_READ_GRANT`;
  `canWrite = hasPermission(WALKABOUT_WRITE_GRANT, { sourceId })` for the
  **selected** source drives Start, Resume and Delete. Default selection: the
  first writable source, else the first readable one.
- Each finished session row gains a "Map" button (`UiIcon name="map"`) that
  sets `selectedSessionId` and scrolls the panel into view.
- `WalkaboutMapPanel` mounts **only while `active == null`** (no walk running
  on this page). During a walk the section shows one line, "The map opens when
  you stop." This keeps P1's request budget (§2.8 of P1) and battery intact.
  Viewing someone else's live session from another device is allowed; it
  shows what exists at fetch time, with Refresh.
- The intro and the "A map view … comes in a later release" doc line change (§2.15).
- Start stays **hidden** (not just disabled) when the selected source is not writable, so P1's "read-only user sees the list but no Start" test holds. P1's test "picker lists only Meshtastic/MeshCore sources with write" changes meaning: rename it "…with read" and keep its assertion (its fixture grants everything, so the list is the same); add the new mixed-grant case (§4.3).

### 2.13 `src/components/Analysis/CoverageReport.tsx` changes — WP3

**Decision: a third view, not an overlay.** The View toggle becomes
**Dots | Grid | Walkabout**. Walkabout swaps the map for the hex map; the two
coverage models never share one map. Overlaying fixed-receiver dots on
moving-receiver hexes would put two meanings of "colour" on one surface.

- State: `type ReportView = CoverageMapView | 'walkabout'` local to the report (leave `CoverageMapView` and `CoverageMap` untouched).
- Walkabout view shows: **Source** `<select>` (enabled walkabout-capable sources with `nodes:read`, from `useWalkaboutSources`), **Session** `<select>` ("All sessions in range" + sessions from `useWalkaboutSessions(sourceId)` that overlap the current window). The time range presets and custom range stay; the sender picker stays and maps to `node`; the survey bar stays (it only sets sender + window).
- Hidden in walkabout view: hops, cross-source, colour-by, cell size, export, receiver filter, MQTT note, summary panel, cross-source summary, distance chart.
- Query: session picked → `{ kind: 'session', sessionId, node }`; else `{ kind: 'range', sinceMs, untilMs, node }` from the report's resolved `timeWindow` state.
- **`useCoverageReceptions` is disabled in walkabout view** (`receptionsEnabled && view !== 'walkabout'`), so the view costs one cells request, not 10 reception pages.
- `fitKey` = `${sourceId}|${sessionId ?? `${preset}:${customFrom}:${customTo}`}|${senderId}`.
- The Walkabout button shows only when the viewer is **signed in** (`authStatus?.authenticated`, as `AnalysisTab.tsx:66` gates the Walkabout card) **and** can read at least one walkabout-capable source. Anonymous viewers on a public instance may hold `nodes:read` (`AuthContext.hasPermission` answers for them too), but every walkabout route needs a login, so they would only get 401s.
- **Render gate.** Today `CoverageMap` renders inside the "receptions loaded and non-empty" block (`CoverageReport.tsx:780-812`). The hex map renders **outside** that block, gated only on view + source. In walkabout view the "select at least one receiver", "truncated" and "No RF receptions in this window" banners stay off; the hex map shows its own empty state.
- **What the sender filter means here.** A Coverage sender is the node that *sent* the packet; `creditedKey` is the *last hop* the walker's radio heard. So in walkabout view the sender filter reads "heard directly from, or relayed last by, X". Say so in a one-line hint under the picker. The picker lists Coverage senders only (`/senders`), so a node heard only on a walk cannot be picked there; with sender = All its hexes still show, and the Walkabout report's popup names it. Good enough for P2.
- The existing query-stability regression tests must stay green unchanged.

### 2.14 Other files

| File | Change | WP |
|---|---|---|
| `src/config/overlayColors.ts` | `walkaboutTrack` in the interface and both palettes | WP0 |
| `src/components/map/FitBoundsOnce.tsx` (new) + `CoverageMap.tsx` | Extract `FitCoverageBounds`; `CoverageMap` imports it; `CoverageMap.test.tsx` stays green | WP2 |
| `public/locales/en.json` | every new key: `analysis.walkabout.map.*`, `analysis.coverage.view_walkabout`, `analysis.coverage.walkabout_*` (inline defaults are not enough). **One owner: WP4.** WP2 and WP3 run in parallel and would collide, so each writes inline `t(key, default)` calls and lists its new keys in its handoff; WP4 adds them all before the PR. | WP4 |
| `src/server/test-helpers/publicInstanceAudit.ts` | nothing (query params, `sessionId` already defaulted) | — |

### 2.15 Docs — WP4

- `docs/features/walkabout.md`: a "Map" section (chips, sessions, zoom levels, buckets, popup, hidden-node banner, track), replace "A map view … later release", three API rows.
- `docs/features/coverage-report.md`: short "Walkabout view" section.
- `WALKABOUT_COVERAGE_EPIC.md`: tick P2, phase log entry.
- `CLAUDE.md` Walkabout row: add `walkaboutCells.ts`, `WalkaboutHexMap.tsx`, "`h3-js` only via `walkaboutHexMapLazy.ts` on the client".
- Screenshot at 375 px for the PR.

### 2.16 Bundle impact

- `main-*.js`: unchanged. Nothing reachable from `main.tsx` statically imports `h3-js`.
- Reports route chunk: + `WalkaboutMapPanel`, the lazy stub and CoverageReport's view code (a few KB).
- New lazy chunk: `WalkaboutHexMap` + `h3-js` ≈ 550 KB raw / ≈ 100 KB gzip. Under the 3.6 MiB single-asset cap. Its CSS module lands in the entry sheet (eager-CSS plugin); a few hundred bytes.
- `scripts/check-bundle-size.mjs` needs no change; WP4 checks the chunk by hand (§4.4).

---

## 3. Mesh impact checklist (copy into the PR body)

1. **Airtime: zero.** P2 adds read-only HTTP routes and UI. Nothing is sent
   on the mesh, by MeshMonitor or by the phone.
2. **Spam: none.** No messages, no `dataEventEmitter` events, no
   notifications, no automations. HTTP: each map view makes one cells request
   per H3 level it shows (at most three) plus one per popup opened; no
   polling. The map does not mount during a live walk, so P1's walker request
   budget is unchanged.
3. **Timers a save or restart could reset: none.** No scheduler, no setting,
   no cooldown. "Now" for a window is read per request.

---

## 4. Test plan (standard Vitest)

Run only the listed files, under the machine test lock (`flock`,
`--maxWorkers=2`); never the full suite locally. PG/MySQL suites need the
containers on 5433/3307 and skip silently without them; confirm with
`numPendingTests`.

### 4.1 Server (WP1)

- **`src/server/utils/walkaboutH3.test.ts`**: find (by search in the test) a
  point where `latLngToCell(p, 7) !== cellToParent(latLngToCell(p, 9), 7)` and
  assert `walkaboutCellOf(p, 7)` returns the parent-of-res-9 cell;
  `parseWalkaboutCell` rejects res 6 and 10, junk, numbers; `walkaboutCellBBox`
  contains every vertex of every res-9 child; antimeridian cell → null.
- **`src/server/services/walkaboutCells.test.ts`** (pure functions):
  - Best per cell: SNRs −7, 2, null → `bestSnr` 2; all null → null.
  - `nodeCount` counts distinct `creditedKey`; `receptionCount` counts rows.
  - Sample-only cell → `receptionCount` 0, `sampleCount` > 0.
  - Rollup: two res-9 cells with one res-8 parent merge at res 8 (counts add, best is max, nodes union).
  - Clip: reception at `endedAt` kept, at `endedAt + 1` dropped, at `startedAt − 1` dropped; open session clips at `startedAt + 2 h`; samples clip on `fixAt`, not `receivedAt`; rows outside `[since, until]` dropped.
  - Cap: 5 001 cells → 5 000, `truncated`, sorted by `receptionCount`.
  - `bounds` covers raw points (not hex outlines) and is identical at res 7, 8 and 9; null when empty.
  - `groupCellNodes` sort and 200-row cap; only rows whose binned cell equals the cell (a row inside the bbox but in a neighbour cell is excluded).
  - Mocked repo: a capped read keeps the newest rows; `getWalkaboutCells` with a hidden node drops its rows and reports `hiddenReceptionCount`; `node` = a hidden node → `cells: []`, count 0; reads at limit + 1 set `truncated`.
- **`src/db/repositories/coverageWalkabout.test.ts`** (SQLite): `listSessionsInRange` prefilter (a session that started 3 h before `since` is excluded, one 1 h before included); `getReceptionPoints` by session list, time range, `creditedKey`, bbox, limit and order; `getSamplePoints` same; empty `sessionIds` → `[]`.
- **`coverageWalkabout.multiBackend.test.ts`**: the same three methods on PG/MySQL; `creditedNodeNum` > 2^31 and bigint times come back as numbers.
- **`coverageWalkabout.perSource.test.ts`**: B's `sessionId` passed with `sourceId` A returns nothing.
- **`src/server/routes/walkaboutRoutes.test.ts`** (`createRouteTestApp`, real repo):
  - Anonymous → 401 on all three routes.
  - `nodes:read` on A: `/cells` on A 200, on B 403; `/cell-nodes` and `/track` the same.
  - 400s: no mode; two modes; `window=1y`; `res=6`; `since > until`; span 32 d; bad `cell`; bad `node`.
  - Session of another source → 404 on `/cells?sessionId=`, `/cell-nodes?sessionId=`, `/track`.
  - Visibility: a non-admin without `channel_0:viewOnMap` gets the track and sample cells, no reception cells, and `hiddenReceptionCount` > 0; with the grant, the cells appear. A `hideFromMap` node is excluded for an admin too. A MeshCore source without `nodes:viewOnMap` likewise.
  - `/cell-nodes` names: Meshtastic long/short name; MeshCore `name` as `longName`; a node deleted from the source is dropped.
  - `/track`: clipped; ordered by `fixAt`; `positions` pairs.
  - Envelope `{ success: true, data }` / `{ success: false, error, code }`.
- **`walkaboutRoutes.perSource.test.ts`**: extend to the three routes.
- **`publicInstance.sentinelAudit.test.ts`** passes unchanged.

### 4.2 Frontend data + map (WP2)

- **`src/utils/walkabout.test.ts`**: `walkaboutBucket` at 0 → strong, −0.01 → medium, −5 → medium, −5.01 → weak, −10 → weak, −10.01 → none, count 0 → none, null with receptions → unknown; `walkaboutResForZoom` 18/14 → 9, 13/12 → 8, 11/3 → 7.
- **`useWalkabout.test.ts`**: keys hold `res` and the preset/session/since-until; no `refetchInterval`; `cellNodes` disabled with a null cell.
- **`WalkaboutHexMap.test.tsx`** with the real `h3-js` (it runs in Node as plain JS with no WASM fetch, checked; jsdom is expected to work but WP0 confirms with a one-line test before WP2 starts, and if it fails the test mocks `cellToBoundary`): one polygon per cell; fill colour per bucket from `overlayColors`; a zoom change calls the cells hook with the new res; fit uses `bounds`, runs once per `fitKey`, not again after a res change, and not on placeholder data after a window change (old hexes are not kept across a window change); popup shows "N nodes heard here", rows with ×count, null long name falls back to the id; sample-only popup text; track only in session mode; hidden, truncated and empty banners; legend "Heard, no SNR" row only when present.
- **`walkaboutLazy.wiring.test.ts`** (source scan, like `ducting.wiring.test.ts`): under `src/` outside `src/server/`, only `WalkaboutHexMap.tsx` (and its test) import `'h3-js'`; `src/utils/walkabout.ts` does not; `WalkaboutHexMap` is imported only by `walkaboutHexMapLazy.ts`, through `lazyWithPreload(() => import('./WalkaboutHexMap'))`.
- **`CoverageMap.test.tsx`**: unchanged and green after the `FitBoundsOnce` extraction.
- `semanticTokens` test after the new CSS modules.

### 4.3 Frontend integration (WP3; mock `walkaboutHexMapLazy` with a stub)

- **`WalkaboutMapPanel.test.tsx`**: chip changes the query; session select overrides chips and a chip clears it; Refresh invalidates; no timers.
- **`WalkaboutReport.test.tsx`** (extend): panel not mounted while walking, mounted after stop; a write-on-A, read-only-on-B user sees both sources, Start shown on A and hidden on B; "Map" picks the session. Rename the P1 case "picker lists only … with write" to "… with read" (same assertion).
- **`CoverageReport.test.tsx`** (extend): Walkabout button hidden for an anonymous viewer even with `nodes:read`, and for a signed-in user with no readable walkabout source; in walkabout view the receiver/empty banners are absent; in walkabout view the receptions fetcher is not called and the stub gets `{ kind: 'range', sinceMs, untilMs, node }`; picking a session sends `{ kind: 'session' }`; the existing query-stability tests pass untouched.

### 4.4 Build and browser (WP4)

- `npm run build && npm run check:bundle-size` green.
- `grep -l latLngToCell dist/assets/*.js`: exactly one file, not `main-*.js`, and not the chunk that holds `WalkaboutReport`.
- Real browser (dev container, Chrome DevTools) at 375 × 812: the map loads, hexes draw (proves Vite picked a working `h3-js` browser build, which jsdom cannot show), no console errors, no sideways scroll, a popup fits, zoom 15 → 12 → 10 switches hex size with one fetch each.
- Coverage report: Walkabout view against the P1 session data; popup counts match a hand count from `/cell-nodes`.

---

## 5. Work packages

Order: **WP0 → (WP1 ∥ WP2 ∥ WP3) → WP4.** WP0 exists because jsdom cannot
`vi.mock` a module missing on disk, and three packages touch the same types.
Each WP runs only its own test files under the lock, then
`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` (must be
empty) and, for server files, `npx tsc --noEmit -p tsconfig.server.json`.
Server relative imports end in `.js`.

**WP0 — orchestrator, one commit before forking.**
`h3-js@4.5.0` dependency; §2.6 constants, `walkaboutBucket`,
`walkaboutResForZoom` with their tests; §2.6 types; `overlayColors.walkaboutTrack`;
a throwaway check that `import { cellToBoundary } from 'h3-js'` works in a
jsdom Vitest file (report the result to WP2);
skeletons with final signatures that throw `not implemented`:
`walkaboutH3.ts`, `walkaboutCells.ts`, the three repo methods, the three
fetchers and hooks, `walkaboutHexMapLazy.ts`, and a `WalkaboutHexMap.tsx`
that renders `null`.
*Accept:* `tsc` clean (both configs); `walkabout.test.ts` green; no behaviour change.

**WP1 — server (Sonnet).** `walkaboutH3.ts`, repo methods, `walkaboutCells.ts`,
three routes. Tests §4.1.
*Accept:* §4.1 green **with PG/MySQL containers up** and `numPendingTests` 0
for the multiBackend file; every route uses `canRead`, `ok`/`fail`; the gate
runs before binning (test proves it); no new migration; no `dataEventEmitter`.

**WP2 — map (Sonnet).** `walkaboutApi.ts` and `useWalkabout.ts` bodies,
`FitBoundsOnce` extraction, `WalkaboutHexMap.tsx` + CSS module, map `en.json`
keys. Mocks the API module. Tests §4.2.
*Accept:* §4.2 green; `h3-js` imported only by `WalkaboutHexMap.tsx` on the
client; no raw `fetch`; no hardcoded colours; `UiIcon` only; works at 375 px.

**WP3 — integration (Sonnet).** `WalkaboutMapPanel`, `WalkaboutReport`
changes (picker fix, Map button, unmounted while walking), `CoverageReport`
Walkabout view, panel/report `en.json` keys. Mocks `walkaboutHexMapLazy` and
the hooks, so it runs beside WP2. Tests §4.3.
*Accept:* §4.3 green; existing `CoverageReport` and `WalkaboutReport` tests
green, with only the P1 picker case renamed (§2.12); no polling added.

**WP4 — orchestrator, after WP1–WP3.** Merge; §4.4 build, chunk grep and
browser checks against the dev container with a real session (or Chrome
sensor override on localhost); all new `en.json` keys from the WP2/WP3
handoffs; docs §2.15; screenshot.

---

## 6. Open questions (maintainer policy only)

- **Q1 — Hidden nodes in the hex map.** Default here: a reception from a node
  the viewer may not see on the map (hidden, private position, no
  `viewOnMap`) is dropped before binning, and the page shows one window-wide
  "N receptions not shown" count. The cost: such a viewer sees "no signal"
  where only hidden nodes were heard. The alternative counts the signal in the
  hex colour and lists the node as "1 hidden node" in the popup, which keeps
  the walker's coverage true but tells the viewer a hidden node is in radio
  range of that hex. Keep the default?
- **Q2 — SNR bands per modem preset.** The epic's defaults (none below
  −10 dB) suit fast presets. On LongSlow / SF12 a link decodes down to about
  −20 dB, so a working link would show as "no signal". P2 ships the fixed
  defaults. Should a later phase make the bands a per-source setting?

### Resolutions (maintainer, 2026-11-25) — binding

- **Q1:** drop receptions credited to hidden nodes before binning; show one window-wide `hiddenReceptionCount` banner. Never hint where a hidden node is.
- **Q2:** ship the fixed SNR bands in P2. Per-source / preset-aware bands: #6571.
