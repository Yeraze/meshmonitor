# Traceroute Strip Interactivity — Phase 2 Implementation Spec

**Epic:** `docs/internal/dev-notes/TRACEROUTE_STRIP_INTERACTIVITY_EPIC.md` (Phase 2)
**Branch:** `feature/traceroute-participation-picker` (worktree `../meshmonitor-trs-phase2`, based on
`origin/main` @ 6f023136 — Phase 1 / PR #4424 merged)
**Prior spec:** `TRS_PHASE1_SPEC.md` — its §1 reuse inventory carries over; this spec only lists what
Phase 2 adds.

---

## 0. Confirmed decisions (settled — do not re-litigate)

| Question | Decision |
|---|---|
| "Participated in" | `fromNodeNum` / `toNodeNum` **or** an entry in the `route` / `routeBack` JSON arrays |
| Window / cap | 7 days (reuse `TRACEROUTE_DISPLAY_HOURS`), newest first, ≤100 returned, bounded scan of ≤2000 rows |
| Matching | One Drizzle query-builder scan + **JS** participation filter. No raw SQL, no `LIKE` on JSON |
| Source scoping | `sourceId` is **required** on the endpoint — no `ALL_SOURCES` fallback (fail closed) |
| Permission | `requirePermission('traceroute', 'read', { sourceIdFrom: 'query' })` + `maskTraceroutesByChannel` |
| Section gate | `hasPermission('traceroute','read') \|\| hasPermission('traceroute','write')` (non-regressive) |
| Default selection | Newest of (`recentTrace`, `entries[0]`) by timestamp; explicit pick overrides; pick clears on node change and on a fresh traceroute response |
| Picker chrome | Native `<select>` in a new CSS-module component, rendered only when `entries.length >= 2` |
| Payload | `routePositions` **stripped** — the strip does not use it, and dropping it removes the #3092 hop-position leak surface entirely |
| Strip component | **Unchanged.** Phase 1 shipped everything it needs |
| Migration | **None.** No schema change; `nodes.test.ts` hand-written PG/MySQL DDL is untouched |

---

## 1. Reuse inventory (mandatory first read)

### 1.1 Must reuse — existing code this phase builds on

| Mechanism | Where | How Phase 2 uses it |
|---|---|---|
| `parseHopArray(json)` | `src/utils/tracerouteSegments.ts:262` | Parses `route`/`routeBack`; already `Number(n)`-coerces every element (the PG/MySQL BIGINT-as-string gotcha). The participation predicate is built on it. |
| `tracerouteSegments.ts` itself | `src/utils/tracerouteSegments.ts` | Declared "the SINGLE home" for shared traceroute decomposition, pure/React-free/leaflet-free, and **already imported by server code** (`embedPublicRoutes.ts:19`). The new predicate lands here — no new util file. |
| `BaseRepository.withSourceScope` / `normalizeBigInts` | `src/db/repositories/base.ts:244` / `:267` | Source scoping (fails closed on missing sourceId) and BigInt→number normalisation in the new repo method. |
| `getAllTraceroutes(limit, sourceId)` pattern | `src/db/repositories/traceroutes.ts:119` | Template for the new method: `.select().from(traceroutes).where(...).orderBy(desc(timestamp)).limit(n)` then `normalizeBigInts`. |
| `requirePermission('traceroute','read',{sourceIdFrom:'query'})` | `src/server/routes/tracerouteRoutes.ts:52` (the `/history` route) | Exact middleware the new route uses. |
| `ok()` / `fail()` | `src/server/utils/apiResponse.ts` | New route is new surface, so the envelope is free of the "ApiService doesn't unwrap `data`" trap — the new client method unwraps explicitly. |
| `maskTraceroutesByChannel(records, user, sourceId)` | `src/server/utils/nodeEnhancer.ts:323` | Same channel gate `buildSourceTraceroutes` applies (#3092). Drops rows whose `channel` the caller lacks `viewOnMap` on. |
| `TRACEROUTE_DISPLAY_HOURS` | `src/utils/nodeHelpers.ts:16` (`7 * 24`) | The 7-day window constant — already the value `App.tsx:1903` uses. Do not redeclare. |
| `apiService.get<T>(endpoint)` | `src/services/api.ts:172` | The new `ApiService` method. Raw `fetch()` is ESLint-banned in components/pages; the ApiService route is mandatory. |
| `useQuery` + `useResolvedSourceId()` hook shape | `src/hooks/useLinkQuality.ts:63-91`, `src/hooks/useResolvedSourceId.ts:39` | Template for the new one-shot hook, including the `enabled: !!sourceId` deferral (needed because `useSource()` returns `null` outside a `SourceProvider`). |
| `buildTracerouteStripGraph` / `buildStripNodeMeta` | `src/utils/tracerouteStrip.ts:560`, `src/utils/tracerouteStripMeta.ts` | Unchanged. The picked entry structurally satisfies `TracerouteStripInput` (`tracerouteStrip.ts:137`). `buildStripNodeMeta`'s `currentNodeNum: null` path already covers MQTT's empty `currentNodeId`. |
| `getNodeShortName(nodes, nodeId)` / `getNodeName` | `src/utils/nodeHelpers.ts:352` / `:319` | Endpoint labels in the option text — no new name-resolution logic. |
| `formatDateTime(ts, timeFormat, dateFormat)` | `src/utils/datetime.ts` (already imported by `MessagesTab`) | Option timestamp rendering, honouring the user's time/date format settings. |
| `messages.traceroute_edge_endpoints` (`"{{from}} → {{to}}"`) | `public/locales/en.json:484` | Reused verbatim for the endpoint half of every option label. |
| `createRouteTestApp()` | `src/server/test-helpers/routeTestApp.ts` | Mandatory for the new route test (CLAUDE.md). Seeds real users/sources/permissions against the `:memory:` singleton the handler actually reads. |
| `createTestDb()` + `test-utils.ts` backend factories | `src/server/test-helpers/testDb.ts`, `src/db/repositories/test-utils.ts` | Repository tests; `traceroutes.test.ts` is the in-file template. |
| `mqttPacketLog.perSource.test.ts` | `src/db/repositories/` | Template for the required `*.perSource.test.ts`. |
| `MessagesTab.tracerouteStrip.test.tsx` mock block | `src/components/` | The canonical MessagesTab harness (i18n override that resolves positional defaults + real `en.json`). Copy it, do not reinvent. |
| `TracerouteStrip.module.css` | `src/components/traceroute/` | Precedent: this component family styles with CSS modules, never `nodes.css`/`messages.css`. |
| `UiIcon` | `src/components/icons/UiIcon.tsx` (`route`, `chevronDown`, `list`) | Any glyph in the picker. No literal emoji. |

### 1.2 New surface, each justified against the closest existing mechanism

| New thing | Closest existing | Why new is justified |
|---|---|---|
| `tracerouteParticipationKind(row, nodeNum)` in `tracerouteSegments.ts` | Inlining the filter in the repository | The predicate is the one piece of real logic in this phase and must be unit-testable against string-typed node numbers (PG/MySQL) without a database. `tracerouteSegments.ts` already declares itself the shared, server-safe home for exactly this kind of helper. |
| `getTraceroutesInvolvingNode(...)` repository method | `getTraceroutesByNodes(from, to, …)` | That method is an SQL `OR` over the two endpoint columns and *cannot* see intermediate hops — the whole point of the picker. A JSON-array membership test has no cross-backend SQL form, so the scan-then-filter shape is new by necessity. |
| `GET /api/traceroutes/participation/:nodeNum` | `GET /api/traceroutes/history/:from/:to` | History needs a node **pair**; the picker has one node and no counterpart (that is exactly the MQTT case). Same router, same middleware, same validation ladder — only the selector differs. |
| `ok()` envelope on this route | The two bare-payload handlers next to it | New route, new consumer: no wire-shape break, and CLAUDE.md wants new handlers on the envelope. The two legacy handlers in the file are **not** converted. |
| `useNodeTraceroutes()` hook | `useTraceroutes()` (poll cache) | The poll cache is a *global 24 h* window driven by `/api/traceroutes/recent` and holds only what the poll shipped; the picker needs a 7-day, node-scoped, participation-matched list that no poll payload carries. A one-shot `useQuery` (the `useLinkQuality` shape) is the established pattern for exactly this. |
| `TracerouteParticipationPicker` + `.module.css` | The hand-rolled `showTracerouteChannelDropdown` button/menu in `MessagesTab.tsx:2191` | That control needs per-row icons and click-outside bookkeeping. This one is a flat list of text labels, so a native `<select>` gets keyboard, screen-reader, and mobile behaviour for free and adds no document-level listener. Extracting it as a component keeps `MessagesTab.tsx` (2605 lines) from growing and satisfies the CSS-containment rule. |
| 6 i18n keys | Reusing existing ones | Listed in §7; endpoint rendering, "Unknown", and the separator all reuse shipped keys. |

### 1.3 Explicitly NOT touched

`src/components/traceroute/TracerouteStrip.tsx` and `NodeGlyph.tsx` (Phase 1 finished them),
`src/utils/tracerouteStrip.ts`, `src/utils/tracerouteStripMeta.ts`, `src/styles/nodes.css` and
`messages.css` (frozen), the two existing handlers in `tracerouteRoutes.ts`, `usePoll`/`useTraceroutes`,
`App.tsx`'s `getRecentTraceroute`, `sourceRoutes.ts`, every locale file except `public/locales/en.json`,
and every database schema/migration file.

---

## 2. File-by-file change list

| # | File | Change | WP |
|---|---|---|---|
| 1 | `src/utils/tracerouteSegments.ts` | + `TracerouteParticipation`, `tracerouteParticipationKind()` | WP1 |
| 2 | `src/db/repositories/traceroutes.ts` | + `getTraceroutesInvolvingNode()` | WP1 |
| 3 | `src/server/routes/tracerouteRoutes.ts` | + `GET /participation/:nodeNum` | WP1 |
| 4 | `src/services/api.ts` | + `getTracerouteParticipation()` | WP1 |
| 5 | `src/hooks/useNodeTraceroutes.ts` | **new** — one-shot `useQuery` hook | WP2 |
| 6 | `src/components/traceroute/TracerouteParticipationPicker.tsx` | **new** | WP2 |
| 7 | `src/components/traceroute/TracerouteParticipationPicker.module.css` | **new** | WP2 |
| 8 | `src/components/MessagesTab.tsx` | gate change + picker state + displayed-row selection | WP2 |
| 9 | `public/locales/en.json` | + 6 flat keys | WP2 |
| 10 | `src/utils/tracerouteSegments.test.ts` | + participation predicate cases | WP1 |
| 11 | `src/db/repositories/traceroutes.participation.test.ts` | **new** | WP1 |
| 12 | `src/db/repositories/traceroutes.participation.perSource.test.ts` | **new** | WP1 |
| 13 | `src/server/routes/tracerouteRoutes.participation.test.ts` | **new** (harness) | WP1 |
| 14 | `src/services/api.test.ts` | + one case | WP1 |
| 15 | `src/components/traceroute/TracerouteParticipationPicker.test.tsx` | **new** | WP2 |
| 16 | `src/components/MessagesTab.tracerouteParticipation.test.tsx` | **new** | WP3 |
| 17 | `docs/internal/dev-notes/TRACEROUTE_STRIP_INTERACTIVITY_EPIC.md` | tick Phase 2 exit criteria + log | WP3 |

---

## 3. `src/utils/tracerouteSegments.ts` (WP1)

Append next to `parseHopArray` / `hasRouteData`:

```ts
/** How a node took part in a traceroute. `null` = it did not. */
export type TracerouteParticipation = 'endpoint' | 'hop';

/** Structural subset of a traceroute row needed to test participation. */
export interface TracerouteParticipationInput {
  fromNodeNum: number | string;
  toNodeNum: number | string;
  route?: string | null;
  routeBack?: string | null;
}

/**
 * Classify how `nodeNum` took part in one traceroute row.
 *
 * Endpoint match wins over hop match: a node that is both the origin and a
 * relay in its own routeBack is an endpoint, which is what the label should say.
 *
 * `fromNodeNum`/`toNodeNum` are coerced with `Number()` because PostgreSQL and
 * MySQL hand BIGINT columns back as strings (CLAUDE.md, Multi-Database).
 * `parseHopArray` already `Number()`-coerces every array element.
 */
export function tracerouteParticipationKind(
  row: TracerouteParticipationInput,
  nodeNum: number,
): TracerouteParticipation | null {
  if (Number(row.fromNodeNum) === nodeNum || Number(row.toNodeNum) === nodeNum) return 'endpoint';
  if (parseHopArray(row.route).includes(nodeNum)) return 'hop';
  if (parseHopArray(row.routeBack).includes(nodeNum)) return 'hop';
  return null;
}
```

`parseHopArray` already swallows malformed JSON (`try/catch` → `[]`), so a corrupt `route` never throws
here — assert that in the test rather than adding a second guard.

---

## 4. `src/db/repositories/traceroutes.ts` (WP1)

Add after `getTraceroutesByNodes` (keep the existing method untouched):

```ts
  /**
   * Every traceroute on `sourceId` that `nodeNum` took part in — as an endpoint
   * OR as an intermediate hop in `route`/`routeBack` — newest first.
   *
   * Hop membership lives inside a JSON string column. There is no
   * database-agnostic SQL for that (LIKE-matching JSON text is wrong across
   * three backends and would match substrings of other node numbers), and raw
   * SQL is banned outside migrations. So this does ONE bounded, ordered,
   * source-scoped scan through the query builder and filters in JS.
   *
   * `scanLimit` bounds memory. Because the scan is newest-first, exceeding it
   * can only drop OLDER participations — never the ones the picker shows.
   */
  async getTraceroutesInvolvingNode(
    nodeNum: number,
    opts: {
      sourceId: SourceScope;
      sinceTimestamp: number;
      limit?: number;
      scanLimit?: number;
    },
  ): Promise<Array<DbTraceroute & { participation: TracerouteParticipation }>> {
    const { traceroutes } = this.tables;
    const limit = opts.limit ?? 100;
    const scanLimit = opts.scanLimit ?? 2000;

    const rows = await this.db
      .select()
      .from(traceroutes)
      .where(and(
        gte(traceroutes.timestamp, opts.sinceTimestamp),
        this.withSourceScope(traceroutes, opts.sourceId),
      ))
      .orderBy(desc(traceroutes.timestamp))
      .limit(scanLimit);

    const normalized = this.normalizeBigInts(rows) as DbTraceroute[];
    const matched: Array<DbTraceroute & { participation: TracerouteParticipation }> = [];
    for (const row of normalized) {
      const participation = tracerouteParticipationKind(row, nodeNum);
      if (participation) matched.push({ ...row, participation });
      if (matched.length >= limit) break;
    }
    return matched;
  }
```

Notes:
- `and`, `gte`, `desc` are already imported at the top of the file.
- Add `import { tracerouteParticipationKind, type TracerouteParticipation } from '../../utils/tracerouteSegments.js';`
  (`.js` extension — NodeNext resolution).
- `withSourceScope` throws on `undefined`/`''`; that is desired — the route validates first, and a caller
  that genuinely wants cross-source must pass `ALL_SOURCES` explicitly.
- No `Number()` needed on `row.id`: `normalizeBigInts` handles bigint, and the route re-coerces (§5).

---

## 5. `src/server/routes/tracerouteRoutes.ts` (WP1)

New handler, placed after `/history/:fromNodeNum/:toNodeNum`. Imports to add:
`ok`, `fail` from `../utils/apiResponse.js`; `maskTraceroutesByChannel` from `../utils/nodeEnhancer.js`;
`TRACEROUTE_DISPLAY_HOURS` from `../../utils/nodeHelpers.js`; `parseHopArray` from
`../../utils/tracerouteSegments.js`.

```ts
// GET /api/traceroutes/participation/:nodeNum?sourceId=…&hours=168&limit=100
//
// Every stored traceroute on ONE source that this node took part in — as an
// endpoint or as an intermediate hop. Backs the Node Details traceroute picker
// (epic phase 2), which is the only way an MQTT source (no origin node, so no
// own-request traceroute) can render the strip at all.
//
// sourceId is REQUIRED: the picker is per-source by definition, and a silent
// ALL_SOURCES fallback would mix another source's rows for the same nodeNum.
router.get(
  '/participation/:nodeNum',
  requirePermission('traceroute', 'read', { sourceIdFrom: 'query' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId.trim() : '';
      if (!sourceId) {
        return fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId query parameter is required');
      }

      const nodeNum = Number.parseInt(req.params.nodeNum, 10);
      if (!Number.isFinite(nodeNum) || nodeNum < 0 || nodeNum > 0xffffffff) {
        return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be between 0 and 4294967295');
      }

      const hours = req.query.hours
        ? Number.parseInt(req.query.hours as string, 10)
        : TRACEROUTE_DISPLAY_HOURS;
      if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 90) {
        return fail(res, 400, 'INVALID_HOURS', 'hours must be between 1 and 2160');
      }

      const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 100;
      if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
        return fail(res, 400, 'INVALID_LIMIT', 'limit must be between 1 and 200');
      }

      const rows = await databaseService.traceroutes.getTraceroutesInvolvingNode(nodeNum, {
        sourceId,
        sinceTimestamp: Date.now() - hours * 60 * 60 * 1000,
        limit,
      });

      // Same channel gate GET /api/sources/:id/traceroutes applies (#3092) — a
      // traceroute on a channel the caller can't view must not surface here.
      const visible = await maskTraceroutesByChannel(rows, (req as any).user ?? null, sourceId);

      const entries = visible.map(tr => ({
        id: Number(tr.id),
        timestamp: tr.timestamp,
        fromNodeNum: Number(tr.fromNodeNum),
        toNodeNum: Number(tr.toNodeNum),
        fromNodeId: tr.fromNodeId,
        toNodeId: tr.toNodeId,
        route: tr.route ?? null,
        routeBack: tr.routeBack ?? null,
        snrTowards: tr.snrTowards ?? null,
        snrBack: tr.snrBack ?? null,
        channel: tr.channel ?? null,
        participation: tr.participation,
        // null (not the 999 sentinel the map/dashboard paths use) when the
        // forward route is absent or unparseable: a label wants honest absence,
        // and 999 would render as "999 hops".
        hopCount: hasRouteData(tr.route) ? parseHopArray(tr.route).length : null,
      }));

      return ok(res, { nodeNum, sourceId, entries });
    } catch (error) {
      logger.error('Error fetching traceroute participation:', error);
      return fail(res, 500, 'TRACEROUTE_PARTICIPATION_FAILED', 'Failed to fetch traceroute participation');
    }
  },
);
```

**`routePositions` is deliberately absent** from the projection. The strip renders positions from
`meta.pos` (live node rows), never from the snapshot column, so shipping it would be pure leak surface.

Wire shape: `{ "success": true, "data": { "nodeNum": 123, "sourceId": "…", "entries": [ … ] } }`.

---

## 6. Client

### 6.1 `src/services/api.ts` (WP1)

```ts
  /**
   * Traceroutes a node took part in (endpoint or intermediate hop) on ONE source.
   * Backs the Node Details traceroute picker. Unwraps the `{success,data}`
   * envelope here because `request()` deliberately does not (CLAUDE.md).
   */
  async getTracerouteParticipation(
    nodeNum: number,
    sourceId: string,
    opts: { hours?: number; limit?: number } = {},
  ): Promise<TracerouteParticipationEntry[]> {
    const params = new URLSearchParams({ sourceId });
    if (opts.hours != null) params.set('hours', String(opts.hours));
    if (opts.limit != null) params.set('limit', String(opts.limit));
    const body = await this.get<{ success: boolean; data: { entries: TracerouteParticipationEntry[] } }>(
      `/api/traceroutes/participation/${nodeNum}?${params.toString()}`,
    );
    return body.data?.entries ?? [];
  }
```

`TracerouteParticipationEntry` is declared and exported from `src/services/api.ts` itself, next to
`SignalTrendResult` (`api.ts:26`) — whose `getSignalTrend` (`api.ts:862`) is the exact
declare-here + unwrap-`data` precedent this method copies. There is no `src/types/traceroute.ts` and this
phase does not create one for a single interface.

```ts
export interface TracerouteParticipationEntry {
  id: number;
  timestamp: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string | null;
  routeBack: string | null;
  snrTowards: string | null;
  snrBack: string | null;
  channel: number | null;
  participation: 'endpoint' | 'hop';
  hopCount: number | null;
}
```

This shape structurally satisfies `TracerouteStripInput` — no adapter is needed to feed
`buildTracerouteStripGraph`.

### 6.2 `src/hooks/useNodeTraceroutes.ts` (WP2, new)

```ts
/**
 * Traceroutes one node took part in, for the Node Details picker.
 *
 * One-shot query (the `useLinkQuality` shape), NOT the poll cache: the poll
 * ships a global 24 h list keyed off /api/traceroutes/recent, while the picker
 * needs a 7-day, node-scoped, participation-matched list.
 *
 * `useResolvedSourceId()` rather than `useSource()`: MessagesTab can mount
 * outside a SourceProvider, where `sourceId` is null and the endpoint would
 * 400. The resolver falls back to the primary source, and `enabled` defers the
 * request until it lands.
 */
export function useNodeTraceroutes(nodeNum: number | null, opts: { enabled?: boolean } = {}) {
  const sourceId = useResolvedSourceId();
  return useQuery({
    queryKey: ['tracerouteParticipation', sourceId, nodeNum],
    queryFn: () => apiService.getTracerouteParticipation(nodeNum!, sourceId!),
    enabled: (opts.enabled ?? true) && nodeNum != null && !!sourceId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
```

Returns `{ data, isLoading, error, refetch }`. No `refetchInterval` — freshness on the newest row comes
from the poll (§6.4 rule 3).

### 6.3 `src/components/traceroute/TracerouteParticipationPicker.tsx` (+ `.module.css`) (WP2)

```tsx
export interface TracerouteParticipationPickerProps {
  entries: TracerouteParticipationEntry[];
  /** id of the row currently in the strip; `null` while it comes from the poll row. */
  selectedId: number | null;
  onSelect: (id: number) => void;
  nodes: DeviceInfo[];
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
}
```

- Renders `null` when `entries.length < 2` — a single-entry dropdown is chrome with no choice in it.
- A labelled native `<select>`: `<label className={styles.label} htmlFor={id}>` + `<select id={id}
  className={styles.select} value={selectedId != null ? String(selectedId) : ''}
  onChange={e => onSelect(Number(e.target.value))}>`.
- Option label, built by an exported pure helper so it is testable without rendering:

```ts
export function buildOptionLabel(
  entry: TracerouteParticipationEntry,
  nodes: DeviceInfo[],
  fmt: { timeFormat: TimeFormat; dateFormat: DateFormat; t: TFunction },
): string
```

  Composition — `${when} · ${endpoints} · ${hops}${relayed}`:
  - `when` = `formatDateTime(entry.timestamp, timeFormat, dateFormat)`
  - `endpoints` = `t('messages.traceroute_edge_endpoints', { from, to })` where `from`/`to` come from
    `getNodeShortName(nodes, entry.fromNodeId)` / `…toNodeId` (falls back to the hex id itself)
  - `hops` = `entry.hopCount == null ? t('messages.traceroute_picker_no_route', 'no route')
    : t('messages.traceroute_picker_hops', { count: entry.hopCount })`
  - `relayed` = `entry.participation === 'hop' ? ' · ' + t('messages.traceroute_picker_relayed', 'relayed') : ''`
- `.module.css` holds only layout (inline-flex row, gap, `max-width: 100%`, `text-overflow: ellipsis`
  on the select). No colour literals — use the existing `--ctp-*` custom properties.
- `UiIcon name="route"` before the label. No literal emoji.

### 6.4 `src/components/MessagesTab.tsx` (WP2) — the coexistence rules

**Gate (line 1946).** Replace

```tsx
{hasPermission('traceroute', 'write') && (() => {
```

with

```tsx
{/* Read gate: the box is a DISPLAY. `write` still gates the request button
    (lines ~1279 / ~2147) and the channel split-button. `|| write` keeps a
    write-without-read user exactly where they were before this change. */}
{(hasPermission('traceroute', 'read') || hasPermission('traceroute', 'write')) && (() => {
```

**State** (component scope, near the existing `recentTrace`):

```tsx
const selectedNodeNum = selectedDMNode ? parseNodeId(selectedDMNode) : null;
const { data: participationEntries, refetch: refetchParticipation } =
  useNodeTraceroutes(selectedNodeNum, { enabled: !!selectedDMNode });
const entries = participationEntries ?? [];
const [pickedTracerouteId, setPickedTracerouteId] = useState<number | null>(null);
```

**Rule 1 — which row the strip shows.**

```tsx
const pickedEntry = pickedTracerouteId != null
  ? entries.find(e => e.id === pickedTracerouteId) ?? null
  : null;
// Newest-of-both, not "entries[0] always": between firing a traceroute and the
// next participation refetch, the poll row (`recentTrace`) is the newer one, and
// it is what carries the pending/failed badge. Comparing timestamps keeps the
// shipped TCP behaviour byte-identical while letting the picker supply the row
// on MQTT, where `recentTrace` is always null (no origin node).
const newestAvailable =
  !recentTrace ? entries[0] ?? null
  : !entries[0] ? recentTrace
  : entries[0].timestamp >= recentTrace.timestamp ? entries[0] : recentTrace;
const displayedTrace = pickedEntry ?? newestAvailable;
```

  A picked id that disappears from a refetched list falls back to `newestAvailable` by construction.

**Rule 2 — selection resets on node change.**

```tsx
useEffect(() => { setPickedTracerouteId(null); }, [selectedDMNode]);
```

**Rule 3 — a fresh traceroute response resets to newest and refreshes the list.**

```tsx
// The poll sees a new/updated row first; clear any manual pick so the user
// looking at a node they just traced sees the result, and pull the picker list
// forward so the new row is selectable.
useEffect(() => {
  if (recentTrace?.timestamp == null) return;
  setPickedTracerouteId(null);
  void refetchParticipation();
}, [recentTrace?.timestamp, refetchParticipation]);
```

**Rule 4 — badges and age follow the displayed row.** Rename `recentTrace` → `displayedTrace` inside the
IIFE (lines ~1951-2016) and change nothing else: `age`, `ageStr`, `forwardFailed`, `returnFailed`,
`isPending`, `isFailed`, `last_traced` and both badges keep their exact expressions. For a picked
historical row this reads correctly ("last traced 3d ago … (Failed)" describes *that* traceroute).

**Rule 5 — strip memo.** `tracerouteStrip` switches its input and dependency from `recentTrace` to
`displayedTrace`. Nothing else in the memo changes; `currentNodeNum` stays `null` on MQTT and
`buildStripNodeMeta` already handles that.

**Rule 6 — picker placement.** Inside the returned `<div className="traceroute-info">`, above
`<TracerouteStrip>`:

```tsx
<TracerouteParticipationPicker
  entries={entries}
  selectedId={displayedTrace && 'participation' in displayedTrace ? displayedTrace.id : (displayedTrace?.id ?? null)}
  onSelect={setPickedTracerouteId}
  nodes={nodes}
  timeFormat={timeFormat}
  dateFormat={dateFormat}
/>
```

**Rule 7 — the box must render when only the picker has data.** Today the IIFE returns `null` unless
`recentTrace` is truthy — that is exactly why MQTT never shows the strip. Change the guard to
`if (displayedTrace) { … }`.

**Type note.** `TracerouteData` (MessagesTab:72) declares non-null `route`/`routeBack`. Widen the local
union rather than editing that interface:

```ts
type DisplayedTraceroute = TracerouteStripInput & { id?: number; timestamp: number };
```

---

## 7. i18n (WP2) — `public/locales/en.json`, flat keys, inline defaults at every call site

```json
"messages.traceroute_picker_label": "Traceroute",
"messages.traceroute_picker_aria": "Choose which traceroute to display",
"messages.traceroute_picker_hops_one": "{{count}} hop",
"messages.traceroute_picker_hops_other": "{{count}} hops",
"messages.traceroute_picker_no_route": "no route",
"messages.traceroute_picker_relayed": "relayed"
```

Reused, not re-added: `messages.traceroute_edge_endpoints`, `messages.traceroute_unknown_node`,
`messages.last_traced`, `messages.traceroute_pending`, `messages.traceroute_failed`,
`messages.traceroute_no_response`, `messages.traceroute_no_return_path`. English only — other locales
fall through to the inline defaults, as in Phase 1.

---

## 8. Test plan

### 8.1 `src/utils/tracerouteSegments.test.ts` (extend, WP1)
- endpoint match on `fromNodeNum`; on `toNodeNum`; both directions
- hop match inside `route`; inside `routeBack`
- endpoint precedence when the node is both an endpoint and present in `routeBack`
- non-participant → `null`
- **string-typed** `fromNodeNum`/`toNodeNum` (the PG/MySQL BIGINT shape) still match
- `route: 'not-json'`, `'null'`, `null`, `''` → no throw, no match
- a hop value that is a *substring* of the queried node number (e.g. query `1234`, route `[12345]`)
  does **not** match — the regression a `LIKE '%1234%'` implementation would have shipped

### 8.2 `src/db/repositories/traceroutes.participation.test.ts` (new, WP1)
SQLite via `createTestDb()`; follow `traceroutes.test.ts` for construction. The participation filter is
pure JS and dialect-independent, so the PG/MySQL matrices in `traceroutes.test.ts` are **not** duplicated
here — instead §8.1 covers the only backend-sensitive part (string node numbers). No schema change means
no `nodes.test.ts` DDL edit.
- returns rows where the node is `from`, `to`, a `route` hop, a `routeBack` hop
- excludes non-participants
- excludes rows older than `sinceTimestamp`
- newest-first ordering
- `limit` caps the result; `scanLimit` bounds the scan (insert `scanLimit + 5` rows where only the
  oldest few match, assert the older ones are not returned — documents the deliberate tradeoff)
- `participation` is `'endpoint'` vs `'hop'` correctly per row
- passing `sourceId: undefined` throws (`withSourceScope` fail-closed)

### 8.3 `src/db/repositories/traceroutes.participation.perSource.test.ts` (new, WP1)
Template: `mqttPacketLog.perSource.test.ts`.
- identical `nodeNum` participates in rows on `source-a` and `source-b`; a query for `source-a` returns
  only `source-a` rows, and vice versa
- hop-only participation is likewise source-isolated (the JS filter runs *after* the scoped WHERE, so
  this is the test that would catch a dropped `withSourceScope`)
- `ALL_SOURCES` returns both (documents the explicit opt-in)

### 8.4 `src/server/routes/tracerouteRoutes.participation.test.ts` (new, WP1)
**Must** use `createRouteTestApp({ mount: app => app.use('/', tracerouteRoutes) })` (CLAUDE.md). Seed rows
with `harness.db.traceroutes.insertTraceroute(row, harness.sourceA)`. The existing
`tracerouteRoutes.test.ts` (whole-module `vi.mock`) is legacy and is **not** converted in this phase.
- 200 + `{ success: true, data: { entries } }` for `harness.limited` granted `traceroute:read` on `sourceA`
- 403 when granted only on `sourceB` (per-source permission enforcement, real SQL)
- 403 for the ungranted/anonymous agent
- 400 `MISSING_SOURCE_ID` with no `sourceId`
- 400 `INVALID_NODE_NUM` for `abc` and for `4294967296`
- 400 `INVALID_LIMIT` / `INVALID_HOURS` at the boundaries
- rows seeded on `sourceB` never appear in a `sourceA` query (endpoint-level isolation)
- hop-only participation is returned (seed a row whose `route` contains the queried node but whose
  endpoints do not)
- `routePositions` is absent from every entry
- `hopCount` is `null` for a null/unparseable route, and the array length otherwise
- channel masking: a row with `channel: 0` is dropped for a user without `channel_0:viewOnMap`, and
  present for `harness.admin`

### 8.5 `src/services/api.test.ts` (extend, WP1)
- `getTracerouteParticipation` hits `/api/traceroutes/participation/:nodeNum` with the encoded query
  string and returns the **unwrapped** `data.entries`; a body without `data` yields `[]`.

### 8.6 `src/components/traceroute/TracerouteParticipationPicker.test.tsx` (new, WP2)
- renders nothing for 0 and for 1 entry; renders a `<select>` with N `<option>`s for N ≥ 2
- options preserve newest-first order
- `buildOptionLabel`: time + `from → to` + "3 hops"; "1 hop" singular; "no route" for
  `hopCount: null`; " · relayed" appended only for `participation: 'hop'`
- unknown node ids fall back to the hex id rather than rendering empty
- selecting an option calls `onSelect` with the **numeric** id (not the string from the DOM event)
- the select reflects `selectedId`; `selectedId: null` leaves it unselected without crashing

### 8.7 `src/components/MessagesTab.tracerouteParticipation.test.tsx` (new, WP3)
Copy the mock block from `MessagesTab.tracerouteStrip.test.tsx` (including the local `react-i18next`
override), and add `vi.mock('../hooks/useNodeTraceroutes')`.
- **MQTT no-origin:** `currentNodeId: ''`, `getRecentTraceroute: () => null`, hook returns 2 entries →
  the traceroute box renders, the strip renders the newest entry, the picker is present. This is the
  headline behaviour of the phase.
- **default = newest:** with 3 entries and no `recentTrace`, the strip's rendered hops match `entries[0]`
- **newest-of-both:** `recentTrace.timestamp > entries[0].timestamp` → `recentTrace` is displayed and the
  pending/failed badge still renders (the shipped TCP path is unchanged)
- **explicit selection:** choosing the third option renders that row's hops; the "last traced" line
  reflects that row's timestamp
- **reset on node change:** after a pick, changing `selectedDMNode` returns the display to newest
- **reset on fresh response:** after a pick, re-rendering with a newer `recentTrace` returns to newest
- **read-only permission:** `hasPermission` true for `traceroute:read` only → the box and picker render,
  the traceroute request button and the channel split-button do **not**
- **write-without-read:** still renders (non-regression for the `|| write` clause)
- **empty/error:** hook returns `[]` or errors → no picker, and the pre-existing `recentTrace` path is
  untouched

### 8.8 Suite-level
`npm test` (full Vitest) must be green — 0 failures — and `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v
'.claude/worktrees'` must be empty. No new `@typescript-eslint/no-explicit-any` or raw `fetch()` in
`src/components/**`. Confirm success via the JSON reporter's `success` field, not the summary line.

---

## 9. Work packages

### WP1 — Backend + client transport
**Files:** 1, 2, 3, 4, 10, 11, 12, 13, 14.
**Depends on:** nothing.

Acceptance:
- `tracerouteParticipationKind` implemented in `tracerouteSegments.ts` with §8.1 green, including the
  string-node-number and substring cases
- `getTraceroutesInvolvingNode` uses only the Drizzle query builder + JS filtering; no raw SQL anywhere;
  §8.2 and §8.3 green
- `GET /api/traceroutes/participation/:nodeNum` mounted, behind
  `requirePermission('traceroute','read',{sourceIdFrom:'query'})`, using `ok`/`fail`, applying
  `maskTraceroutesByChannel`, never emitting `routePositions`; §8.4 green via `createRouteTestApp`
- `apiService.getTracerouteParticipation` unwraps `data.entries`; §8.5 green
- The two pre-existing handlers in `tracerouteRoutes.ts` are byte-identical to `origin/main`
- `npm test` green; `lint:ci` clean

### WP2 — Hook, picker component, MessagesTab wiring
**Files:** 5, 6, 7, 8, 9, 15.
**Depends on:** WP1 for the real endpoint; may start against the §6.1 type with the hook mocked.

Acceptance:
- `useNodeTraceroutes` defers on a null `sourceId`/`nodeNum` and never fires a request that would 400
- `TracerouteParticipationPicker` renders only at ≥2 entries, styles via its own `.module.css` (nothing
  added to `nodes.css`/`messages.css`), uses `UiIcon`, has an accessible label; §8.6 green
- `MessagesTab` implements coexistence rules 1-7 verbatim: gate widened to `read || write`, the box
  renders when only the picker has data, badges/age read the displayed row, the strip memo keys off
  `displayedTrace`
- 6 new flat keys in `public/locales/en.json`, every call site carries an inline default
- No raw `fetch()` added to `src/components/**`; `lint:ci` clean

### WP3 — Integration tests, browser validation, docs
**Files:** 16, 17.
**Depends on:** WP1 + WP2.

Acceptance:
- §8.7 green, with the MQTT no-origin case and the default-newest case both asserted
- Full Vitest suite green (verify `success: true` via the JSON reporter, not the summary line);
  `lint:ci` clean by the in-repo-only rule
- Browser-validated in the dev container per CLAUDE.md (`docker-compose.dev.yml` + the USB override,
  load at `http://localhost:8080`): on an **MQTT** source, open a node's details, confirm the strip
  appears where it previously did not, the dropdown lists multiple traceroutes with readable labels, and
  selecting an older one re-renders the strip; on a **TCP** source, confirm "last traced X ago",
  the pending/failed badges, and the traceroute request button all still behave as before
- Epic doc Phase 2 exit criteria ticked and a dated Log entry added
- PR opened via `/create-pr`, CI watched with `/ci-monitor`

---

## 10. Risks and how the spec closes them

| Risk | Mitigation |
|---|---|
| Cross-source leak via the picker | `sourceId` required (400 otherwise), `withSourceScope` fail-closed, dedicated `*.perSource.test.ts` |
| Hop-position leak (#3092 class) | `routePositions` stripped from the projection **and** `maskTraceroutesByChannel` applied |
| PG/MySQL BIGINT-as-string breaks matching | `Number()` coercion in the predicate; `parseHopArray` already coerces; explicit unit test |
| Unbounded scan on a busy source | 7-day window + `scanLimit` 2000, ordered newest-first so only older rows can be missed |
| Regressing the shipped TCP request flow | "Newest of both" selection rule + rule 4 (badges follow the displayed row) + §8.7 non-regression cases |
| Write-without-read users losing the box | Gate is `read \|\| write`, with a test |
| Frozen global CSS | New styling lives in `TracerouteParticipationPicker.module.css` only |
