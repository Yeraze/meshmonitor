# Transport Breakdown — Phase 1 Implementation Spec (#5101)

Branch `feature/5101-p1-transport-widgets`. Binding decisions live in
`TRANSPORT_BREAKDOWN_EPIC.md`; this spec turns Phase 1 into work packages.
Every claim below was checked against the tree at `c5efc962`. Line numbers
are approximate.

**No migrations. No packets sent. No timers armed.** Mesh impact checklist:
read-side analytics only. The InfoTab gains one 60 s HTTP poll (message
counts), the same cadence as its five existing ones. Nothing touches the radio.

---

## 0. Findings that change the plan

1. **Poll nodes carry no transport stamps.** `mapDbNodeToDeviceInfo`
   (`src/server/services/nodeDbMaintenanceService.ts` ~44-163) copies `viaMqtt`
   but drops `transportMechanism`, `transportLastRf`, `transportLastMqtt` and
   `transportLastUdp`. The client type (`src/types/device.ts` 60-79) already
   declares all four, and the per-source map calls `nodePassesTransportFilter`
   on these poll nodes (`useSourceView.ts` ~720, `NodesTab.tsx` ~700). So the
   per-source map filter today runs on `viaMqtt` alone: UDP is never
   recognised and #4240's decay never applies there. Only the Dashboard and
   Unified maps (raw rows via `sourceDashboardData.ts`) get the stamps.
   The epic's "Total Nodes: split client-side" cannot work without passing the
   four fields through. **WP4 does that.** Side effect: the per-source Nodes
   map starts honouring #4240 stamps and decay, which the Dashboard map already
   does. **The orchestrator must confirm this with the user before merge**
   (see Risks R1). Fallback if the user declines: WP4 computes node counts on
   the server inside the new counts endpoint instead, and the poll payload
   stays unchanged.
2. **MQTT sources never reach the survey hop histogram.** `getHopCounts` only
   counts traceroutes the source's local node took part in (#5289), and
   `resolveLocalNodeNums` (`src/server/utils/localNodeNums.ts`) returns no
   entry for MQTT sources. Bug (a) therefore does not affect the survey. It
   matters for the map's route-segment filter and Phase 2's per-transport
   records.
3. **`packet_log` is written only by the Meshtastic TCP manager**
   (`meshtasticManager.ts` ~2477 TX and ~6311 RX). MQTT sources write
   `mqtt_packet_log`, MeshCore writes `meshcore_packet_log`. So only one
   writer has bug (b), and the Packet Distribution card is empty on MQTT
   sources.
4. **`packet_log` has no `viaMqtt` column** (`src/db/schema/packets.ts`). The
   SQL class mapping therefore equals `classifyNodeTransport` with
   `viaMqtt` absent: `5 → mqtt`, `6 → udp`, everything else incl. NULL → rf.
5. **The Packet Distribution card hides itself when `total === 0`**
   (`InfoTab.tsx` ~737-783). With a transport filter, "UDP" on a mesh with no
   UDP traffic would remove the card and the buttons to undo it. WP5 must keep
   the header and controls on screen.

---

## 1. Reuse inventory (use these; justify anything new)

| Need | Reuse | Where |
|---|---|---|
| Transport class type | `NodeTransportClass` (`'rf'\|'udp'\|'mqtt'`) | `src/utils/nodeTransport.ts` |
| Node multi-class (OR) | `getNodeTransportClasses(node, cutoffSec)` | same |
| Active-window cutoff | `transportCutoffSec(maxAgeHours)` | same |
| MQTT-only source test | `isMqttOnlySourceType(sourceType)` | same, line 34 |
| Record → class | `tracerouteTransportClass(row)` (NULL → rf) | `src/utils/tracerouteTransport.ts` |
| "Sentinel wins" rule | `hopTransportClass(recordClass, hopIsMqtt)` | same |
| Per-hop sentinel, index-aligned | `decomposeTracerouteLinks(row)` → `TracerouteHopLink.snrUnknown` | `src/utils/tracerouteSegments.ts` ~509 |
| Radio transport resolution | `resolveRadioPacketTransport(packet)` | `src/server/constants/meshtastic.ts` ~271 |
| Protocol constants | `TransportMechanism.MQTT` (5), `.MULTICAST_UDP` (6) | same, ~94 |
| packet_log filter | `buildPacketLogWhere` transport clause | `src/db/repositories/packetLog.ts` ~96 |
| Source scoping | `withSourceScope(table, sourceId)` | `src/db/repositories/base.ts` ~244 |
| Envelope | `ok()` / `fail()` | `src/server/utils/apiResponse.ts` |
| Message read gating | the `GET /api/messages` block (scoped `hasPermission`, virtual `canRead`) | `src/server/routes/messageRoutes.ts` ~904-983 |
| Toggle-button look | `timeRangeButtonStyle(active)` already in the card | `InfoTab.tsx` ~697 |
| Chart palette | `var(--chart-1..8)` (defined per theme in `App.css`; guarded by `semanticTokens.test.ts`) | `src/App.css` |
| Survey styling | `NetworkSurveyPanel.module.css` (extend it) | `src/components/survey/` |
| Icons | `UiIcon` only, no emoji | `src/components/icons` |
| Route tests | `createRouteTestApp` harness | `src/server/test-helpers/routeTestApp.ts` |
| PG/MySQL fixtures | `createPostgresBackend(ddl, isolationKey)` / `createMysqlBackend` | `src/db/repositories/test-utils.ts` |

