# MQTT Geo-Ignore Rearchitecture — Epic Plan

**Issue:** #4115 (nodes entirely missing from MQTT sources)
**Status:** In progress
**Owner decisions captured:** 2026-07-15

## Goal

Replace the fail-closed geo-membership filter on `mqtt_bridge` sources with a
**fail-open + retroactive-purge** model built on a per-source **Node Ignore
List**:

1. Packets from nodes with **no known position** are **accepted** (fail-open).
2. Every POSITION packet is evaluated **after decryption** against the source's
   geo boundary:
   - **Inside** → node is valid; if it was geo-ignored, lift the ignore so it
     "reappears".
   - **Outside** → (a) add the node to the source's ignore list with reason
     `geo`, (b) retroactively purge the node and ALL its associated data from
     that source (messages incl. channel broadcasts, telemetry, traceroutes,
     neighbors, packet logs, node row), (c) drop its future packets early.
3. POSITION packets from ignored nodes are **always still evaluated** (never
   early-dropped) — this is what allows reappearance.

This inherently fixes both #4115 defects: GPS-less nodes are no longer
invisible (fail-open), and encrypted POSITION packets can bootstrap/lift state
because evaluation happens post-decryption inside `ingestServiceEnvelope`, not
pre-decryption in `handleDownlink`.

## Interview decisions

| Question | Decision |
|---|---|
| Storage/UI | **Extend existing `ignored_nodes`** with a `reason` column (`'manual'` \| `'geo'`). Geo entries auto-lift on in-bounds position; manual entries never auto-lift. Existing cache/routes/UI reused; UI shows a reason badge. |
| Purge scope | **Everything** — extend `deleteNodeAsync` cascade to also purge the node's channel (broadcast) messages. No trace remains in the source's data. |
| Retro sweep | **Sweep on config change and bridge start** — nodes with stored out-of-bounds positions are ignored+purged immediately; bbox widening lifts geo-ignores that are now inside. |
| Source scope | **`mqtt_bridge` only** (only type with geo config today). |

## Out of scope (noted, not planned)

- `mqtt_broker` sources (no filter config today).
- Manual "never geo-ignore this node" pin/exempt list.
- `estimated_positions` purge (global-by-design, cross-source, #3271).
- Hysteresis for border-oscillating nodes (re-ignore after reappear only purges
  data accumulated since; acceptable).
- The per-channel view flash Matt reported (separate UI bug).

## Key reuse inventory (mandatory for architects)

- `src/db/repositories/ignoredNodes.ts` — per-source blocklist + O(1)
  `isIgnoredCached` hot-path cache (primed at startup, kept in lock-step).
- `databaseService.deleteNodeAsync(nodeNum, sourceId)`
  (`src/services/database.ts:3162`) — existing cascade: DMs, traceroutes,
  route segments, telemetry, neighbors, packet logs, node row.
- `src/server/services/autoDeleteByDistanceService.ts` — prior art for
  geo-driven ignore/delete decisions.
- `src/server/mqttPacketFilter.ts` — bbox math (`postFilterPosition`),
  topic/channel/node/portnum filters (these stay).
- `src/server/routes/ignoredNodeRoutes.ts` + `IgnoredNodesSection.tsx` — API/UI.
- Repository-level ignore re-apply on `upsertNode` (see
  `meshtasticManager.ignoreReapply.test.ts`) — recreated shells (e.g. from a
  member's traceroute referencing an ignored node) come back flagged ignored.

## Phases

### Phase 1 — Data layer: ignore reasons + full-purge cascade
- [ ] Migration (all 3 backends, idempotent, registry-registered): add
  `reason TEXT NOT NULL DEFAULT 'manual'` to `ignored_nodes`.
- [ ] `IgnoredNodesRepository`: reason-aware add/list; `addGeoIgnoreAsync`,
  `liftGeoIgnoreAsync` (removes only `reason='geo'` rows); records expose reason.
- [ ] Messages repo: `purgeMessagesFromNode(nodeNum, sourceId)` (channel
  broadcasts); wire into `deleteNodeAsync` cascade.
- [ ] `ignoredNodeRoutes` + `IgnoredNodesSection.tsx`: surface reason (badge),
  manual unignore allowed for geo entries.
- [ ] Tests: repo unit + perSource isolation + migration + route tests
  (route-test harness).
- **Exit:** primitives shipped inert (no behavior change to ingestion); suite
  green; PR merged.

### Phase 2 — Core gating rearchitecture (the behavior flip)
- [ ] `MqttBridgeManager.handleDownlink`: remove fail-closed
  `passesMembership` ingestion gating + membership seeding
  (`seedDownlinkMembership`); add early drop of **non-POSITION** packets from
  ignored senders via `isIgnoredCached`; POSITION always flows to ingestion.
- [ ] `ingestServiceEnvelope` POSITION_APP case: post-decrypt geo evaluation —
  outside → `addGeoIgnoreAsync` + async purge + drop position; inside →
  `liftGeoIgnoreAsync` (reappear) + normal ingest.
- [ ] Also early-drop ignored senders inside `ingestServiceEnvelope`
  (defense-in-depth for the broker-manager caller which shares this path).
- [ ] Republish-to-local-broker path: skip packets from ignored senders;
  plaintext out-of-bbox positions still not republished.
- [ ] Remove/retire membership machinery in `MqttPacketFilter`
  (`passesMembership`, `seedTrustedNodes`, `seedMembership`, membership map)
  — keep bbox math + other filters. Geo drop counter stays.
- [ ] Rewrite affected tests (bridge fail-closed tests become fail-open +
  ignore-list tests); new perSource tests for geo-ignore/lift/purge.
- **Exit:** the #4115 scenario passes in tests (GPS-less node's NODEINFO/TEXT
  ingested; out-of-bounds node purged+ignored; in-bounds position lifts);
  suite green; PR merged.

### Phase 3 — Retroactive sweep on config change + bridge start
- [ ] Sweep service (new, small): for a bridge source with a bbox — stored
  effective position outside → geo-ignore + purge; geo-ignored entries whose
  node would now be inside (or bbox removed) → lift. No action for
  position-less nodes.
- [ ] Trigger on bridge start (replaces old seed step) and on source config
  save when `downlinkFilters.geo` changes (sourceRoutes update path).
- [ ] Log summary (`ignored N, purged N, lifted N`); expose last-sweep stats on
  bridge status.
- [ ] Tests: sweep unit tests + config-change integration + perSource.
- **Exit:** enabling/widening/narrowing bbox converges the DB without restart;
  suite green; PR merged.

### Phase 4 — Observability + docs
- [ ] Source status: per-reason drop counters (geo-ignored drops), ignore-list
  size, last sweep summary in the source UI.
- [ ] Log first-drop-per-node at info with node id (no spam after).
- [ ] Docs: README MQTT filtering section; new
  `docs/internal/dev-notes/MQTT_GEO_IGNORE.md` (behavior, reappearance rules,
  purge scope); CLAUDE.md pointer if invariants moved.
- [ ] Update this epic doc to complete; close #4115 with summary.
- **Exit:** docs merged; #4115 closed.

## Migration/upgrade behavior notes

- On upgrade, bbox'd bridge sources flip from fail-closed to fail-open:
  previously-hidden in-region nodes (e.g. `!f68f52d8`, `!49dac1a0`) appear as
  their next NODEINFO/TEXT arrives; existing `Node !xxxx` shells gain real
  names. Out-of-region nodes with stored positions are swept at first start
  after Phase 3.
- `ignored_nodes.reason` backfills `'manual'` for all existing rows.
