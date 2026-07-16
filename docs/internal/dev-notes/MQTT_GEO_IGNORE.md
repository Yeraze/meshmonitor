# MQTT Geo-Ignore — Behavior Reference

Internal reference for anyone touching MQTT bounding-box filtering, the
per-source ignore list, or node-purge behavior on `mqtt_bridge` sources.
Covers the fail-open ingestion model, geo evaluation/reappearance rules,
retroactive sweeps, and packet-log outcomes shipped by the MQTT Geo-Ignore
epic (issue #4115, PRs #4123/#4131/#4132).

> **Read this first if you're about to:** change `MqttPacketFilter`,
> `mqttIngestion.ts`'s POSITION_APP case, `mqttGeoSweepService.ts`,
> `ignoredNodes.ts`, or the `downlinkFilters.geo` config-save path in
> `sourceRoutes.ts`.

## TL;DR

- **Fail-open, not fail-closed.** A node with no known position always
  ingests. Only a POSITION packet that lands outside a configured bbox gets
  the node ignored — everything else flows.
- **Ignore reason lives on the row.** `ignored_nodes.reason` is `'manual'`
  or `'geo'`. Geo entries auto-lift when the node reports back in-bounds;
  manual entries never auto-lift. A manual ignore always wins over (upgrades)
  a geo one.
- **Going geo-ignored purges everything for that node on that source** —
  messages (incl. channel broadcasts), telemetry, traceroutes, neighbors,
  packet logs, the node row. Fire-and-forget, purge-once (only on the
  true→false insert transition).
- **POSITION is never early-dropped**, even for an already-ignored node —
  that's the only way a node can prove it moved back in-bounds and reappear.
- **Sweeps close the gap for stored (not-yet-refreshed) positions** — one
  runs on bridge start (add-only) and one on `downlinkFilters.geo` config
  save (lift-all-then-add).
- **`mqtt_bridge` only.** `mqtt_broker` sources have no geo config, but they
  now share the same `ignored_nodes`-backed defense-in-depth gate for
  *manual* ignores (Phase 2 behavior change — see below).

## Why fail-open (root cause of #4115)

The pre-epic filter (`MqttPacketFilter`'s old `passesMembership`) was
**fail-closed on node membership**: a node had to already be a known
"member" (usually established by a prior in-bbox position) before *any* of
its packets — NODEINFO, TEXT, TELEMETRY — would ingest. Two failure modes
fell out of that:

1. **GPS-less nodes were invisible.** A node that never sends POSITION (no
   GPS, or GPS disabled) could never earn membership, so its NODEINFO/TEXT/
   TELEMETRY packets were silently dropped forever — the node simply never
   appeared.
2. **Encrypted feeds froze membership.** Membership was seeded/evaluated
   pre-decryption in `handleDownlink`. On an encrypted channel the position
   payload isn't readable until `channelDecryptionService` runs *inside*
   `ingestServiceEnvelope` — a step that never happened for a packet the
   pre-decrypt membership gate had already dropped. The blocklist could
   never bootstrap or self-correct.

The rearchitecture flips the default: everything passes unless a POSITION
packet has proven the node belongs outside the box. Evaluation moved
post-decrypt, inside `ingestServiceEnvelope`, so it works identically for
plaintext and server-decryptable encrypted traffic.

## Ignore-list gating: what's dropped where

There are two gates, deliberately redundant (defense-in-depth), plus one
invariant that applies to both:

1. **Bridge early-drop** (`MqttBridgeManager.handleDownlink`, before
   ingestion): if the sender is already in `ignored_nodes` for this source
   (`isIgnoredCached`) **and** the packet has already decoded to a
   non-POSITION portnum, it's dropped immediately — no ingestion call. An
   *encrypted* packet (no decoded portnum) can't be proven non-position at
   this point, so it always flows through to ingestion, which re-applies
   the same rule after decrypt.
2. **Ingestion defense-in-depth gate** (`ingestServiceEnvelopeInner`, right
   before the portnum `switch`): the same `isIgnoredCached` check, again
   gated on `portnum !== POSITION_APP`. This is what covers
   `MqttBrokerManager`, which calls `ingestServiceEnvelope` directly and has
   no `handleDownlink` pre-gate of its own (see the Broker-source note
   below).
3. **POSITION always evaluated**, for every sender regardless of ignore
   state. This is load-bearing: it's the only packet type that can lift a
   geo-ignore, and the only way an ignored node's data can start flowing
   again. After a lift attempt inside the POSITION_APP case, there is a
   *third* ignore check (see [Geo evaluation](#geo-evaluation) below) that
   still blocks ingest for a position that came from a node that's ignored
   for another reason (manual, or a lift that lost a race).

Both reasons (`'manual'` and `'geo'`) gate identically at all three of these
checkpoints — the gate is a single `isIgnoredCached` lookup, not
reason-aware. Reason only matters to *who's allowed to lift* the row.

### Encrypted packets

An encrypted packet is *never* early-dropped based on ignore state, because
its portnum isn't known until `channelDecryptionService.tryDecrypt` runs
inside `ingestServiceEnvelopeInner`. If it decrypts to something other than
POSITION, the ingestion-layer gate (checkpoint 2 above) still drops it for
an ignored sender — so nothing has actually been "let through," it's just
evaluated one step later than a plaintext packet.

## Geo evaluation

All of this lives in `ingestServiceEnvelopeInner`'s `PortNum.POSITION_APP`
case (`src/server/mqttIngestion.ts`), which runs **after** decryption —
`filter.classifyPosition(position)` returns `'in' | 'out' | 'unknown' |
'no-geo'` (pure bbox math, no side effects; see `MqttPacketFilter`).

- **`'out'`**: the node is outside the bbox.
  1. Look up the existing node row (if any) to preserve a real display name.
  2. `addGeoIgnoreAsync(nodeNum, sourceId, nodeId, longName, shortName)` —
     insert-if-absent. If the node has never been seen before (its first
     packet ever is an out-of-bbox POSITION), there's no stored NodeInfo to
     borrow a name from, so it falls back to the same `Node !xxxxxxxx` /
     last-4-hex-digits stub the traceroute path uses, so the ignore-list UI
     never shows a blank entry.
  3. **Purge-once**: `addGeoIgnoreAsync` returns `true` only on the actual
     insert (the true→false transition). Only then does ingestion fire a
     `void databaseService.deleteNodeAsync(fromNum, sourceId)` —
     fire-and-forget, so the packet loop never blocks on a multi-table
     cascade. Re-running geo evaluation against an already-ignored node
     (e.g. its next out-of-bbox POSITION) is a no-op: `addGeoIgnoreAsync`
     returns `false` and no second purge fires.
  4. The position itself is dropped (`{ ingested: false, reason:
     'geo-ignored' }`) — an out-of-bbox position is never stored.
- **`'in'`**: `liftGeoIgnoreAsync(nodeNum, sourceId)` runs. This is the
  reappearance path — see below.
- **`'unknown'`** (bbox configured but no usable lat/lng in this packet) or
  **`'no-geo'`** (no bbox configured): no ignore-list mutation; falls
  through to the same "still-ignored?" check as `'in'`.

After any lift attempt, there's one more `isIgnoredCached` check before the
position is allowed to ingest. This catches three cases in one branch: a
manually-ignored node that happens to report an in-bounds position (must
stay ignored), a geo lift that lost a race to a concurrent manual upgrade
(see below), and an `'unknown'`-classified position from an ignored node. A
node that was never ignored (or was just lifted) passes through to the
normal fail-open ingest.

### Purge scope

`deleteNodeAsync(nodeNum, sourceId)` (`src/services/database.ts`) — the
epic extended this cascade with a broadcast-message purge
(`purgeMessagesFromNode`, ordered after `purgeDirectMessages` so the two
counts stay disjoint). Full cascade, all scoped to `(nodeNum, sourceId)`:
DMs, channel broadcasts, traceroutes + route segments, telemetry, neighbor
info, packet log entries, and finally the node row itself (plus eviction
from the in-memory node cache). No trace of the node remains for that
source.

### Manual-wins upgrade semantics

`addIgnoredNodeAsync` (the manual-ignore path, used by the Ignored Nodes UI)
always sets `reason: 'manual'` on upsert — even over an existing `reason:
'geo'` row. That's intentional: an operator's explicit block must never
silently revert to auto-managed. `liftGeoIgnoreAsync` is the mirror image —
it only deletes rows where `reason === 'geo'`; a manual row is left alone no
matter how the geo filter classifies the node's position.

### TOCTOU-safe lift

`liftGeoIgnoreAsync` evicts the in-memory cache entry (`isIgnoredCached`'s
backing `Set`) **after** confirming the delete, not before — the opposite
of the mirror-first convention the add paths use. Sequence: SELECT the
row's reason → DELETE `WHERE reason = 'geo'` → re-SELECT to confirm nothing
remains. If a concurrent manual upgrade landed between the initial SELECT
and the DELETE, the reason-guarded DELETE is a no-op and the re-SELECT still
finds a row — the cache entry is left in place and the function returns
`false`. Evicting the cache eagerly (mirror-first) would otherwise create a
window where a live `'manual'` DB row is invisible to `isIgnoredCached`
until the next full prime — a phantom un-ignore.

## Sweep

`mqttGeoSweepService.runSweep(sourceId, geo, { lift, sink })`
(`src/server/services/mqttGeoSweepService.ts`) closes the gap the realtime
path can't: a node's *stored* position only gets (re-)classified when a
fresh POSITION packet arrives, which may be minutes, hours, or never (dead
node) away. The sweep retroactively classifies every stored position
against the current bbox in one pass.

### Triggers

- **Bridge start** (`MqttBridgeManager.start()`): `lift: false` — add-only.
  A plain restart has no "old bbox" to diff against, so there's nothing
  sane to lift; any node already lifted (or never geo-ignored) stays that
  way. Fire-and-forget, must not delay bridge startup.
- **Config save**, when `downlinkFilters.geo` actually changed (field-by-
  field bbox comparison in `sourceRoutes.ts`, immune to JSON key-order
  noise): `lift: true` — lift pass first, then add pass. This is the
  **only** path allowed to lift geo-ignores in bulk.

### Why lift must be all-or-nothing

The lift pass (when `opts.lift`) unconditionally lifts **every** `reason:
'geo'` row for the source — it does not try to re-verify each node against
the new bbox before lifting. This is deliberate: a geo-ignored node has
already been purged, so **it has no stored position left to re-classify
against the new bbox**. There's nothing to test the lift decision against
except "was this row geo, and did the bbox change at all" — so the sweep
lifts everything and lets the realtime POSITION path (which fires on the
node's *next* packet) self-correct: a lifted node still outside the
(possibly changed) bbox gets re-ignored and re-purged the moment it reports
a position again, exactly like a never-ignored node. The add pass that
follows in the same sweep only classifies nodes that currently have a
*stored* position (i.e. never-purged/never-ignored nodes) — it cannot
re-purge a just-lifted node in the same run, because that node no longer
has a position row.

**Consequence:** any change to the bbox — including a *narrowing* that
should legitimately re-exclude some nodes — transiently readmits every
currently geo-ignored node. They reappear (empty of history, since they
were purged) and stay reappeared until their next POSITION packet, at which
point the realtime path re-evaluates and, if still outside, re-ignores
+ re-purges them. This window is a few packets wide in practice, not
unbounded, but it is a real (accepted) transient state.

### Stats shape

```ts
interface GeoSweepStats {
  sourceId: string;
  timestamp: number;   // completion time; start = timestamp - durationMs
  scanned: number;      // position-bearing, not-already-ignored rows evaluated
  ignored: number;      // addGeoIgnoreAsync returned true (new geo rows)
  purged: number;       // deleteNodeAsync calls that succeeded
  lifted: number;       // geo entries lifted; 0 when lift:false
  durationMs: number;
}
```

Exposed on `MqttBridgeStatus.lastGeoSweep` via the `GeoSweepStatsSink` duck
type (`MqttBridgeManager.recordGeoSweepStats`) — `null` before the first
sweep completes.

### In-flight serialization

`MqttGeoSweepService.inFlight` is a per-source `Map<string,
Promise<GeoSweepStats>>`. A second `runSweep` call for a source already
running is chained onto the tail of the first (`.then`), so sweeps for the
same source never execute concurrently — this avoids double-counting stats
and racing the ignore-list cache. A prior sweep's failure
(`.catch(() => undefined)`) doesn't sink the chain for later callers. The
map entry only clears in `.finally` when the resolving call is still the
tail, mirroring the `cliCommandLocks` pattern in `meshcoreManager.ts`.

### Single unpaginated scan

The add pass does one `databaseService.nodes.getAllNodes(sourceId)` call,
no pagination. Deliberate: per-source node counts are expected to stay in
the low thousands, and sweeps are rare (source start, config save) rather
than a hot path — the simplicity outweighs pagination complexity here.

### Favorites are not protected

Unlike `autoDeleteByDistanceService` (which explicitly skips
`node.isFavorite` nodes), neither the realtime geo-evaluation path nor the
sweep checks favorite status. A favorited node outside the bbox is
geo-ignored and purged exactly like any other node. This is intentional
parity with the realtime path, which also has no favorite exemption — the
sweep exists to converge stored state to what the realtime path would have
already done. A favorite exemption, if wanted, would need to land in both
places at once.

## Known windows/limits

- **One-packet local-packet/republish window.** In
  `MqttBridgeManager.handleDownlink`, `isIgnoredCached` is read once at the
  top (pre-gate time), but ingestion (which inserts the geo-ignore row) runs
  fire-and-forget *after* that read. A node's very first out-of-bbox
  POSITION is therefore still emitted as a `local-packet` event and
  republished to the local broker once, before the ignore takes effect —
  every subsequent packet from that node sees the updated cache and is
  gated correctly. Accepted trade-off: blocking the packet loop on
  ingestion to close this window was judged not worth the latency cost.
- **`drops.geo` undercounts.** `MqttPacketFilter.postFilterPosition`
  (called from `handleDownlink` to decide republish, incrementing
  `drops.geo` on `'out'`) only ever sees **plaintext** positions — an
  encrypted out-of-bbox position is classified post-decrypt inside
  `ingestServiceEnvelope`, which has no access to (and doesn't increment)
  the bridge's filter-level counters. `TODO(mqtt-geo-ignore-phase4)`: land
  per-reason ingest-outcome counters (see Packet-log outcomes below) so an
  operator can see the true geo-ignore rate including encrypted traffic.
- **Bbox edits transiently readmit geo-ignored nodes.** See "Why lift must
  be all-or-nothing" above — this includes narrowing edits, not just
  widening ones.

## Packet-log outcomes

`mqtt_packet_log.ingestOutcome` (`MqttIngestOutcome` in
`src/db/repositories/mqttPacketLog.ts`) includes two epic-added values:

- `'ignored'` — dropped by the ignore-list gate for a `'manual'` **or**
  `'geo'` reason (the log doesn't currently distinguish which — the
  `MqttIngestionResult.reason` union only carries `'ignored'` /
  `'geo-ignored'`, not the underlying `ignored_nodes.reason`).
- `'geo-ignored'` — the packet was itself the out-of-bbox POSITION that
  *triggered* the geo-ignore transition (see Geo evaluation above). Only
  ever set on the packet that caused the ignore, not subsequent drops of
  that node's other traffic (those log as `'ignored'`).

`mqttPacketLogService.mapOutcome` maps `MqttIngestionResult` →
`MqttIngestOutcome` 1:1 for these two reasons.

`TODO(mqtt-packet-monitor-frontend)`: the MQTT Packet Monitor frontend (its
own epic) needs to add labels/colors/filter options for `'ignored'` and
`'geo-ignored'` when it lands — as of this writing the outcome values exist
in the data model but the UI doesn't yet have dedicated treatment for them.

## Broker-source note

`mqtt_broker` sources have no `downlinkFilters.geo` config — the geo
bounding box only applies to `mqtt_bridge` sources (an upstream connection
has a "downlink," a locally-hosted broker's directly-connected devices do
not). However, because `MqttBrokerManager` calls the *same*
`ingestServiceEnvelope` entry point as the bridge, the ingestion-layer
defense-in-depth ignore gate (checkpoint 2 above) applies there too. This
is a **Phase 2 behavior change**: manual ignores (added via the Ignored
Nodes UI) now suppress MQTT ingestion on `mqtt_broker` sources as well,
where previously the old fail-closed *membership* gate lived only in the
bridge's `handleDownlink` and had no broker-side equivalent. Geo-ignore
*insertion* still can't happen on a broker source (no bbox config to
classify against — `classifyPosition` always returns `'no-geo'` when no
filter/bbox is passed), but a node already geo-ignored on a `mqtt_bridge`
source has no bearing on a `mqtt_broker` source — ignore state is
per-source, per `IgnoredNodesRepository`'s scoping model (composite PK
`(nodeNum, sourceId)`).