New things, and why an existing one does not fit:

- **`reachTransportClass()`** in `tracerouteTransport.ts`: one route-level
  class for a hop bucket. It composes `decomposeTracerouteLinks` +
  `tracerouteTransportClass` + `hopTransportClass`. No existing function
  collapses one record's forward leg to one class.
- **`countNodesByTransport()`** in `nodeTransport.ts`: a tally over
  `getNodeTransportClasses`. Pure, so it lives beside its peers.
- **`transportCondition()`** private helper in `packetLog.ts`: the shared
  home the brief asked for. It absorbs the existing exact-mechanism clause.
- **`getMessageCountsByChannelAndTransport()`** in `messages.ts`: the only
  existing counts (`getMessageCount`, `getMessageCountSince`) have no
  channel or transport axis, and the route needs the channel axis to apply
  read permissions.
- **`GET /api/messages/counts`** rather than extending `GET /api/stats`:
  `/api/stats` (`dataExchangeRoutes.ts`) gates on global `dashboard:read`
  (no `sourceIdFrom`), applies no channel filter, returns a bare body with no
  frontend consumer, and `tests/api-exercise-test.sh:286` pins its shape.
  Adding channel filtering there would change `messageCount` for its current
  callers. The new route sits next to its sibling count route
  `/api/messages/unread-counts` and shares its permission model.
- **`resolveMessageReadAccess()`** in new `src/server/utils/messageReadAccess.ts`:
  pulls the predicate out of `GET /api/messages` so the new count cannot
  drift from the list it counts. (The poll has a third copy using a
  pre-loaded permission set; left alone, see Deferred.)
- **`TransportBreakdown.tsx` + module CSS**: renders
  `RF n · UDP n · MQTT n`. Used twice in InfoTab. No inline-breakdown
  component exists.
- **i18n namespace `transport.*`**: none exists. `map.showRf` reads "Show RF"
  and `packet_monitor.filter.transport_*` reads "LoRa Only", so neither fits
  a bare label.

---

## 2. File-by-file changes

### (a) MQTT-ingested traceroutes — `src/server/mqttIngestion.ts` ~860

Add to the `record: DbTraceroute` literal in `ingestTraceroute`:

```ts
// #5101: every row this path writes arrived over MQTT. Without this the
// column stays NULL, which reads as RF (classifyNodeTransport's fallback).
transportMechanism: TransportMechanism.MQTT,
```

`TransportMechanism` is already imported (line ~93). `DbTraceroute.transportMechanism`
exists (`src/db/types.ts` ~231); both the SQLite upsert and the PG/MySQL
pending-update path persist it (`database.ts` ~2243-2252,
`traceroutes.ts` ~39, ~616, ~632). No other writer: `insertTracerouteAsync`
has two callers, and the TCP one already stamps `resolveRadioPacketTransport`
(`meshtasticManager.ts` ~8748).

### (b) packet_log transport — `src/server/meshtasticManager.ts` ~6342

```ts
// #5101: resolveRadioPacketTransport, not `?? LORA` — a packet with no
// explicit mechanism but viaMqtt=true arrived over the node's MQTT uplink.
// Still preserves an explicit 0 (INTERNAL).
transport_mechanism: resolveRadioPacketTransport(meshPacket),
```

(Already imported; used at ~8748.) Remove the stale `?? preserves 0` comment.

Leave these as they are, on purpose:
- **Dedup key and TTL** (~6300-6307) keep the raw `meshPacket.transportMechanism`.
  #5034 tuned that window, and it only changes for old firmware that omits the
  field. Changing it is out of scope.
- **`metadata.transport_mechanism`** (~6252) stays raw. It is the wire value.
- **The TX writer** (~2490) stamps `INTERNAL`, which is correct.

Historical rows stay LORA. No backfill. `packet_log` retention is bounded,
so this heals itself.

### (c) Network Survey hop histogram

**`src/utils/tracerouteTransport.ts`** — add:

```ts
import { decomposeTracerouteLinks } from './tracerouteSegments.js';

export interface ReachTransportInput extends TracerouteTransportFields {
  fromNodeNum: number;
  toNodeNum: number;
  route: string | null | undefined;
  snrTowards: string | null | undefined;
}

/**
 * One transport class for a whole answered route, for reach-by-hop-count
 * (#5101). The FORWARD leg is what `hops` counts (route.length), so only its
 * hops are consulted. Any forward hop carrying the unknown-SNR sentinel makes
 * the route 'mqtt' — the same sentinel-wins rule as hopTransportClass, so a
 * peer counts as RF-reachable only if every hop to it was RF-confirmed.
 * Otherwise the record's own class (NULL → 'rf').
 */
export function reachTransportClass(tr: ReachTransportInput): NodeTransportClass {
  const forwardUnknown = decomposeTracerouteLinks({
    fromNodeNum: tr.fromNodeNum, toNodeNum: tr.toNodeNum,
    route: tr.route, snrTowards: tr.snrTowards,
  }).some((l) => l.leg === 'forward' && l.snrUnknown);
  return hopTransportClass(tracerouteTransportClass(tr), forwardUnknown);
}
```

No import cycle (`tracerouteSegments.ts` imports only `nullIsland.js`).

**Classification decision (justified).** A route counts as MQTT when any
forward hop has the sentinel, even if its record class is RF. Reasons:
(1) the survey asks "what can this radio reach"; a peer reached through a
bridged leg is not reachable over RF at that hop count; (2) this is the rule
#5097 already applies on the map, so the same route cannot read RF in the
survey and MQTT on the map; (3) `tracerouteTransport.ts`'s module doc already
argues this and admits the sentinel also covers relay-role and decrypt
failures. Return-leg sentinels are ignored, since `hops` does not count that
leg. UDP comes only from the record class (a sentinel says nothing about UDP).
NULL record → RF.

**`src/db/repositories/analysis.ts`**

- `HopEntry` gains `transport?: NodeTransportClass` (import type from
  `../../utils/nodeTransport.js`).
- `GetHopCountsArgs` gains `includeTransport?: boolean`. Default off, so the
  Map Analysis `/hop-counts` payload and its select list stay unchanged.
- `newestAnsweredPerPeer(sourceId, local, side, includeTransport)`: when on,
  also select `transportMechanism: traceroutes.transportMechanism` and
  `snrTowards: traceroutes.snrTowards`.
- In `getHopCounts`, when `includeTransport`:
  ```ts
  transport: reachTransportClass({
    fromNodeNum: side === 'from' ? local : nodeNum,
    toNodeNum:   side === 'from' ? nodeNum : local,
    route: r.route, snrTowards: r.snrTowards ?? null,
    transportMechanism: r.transportMechanism == null ? null : Number(r.transportMechanism),
  })
  ```
  The endpoints are never filtered by `buildLegHopLinks`, so rebuilding them
  from `side` is exact. The class comes from the row that wins the existing
  newest/tie rule. No new tie logic.

**`src/server/services/networkSurveyService.ts`**

```ts
export interface HopBucket {
  hops: number;
  /** Total; always === rf + udp + mqtt. Kept for back-compat. */
  nodeCount: number;
  byTransport: { rf: number; udp: number; mqtt: number };
}
export function bucketHops(
  entries: Array<{ hops: number; transport?: NodeTransportClass }>,
): HopBucket[]   // missing transport → 'rf'
```
`buildNetworkSurvey` passes `includeTransport: true`. `maxHops` is unchanged.

**Response back-compat.** Additive field. Consumers checked:
`NetworkSurveyPanel.tsx` (updated), `NetworkSurveyPanel.test.tsx` (fixtures
lack `byTransport`, so the panel must tolerate its absence),
`surveyRoutes.test.ts` (checks only `Array.isArray`),
`networkSurveyService.test.ts` (`bucketHops` `toEqual` expectations need
`byTransport` added). No export, shell test or doc references `hopDistribution`.
`HopDistributionWidget` is unrelated (its own local type).

**`src/components/survey/NetworkSurveyPanel.tsx`**

- Add `byTransport?: { rf: number; udp: number; mqtt: number }` to the local
  `NetworkSurvey.hopDistribution` element type.
- Bar width stays `nodeCount / maxBucket`. Inside it, render up to three
  segments (`rf`, `udp`, `mqtt` order) as flex children sized by count. Skip
  zero-count segments. When `byTransport` is absent, render one segment
  (today's look).
- Bar gets `role="img"` and
  `aria-label={t('survey.hop_bar_label', { rf, udp, mqtt })}`.
  Segments get `data-testid={`survey-hop-${b.hops}-${cls}`}`.
- A legend under the list (only when `hopDistribution.length > 0`): three
  swatches + `t('transport.rf'|'transport.udp'|'transport.mqtt')`, then
  `t('survey.transport_note')` in `.surveyEmpty` style.

**`NetworkSurveyPanel.module.css`** — new classes. Colours use tokens with no
fallback:
```css
.surveyHopBar { display: flex; overflow: hidden; /* keep existing rules */ }
.surveyHopSeg { display: block; height: 100%; }
.surveyHopSegRf   { background: var(--chart-1); }
.surveyHopSegUdp  { background: var(--chart-6); }
.surveyHopSegMqtt { background: var(--chart-4); }
.surveyLegend { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.5rem; font-size: 0.8rem; }
.surveyLegendSwatch { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 2px; margin-right: 0.3rem; vertical-align: middle; }
```
`.surveyHopBar` currently sets `background: var(--color-accent)`. Keep that as
the no-`byTransport` look by giving the single fallback segment the accent
colour.

### (d) Packet distribution transport filter

**`src/db/repositories/packetLog.ts`**

```ts
import type { NodeTransportClass } from '../../utils/nodeTransport.js';
import { getPortNumName, PortNum, TransportMechanism } from '../../server/constants/meshtastic.js';

/**
 * Single home for packet_log transport predicates (#5101): the exact
 * mechanism filter (Packet Monitor) and the RF/UDP/MQTT class filter
 * (Info tab). The class mapping mirrors classifyNodeTransport with viaMqtt
 * absent — packet_log has no viaMqtt column: MQTT(5)→mqtt,
 * MULTICAST_UDP(6)→udp, anything else incl. NULL→rf.
 */
private transportConditions(
  column: SQL,
  filter: { transport_mechanism?: number; transportClass?: NodeTransportClass },
): SQL[] {
  const out: SQL[] = [];
  if (filter.transport_mechanism !== undefined) out.push(sql`${column} = ${filter.transport_mechanism}`);
  switch (filter.transportClass) {
    case 'mqtt': out.push(sql`${column} = ${TransportMechanism.MQTT}`); break;
    case 'udp':  out.push(sql`${column} = ${TransportMechanism.MULTICAST_UDP}`); break;
    case 'rf':   out.push(sql`(${column} IS NULL OR ${column} NOT IN (${TransportMechanism.MQTT}, ${TransportMechanism.MULTICAST_UDP}))`); break;
  }
  return out;
}
```

- `PacketLogFilterOptions` gains `transportClass?: NodeTransportClass`.
- `buildPacketLogWhere`: replace the inline `transport_mechanism` clause with
  `conditions.push(...this.transportConditions(sql`pl.transport_mechanism`, options))`.
- `getPacketCountsByNode(options?: { since?; limit?; portnum?; sourceId?; transportClass? })`:
  push `...this.transportConditions(sql`pl.transport_mechanism`, { transportClass })`.
- `getPacketCountsByPortnum(options?: { since?; from_node?; sourceId?; transportClass? })`:
  this query uses unaliased columns, so pass `sql`transport_mechanism``.

**`src/services/database.ts`** — add `transportClass?: NodeTransportClass` to
the inline option types of `getPacketLogCountAsync` (~4519),
`getPacketCountsByNodeAsync` (~4555) and `getPacketCountsByPortnumAsync`
(~4559). Pass-through only.

**`src/server/services/packetLogService.ts`** — same field on
`getPacketCountAsync` (~125), `getPacketCountsByNodeAsync` (~182),
`getPacketCountsByPortnumAsync` (~196).

**`src/server/routes/packetRoutes.ts`** `GET /stats/distribution` (~196):

```ts
const rawTransport = req.query.transport;
let transportClass: NodeTransportClass | undefined;
if (rawTransport !== undefined && rawTransport !== '' && rawTransport !== 'all') {
  if (rawTransport !== 'rf' && rawTransport !== 'udp' && rawTransport !== 'mqtt') {
    return fail(res, 400, 'INVALID_TRANSPORT', 'transport must be one of all, rf, udp, mqtt');
  }
  transportClass = rawTransport;
}
```
Validate before the `isEnabled()` early return, so a bad value always gets a
400. Pass `transportClass` to all three service calls (byDevice, byType,
total). **Keep the bare success body.** `getPacketDistributionStats` reads
`byDevice` directly; wrapping it in `ok()` would break InfoTab and
MessagesTab. Import `fail` from `../utils/apiResponse.js`.

**`src/services/packetApi.ts`** `getPacketDistributionStats` — add a fifth
optional positional `transport?: NodeTransportClass`, appended as
`transport=` when set. Positional keeps `MessagesTab.tsx:796` unchanged.

### (e) Network Statistics

**Nodes — pass-through (WP4), `nodeDbMaintenanceService.ts` `mapDbNodeToDeviceInfo`:**

```ts
// #5101 / #4240: the client's transport classifier reads these. Without them
// the per-source views fell back to viaMqtt alone (no UDP, no decay).
for (const key of ['transportMechanism', 'transportLastRf', 'transportLastMqtt', 'transportLastUdp'] as const) {
  if (node[key] !== null && node[key] !== undefined) deviceInfo[key] = Number(node[key]);
}
```
The server `DeviceInfo` (`meshtasticManager.ts` ~305) declares none of these
(nor `viaMqtt`). The mapper builds an untyped object, so add the four as
optional fields there for documentation. `Number()` because PG may return
BIGINT strings.

**Nodes — tally, `src/utils/nodeTransport.ts`:**

```ts
export interface TransportTally { rf: number; udp: number; mqtt: number }

/** Additive (OR): a node counts once in EVERY class it was heard on, so the
 *  parts can sum to more than nodes.length. Pass the cutoff once per render. */
export function countNodesByTransport(
  nodes: readonly NodeTransportFields[],
  cutoffSec?: number,
): TransportTally
```

**Messages — repository, `src/db/repositories/messages.ts`:**

```ts
/**
 * Message counts for one source, grouped by channel and viaMqtt (#5101).
 * The channel axis lets the route drop channels the caller cannot read.
 * NULL viaMqtt (pre-flag rows) is RF. Excludes `excludePortnums` the same
 * way getMessages does (NULL portnum kept).
 */
async getMessageCountsByChannelAndTransport(
  sourceId: string,
  excludePortnums: number[] = [],
): Promise<Array<{ channel: number; viaMqtt: boolean; count: number }>>
```
Drizzle only:
`select({ channel: messages.channel, viaMqtt: messages.viaMqtt, count: count() })`
`.from(messages)`
`.where(and(this.withSourceScope(messages, sourceId), excludePortnums.length ? or(isNull(messages.portnum), notInArray(messages.portnum, excludePortnums)) : undefined))`
`.groupBy(messages.channel, messages.viaMqtt)`.
Map rows to `channel: Number(r.channel)`, `viaMqtt: Number(r.viaMqtt) === 1`
(PG `true`, MySQL/SQLite `1`, NULL → false), `count: Number(r.count)` (PG
COUNT is BIGINT). NULL and false fall into the same class, so merge those two
groups for the same channel.

**`src/services/database.ts`** — facade:
```ts
async getMessageCountsByChannelAndTransportAsync(sourceId: string, excludePortnums?: number[]) {
  return this.messages.getMessageCountsByChannelAndTransport(sourceId, excludePortnums);
}
```

**Permission helper — new `src/server/utils/messageReadAccess.ts`:**

```ts
export interface MessageReadAccess {
  isAdmin: boolean;
  hasChannelsRead: boolean;   // channel_0:read, scoped
  hasMessagesRead: boolean;   // messages:read, scoped
  readableVirtual: ReadableVirtualChannels;   // from getUserReadableVirtualChannelIds
  authorizedChannelIds: Set<number>;          // channel_0..7 with scoped read
  /** True when the caller may read at least one channel kind. */
  canReadAny: boolean;
  /** DM (-1) → messages:read; virtual → per-entry canRead; physical → channel_0 AND channel_N. */
  canReadChannel(channel: number): boolean;
}
export async function resolveMessageReadAccess(user: User | null | undefined, sourceId: string | undefined): Promise<MessageReadAccess>
```
Move the logic verbatim from `GET /api/messages` (~920-983), including the
comments on why each check is scoped. Then rewrite `GET /api/messages` to use
it, with no behaviour change (covered by `messageRoutes.listScope.test.ts`).

**Route — `src/server/routes/messageRoutes.ts`**, next to `/unread-counts`:

```
GET /api/messages/counts?sourceId=<id>
  optionalAuth()
  400 MISSING_SOURCE_ID  when sourceId absent/empty
  403 FORBIDDEN          when !access.canReadAny  (same gate as GET /api/messages)
  200 ok(res, { sourceId, total, byTransport: { rf, mqtt } })
```
Handler: `resolveMessageReadAccess(req.user, sourceId)` →
`getMessageCountsByChannelAndTransportAsync(sourceId, [PortNum.TRACEROUTE_APP])`
(matches the poll window's exclusion, `pollRoutes.ts` ~156) → keep rows where
`access.canReadChannel(row.channel)` → sum. `total === rf + mqtt` always.
Phase 2 adds `byTransport.udp`. Errors go through `fail(res, 500, 'MESSAGE_COUNTS_FAILED', …)`.

**Client — `src/services/api.ts`:**
```ts
export interface MessageCounts { sourceId: string; total: number; byTransport: { rf: number; mqtt: number } }
async getMessageCounts(sourceId: string): Promise<MessageCounts | null> {
  const res = await this.get<{ success: boolean; data?: MessageCounts }>(
    `/api/messages/counts?sourceId=${encodeURIComponent(sourceId)}`);
  return res?.data ?? null;   // ApiService does NOT unwrap `data`
}
```

### InfoTab UI (WP5) — `src/components/InfoTab.tsx`

Props: add `maxNodeAgeHours?: number`. `App.tsx` ~3614 passes the
`maxNodeAgeHours` it already reads from `useSettings()`.

Source type: `const { sourceId: activeSourceId, sourceType } = useSource();`
then `const showTransport = !isMqttOnlySourceType(sourceType);`

**Total Nodes** (~557):
```tsx
<p><strong>{t('info.total_nodes')}</strong> {nodes.length}</p>
{showTransport && nodes.length > 0 && (
  <TransportBreakdown
    label={t('info.heard_via')}
    counts={nodeTally}                // useMemo(() => countNodesByTransport(nodes,
                                      //   maxNodeAgeHours ? transportCutoffSec(maxNodeAgeHours) : undefined),
                                      //   [nodes, maxNodeAgeHours])
    note={nodeTally.rf + nodeTally.udp + nodeTally.mqtt > nodes.length
      ? t('info.transport_overlap_note') : undefined}
    testId="info-nodes-transport" />
)}
```
Wording choice: the label reads "heard via", so a reader expects a node heard
two ways to count twice. The overlap note appears **only** when the parts
exceed the total, so a sum that does not add up always carries its reason.
No tooltip-only explanation (tooltips do not show on phones).

**Total Messages** (~559):
- New state `messageCounts: MessageCounts | null`, loaded by
  `fetchMessageCounts = useCallback(…, [connectionStatus, activeSourceId])`
  and an effect with a 60 s interval, like its neighbours. Complete deps; do
  not add an `exhaustive-deps` violation.
- Display `messageCounts?.total ?? '—'` when `activeSourceId` is set.
  Otherwise (legacy, no source) keep `messages.length`.
- Under it, when `showTransport && messageCounts && messageCounts.total > 0`:
  `<TransportBreakdown counts={{ rf, mqtt }} testId="info-messages-transport" />`
  (no UDP entry until Phase 2; no overlap note, since the parts partition the
  total).

**Packet Distribution + Nodes by Packet Type** (~206-250, ~672-860):
- State `distributionTransport: 'all' | NodeTransportClass` (default `'all'`).
  **One shared selector drives both cards**, like `distributionTimeRange`
  already does. That keeps the per-portnum dropdown counts (read from
  `packetDistribution.byType`) consistent with the donut below them.
- Pass `distributionTransport === 'all' ? undefined : distributionTransport`
  as the 5th argument in both `fetchPacketDistribution` and
  `fetchPortnumNodeDistribution`, and add it to both `useCallback` deps.
- Render a `transportButtons` group beside `timeRangeButtons`, reusing
  `timeRangeButtonStyle`, with `aria-pressed`, labels
  `transport.all|rf|udp|mqtt`, and `data-testid="dist-transport-<value>"`.
  Omit it when `!showTransport`.
- Restructure the render so the header row (title, total, both button
  groups) shows whenever `packetDistribution.enabled`. When
  `total === 0 && distributionTransport !== 'all'`, the body shows
  `t('info.no_packets_for_transport', { transport: t('transport.' + cls) })`
  under the header rather than dropping the card. Keep today's
  `info.no_packet_data` card for `total === 0` with `'all'`.
  **Keep the #5195 structure**: the header row stays the
  `<div style={{ display: 'flex', justifyContent: 'space-between'` … `flexWrap: 'wrap'`
  element just above `t('info.packet_distribution'`, and `timeRangeButtons`
  stays a `const` with its own `flexWrap: 'wrap'` div
  (`InfoTab.packetDistributionLayout.test.ts` asserts both).

**New `src/components/TransportBreakdown.tsx` + `TransportBreakdown.module.css`**

```tsx
export interface TransportBreakdownProps {
  counts: { rf: number; udp?: number; mqtt: number };
  label?: string;
  note?: string;
  testId?: string;
}
export default function TransportBreakdown(props): JSX.Element
// renders: [label] RF n · UDP n · MQTT n   (UDP omitted when counts.udp undefined)
//          [note on its own line, muted]
```
Export only the component (react-refresh lint rule). The CSS module uses
`var(--color-text-muted)`, `font-size: 0.85em`, and
`font-variant-numeric: tabular-nums`. Separators are plain text `·`
characters inside the copy, not icons.

### i18n — `public/locales/en.json` (flat keys; other locales fall back)

WP2 adds the shared ones:
```
"transport.all": "All",
"transport.rf": "RF",
"transport.udp": "UDP",
"transport.mqtt": "MQTT",
"survey.hop_bar_label": "{{rf}} RF, {{udp}} UDP, {{mqtt}} MQTT",
"survey.transport_note": "MQTT also counts routes with a hop whose signal could not be measured, which usually means an MQTT-bridged leg.",
```
WP5 adds:
```
"info.heard_via": "Heard via",
"info.transport_overlap_note": "A node heard over more than one transport counts in each, so these add up to more than the total.",
"info.transport_filter": "Transport",
"info.no_packets_for_transport": "No {{transport}} packets in this time range."
```

### Source types

- **MQTT-only (`mqtt_bridge`, `mqtt_broker`)**: hide the node and message
  breakdowns and the packet transport selector. Every node and message there
  is MQTT by construction, so the split can only read "MQTT = total"
  (`isMqttOnlySourceType` doc, #5283). The survey histogram is empty for
  these sources anyway (finding 2). The legend renders only with data.
- **MeshCore (`meshcore`, `meshcore_mqtt`)**: nothing to do. `main.tsx` ~103
  routes them to `MeshCoreSourcePage` / its ingest page, so InfoTab never
  mounts. The survey service is Meshtastic-scoped by design, and MeshCore
  packets go to `meshcore_packet_log`, not `packet_log`.

---

## 3. Test plan (standard Vitest suite)

Before trusting a local run in an agent worktree:
`git submodule update --init --recursive` and symlink `node_modules`. Start
the PG (5433) and MySQL (3307) containers from CLAUDE.md, or those suites
skip silently. Check `numPendingTests` in the JSON reporter.

**Unit**
- `src/utils/tracerouteTransport.test.ts` (extend) — `reachTransportClass`:
  NULL mechanism → rf; mechanism 5 → mqtt; 6 → udp; 0 and 7 → rf; RF record
  with forward `snrTowards` containing `-128` (raw; /4 = sentinel) → mqtt;
  sentinel only in `snrBack` → record class; `route '[]'` with
  `snrTowards '[-128]'` → mqtt; empty/absent `snrTowards` → record class;
  UDP record with forward sentinel → mqtt (sentinel wins).
- `src/utils/nodeTransport.test.ts` (extend) — `countNodesByTransport`:
  overlap node counted twice (sum > length); cutoff drops a stale class;
  all-stale node falls back to its newest class (never zero); no stamps +
  `viaMqtt` → mqtt; no stamps, no flag → rf.
- `src/server/services/networkSurveyService.test.ts` (update) — `bucketHops`
  expectations gain `byTransport`; missing transport → rf; invariant
  `nodeCount === rf+udp+mqtt`; `getHopCounts` called with
  `includeTransport: true`.
- `src/server/utils/messageReadAccess.test.ts` (new) — `canReadChannel` for
  DM with and without `messages:read`, a physical channel without
  `channel_N`, a virtual channel with and without `canRead`, and admin.
  Stub `hasPermission` / `getUserReadableVirtualChannelIds`.

**Ingest**
- `src/server/mqttIngestion.test.ts` (extend `TRACEROUTE_APP`, ~731) —
  `record.transportMechanism === TransportMechanism.MQTT`.
- `src/server/meshtasticManager.packetLogTransport.test.ts` (new; template
  `meshtasticManager.heardReflood.test.ts`, which drives `processMeshPacket`
  with a mocked `packetLogService`; set `isEnabled` → true) — `logPacket`
  receives `transport_mechanism`: 5 for `{transportMechanism: undefined, viaMqtt: true}`;
  1 for neither; 0 for explicit INTERNAL (if not excluded as phantom-internal
  first, otherwise pick 7 API); 6 for explicit UDP.

**Repository, all three backends**
- `src/db/repositories/analysis.hopCounts.multiBackend.test.ts` (extend) —
  add a `transportMechanism` column to all three hand-written `CREATE TABLE`
  blocks (`INTEGER` / `INTEGER` / `INT`), and extend `insertSql` with
  `transportMechanism` and `snrTowards`. Cases with `includeTransport: true`:
  NULL → rf, 5 → mqtt, 6 → udp, RF + forward sentinel → mqtt; newest-row wins
  also for transport. Without the flag, entries carry no `transport` key.
  Existing isolation keys stay.
- `src/db/repositories/packetLog.transportClass.multiBackend.test.ts` (new;
  DDL copied from `packetLog.broadcastTelemetry.multiBackend.test.ts`, plus a
  minimal `nodes` table (`nodeNum`, `sourceId`, `longName`) because
  `getPacketCountsByNode` has a scalar subquery on `nodes`; isolation key
  `r_packetlog_transport_class`). Insert one row per mechanism in
  `[null,0..7]`. **Parity test:** for each class, `getPacketLogCount`,
  `getPacketCountsByNode` and `getPacketCountsByPortnum` totals equal the
  number of inserted mechanisms where
  `classifyNodeTransport({ transportMechanism: m }) === cls`. Also check that
  exact `transport_mechanism` filtering still works (regression for the
  refactor).
- `src/db/repositories/packetLog.transportClass.perSource.test.ts` (new,
  SQLite) — two sources with mirrored rows; `transportClass` + `sourceId`
  never returns the other source's rows in any of the three methods.
- `src/db/repositories/messages.transportCounts.multiBackend.test.ts` (new;
  hand DDL for `messages` from `src/db/schema/messages.ts`, with PG `BOOLEAN`
  and MySQL `TINYINT(1)` for `viaMqtt`; isolation key `r_messages_transport_counts`).
  Cases: viaMqtt true, false and NULL across two channels → NULL and false
  merge into rf; TRACEROUTE_APP excluded; NULL portnum kept; `count` is a
  number on PG.
- `src/db/repositories/messages.transportCounts.perSource.test.ts` (new,
  SQLite) — source isolation; `sourceId: ''` throws (withSourceScope guard).

**Routes (harness, `createRouteTestApp`; template `sourceRoutes.permissions.test.ts`)**
The harness does not clear `packet_log` or `messages`. Delete inserted rows
in `afterEach`. Grants need a `sourceId`.
- `src/server/routes/packetRoutes.distributionTransport.test.ts` —
  `packet_log_enabled=true` set via settings; rows on sourceA/sourceB;
  `?sourceId=A&transport=mqtt` returns only A's MQTT rows in byDevice, byType
  and total; `transport=all` and absent are identical; `transport=bogus` →
  400 `INVALID_TRANSPORT`; a limited user without `packetmonitor:read` on A →
  403; the success body is still bare (`byDevice` at top level).
- `src/server/routes/messageRoutes.counts.test.ts` — admin gets the totals
  and the rf/mqtt split; a limited user with `channel_0:read` only, on A,
  does not see channel-1 or DM counts; `messages:read` adds DMs; a grant on B
  does not authorise A (#3745 class); nothing granted → 403; missing
  `sourceId` → 400; the response is wrapped in `{ success, data }`.

**Components**
- `src/components/survey/NetworkSurveyPanel.test.tsx` (extend) — a
  `byTransport` fixture renders the segment test ids with no zero-width
  segment; the aria-label carries the counts; the legend appears only with
  buckets; the old fixture without `byTransport` still renders one bar.
- `src/components/TransportBreakdown.test.tsx` (new) — the text omits UDP
  when undefined; note shown/hidden.
- `src/components/InfoTab.transportBreakdown.test.tsx` (new). Mock
  `react-i18next`, `../services/api`, `../services/packetApi`,
  `../contexts/SourceContext`, `../hooks/useDashboardData`,
  `./ToastContainer`, `./TelemetryGraphs`, `./PacketRateGraphs`,
  `./survey/NetworkSurveyPanel` and `./PacketStatsChart`. Cases: nodes
  breakdown with overlap note; messages total from the API, not
  `messages.length`; both hidden for `sourceType: 'mqtt_bridge'`; clicking
  `dist-transport-udp` calls `getPacketDistributionStats` with `'udp'` as the
  5th argument for both fetches; with `total: 0` under `udp` the buttons stay
  rendered and the empty-transport message shows.
- `InfoTab.packetDistributionLayout.test.ts` must still pass unchanged.

**Gates**: full Vitest suite with PG + MySQL up (`success: true`, confirm
skipped count), `npx tsc --noEmit -p tsconfig.server.json` and the client
tsconfig, and `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'`
empty.

---

## 4. Work packages

File ownership is exclusive inside a wave. `src/services/database.ts` and
`public/locales/en.json` are the contended files, and the waves serialise them.

### Wave 1 (parallel)

**WP1 — Ingest transport bugs (a)+(b).** Small.
Files: `src/server/mqttIngestion.ts`, `src/server/mqttIngestion.test.ts`,
`src/server/meshtasticManager.ts`, new `src/server/meshtasticManager.packetLogTransport.test.ts`.
Accept: MQTT traceroutes stamp 5; the packet_log RX insert uses
`resolveRadioPacketTransport`; dedup and metadata unchanged; new tests fail
before the fix and pass after.

**WP2 — Survey stacked histogram (c).** Medium.
Files: `src/utils/tracerouteTransport.ts` (+test), `src/db/repositories/analysis.ts`,
`analysis.hopCounts.multiBackend.test.ts`, `analysis.test.ts` (SQLite cases for
`includeTransport`), `src/server/services/networkSurveyService.ts` (+test),
`src/components/survey/NetworkSurveyPanel.tsx` / `.module.css` / `.test.tsx`,
`public/locales/en.json` (the `transport.*` and `survey.*` keys only).
Accept: `nodeCount === rf+udp+mqtt` for every bucket; Map Analysis
`/hop-counts` payload unchanged (`analysisRoutes.test.ts` untouched and green);
PG/MySQL suites run, not skipped; old fixture renders.

**WP3 — packet_log transport filter, backend + client call (d).** Medium.
Files: `src/db/repositories/packetLog.ts`, `src/services/database.ts`
(packet-log facades only), `src/server/services/packetLogService.ts`,
`src/server/routes/packetRoutes.ts`, `src/services/packetApi.ts`, new
`packetLog.transportClass.multiBackend.test.ts`,
`packetLog.transportClass.perSource.test.ts`,
`packetRoutes.distributionTransport.test.ts`.
Accept: one `transportConditions` helper used by `buildPacketLogWhere`,
`getPacketCountsByNode` and `getPacketCountsByPortnum` (no other
`transport_mechanism` predicate left in the repo); parity test green on all
three backends; the existing `packetRoutes.test.ts` and Packet Monitor
transport filter unchanged.

### Wave 2 (after WP3, for `database.ts`)

**WP4 — Message counts API + node transport pass-through (e, backend).** Medium.
Files: `src/db/repositories/messages.ts`, `src/services/database.ts`
(messages facade), new `src/server/utils/messageReadAccess.ts` (+test),
`src/server/routes/messageRoutes.ts` (new route + `GET /` adopts the helper),
`src/server/services/nodeDbMaintenanceService.ts` (+ its test: the four
fields pass through and are Number-coerced), server `DeviceInfo` type,
`src/utils/nodeTransport.ts` (`countNodesByTransport` + test),
`src/services/api.ts` (`getMessageCounts`), new messages multiBackend /
perSource / route tests.
Accept: the route returns `ok()` envelope with `total === rf + mqtt`;
permission cases pass through the real harness;
`messageRoutes.listScope.test.ts` and `messageRoutes.test.ts` are unchanged
and green; the poll response carries the transport stamps (assert in
`nodeDbMaintenanceService.test.ts`). **Gate: user sign-off on R1 before this
merges.**

WP4 can start as soon as WP3 lands. It does not need WP1 or WP2.

### Wave 3 (after WP2, WP3 and WP4)

**WP5 — InfoTab UI (d, e).** Medium.
Files: `src/components/InfoTab.tsx`, `src/App.tsx` (one prop), new
`src/components/TransportBreakdown.tsx` / `.module.css` / `.test.tsx`, new
`InfoTab.transportBreakdown.test.tsx`, `public/locales/en.json` (`info.*`
keys).
Accept: the breakdowns render and hide per source type; the selector drives
both distribution cards and stays reachable at `total === 0`; the #5195
layout test is green; no new lint-ratchet counts; screenshot of the Info tab
(desktop + phone width) attached to the PR per UI-PR rule, taken from a dev
deploy.

---

## 5. Risks

- **R1 — Map behaviour change from the node pass-through (WP4).** Per-source
  Nodes-tab map visibility switches from `viaMqtt`-only to #4240 stamps with
  decay. Expected effects: UDP nodes start obeying Show UDP. A node whose
  only fresh stamp is MQTT (but `viaMqtt` false) hides under the default
  Show MQTT off. This matches the Dashboard/Unified maps and #4240's intent,
  but users will see it. Needs user sign-off. The fallback is in finding 1.
- **R2 — Historical packet_log rows stay LORA** after fix (b). The MQTT slice
  under-counts until retention (`packet_log_max_age_hours`, default 24 h)
  rolls them off. Say so in the PR.
- **R3 — Sentinel ≠ MQTT.** Relay-role hops and decrypt failures also write
  the sentinel, so the survey's MQTT slice slightly over-counts. It matches
  the map (#5097) and `survey.transport_note` says so.
- **R4 — Message count cost.** One `GROUP BY channel, viaMqtt` over a source's
  messages every 60 s per open Info tab. `idx_messages_source_id` exists.
  Same order as `/api/stats`'s existing full count.
- **R5 — API (7) and INTERNAL (0) packets count as RF**, per
  `classifyNodeTransport`. TX rows (`direction='tx'`, INTERNAL) land in RF.
  That is correct for a radio source, but it is a choice. Documented in the
  helper.
- **R6 — Test fixture DDL drift.** The hop-count multi-backend suite builds
  `traceroutes` by hand. Forgetting `transportMechanism` there fails every
  PG/MySQL case, not just the new ones.

## 6. Deferred (propose later phases or follow-ups)

- **Poll's third copy of the message-read predicate** (`pollRoutes.ts` ~150-180,
  using a pre-loaded permission set). Adopting `resolveMessageReadAccess`
  there changes how the poll loads permissions. Follow-up issue, not P1.
- **`/api/packets/stats/distribution` ignores per-channel permissions** for
  non-admins (byType/byDevice include hidden channels). Pre-existing; file an
  issue.
- **`/api/unified/packets/distribution`** gets no transport filter in P1
  (InfoTab is per-source).
- **Dedup TTL for viaMqtt-only packets** (see (b)) — revisit only if old
  firmware shows duplicate rows.
- **Messages UDP split** — Phase 2 (`messages.transportMechanism`).
