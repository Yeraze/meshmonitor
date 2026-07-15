# MQTT Packet Monitor — Epic Plan

**Status:** Phase 1 in progress
**Branch strategy:** one worktree + PR per phase, branched from origin/main.
**Requested:** 2026-07-15

## Goal

Enable the Packet Monitor for MQTT sources (`mqtt_broker` and `mqtt_bridge`). Unlike the
Meshtastic monitor, MQTT delivers each mesh packet once **per gateway** that heard it, and
we want to keep every copy:

- Store one row per **gateway reception** (gateway id, reception time, per-gateway RSSI/SNR,
  hop counts).
- Main packet-monitor list shows each **packet once** (deduplicated), with a gateway count.
- Clicking a packet opens a detail view listing **every gateway** that received it with that
  gateway's specifics (time, RSSI/SNR, hops).
- The main list can be **filtered by gateway** (multi-select): show only packets heard by
  the selected gateways.

## Interview decisions (2026-07-15)

1. **Two phases** — Phase 1 backend (capture + API), Phase 2 frontend UI + validation.
2. **Capture scope:** all copies reaching `ingestServiceEnvelope` — including
   encrypted-undecryptable, geo-filtered, and unsupported-portnum packets, flagged as such.
   Copies dropped by the topic/node/portnum pre-filter (before ingest) are NOT captured.
3. **Retention:** opt-in via `mqtt_packet_log_enabled`, defaults **5000 rows / 24h**
   (`mqtt_packet_log_max_count`, `mqtt_packet_log_max_age_hours`) — higher row cap than the
   other monitors because each row is one gateway reception.
4. **UI placement:** the existing Packet Monitor tab renders the new gateway-aware MQTT view
   when the active source is `mqtt_broker`/`mqtt_bridge` (that tab is permanently empty for
   MQTT sources today).

## Architecture facts (from intake exploration)

- **No upstream dedup:** every gateway copy reaches `ingestServiceEnvelope`
  (src/server/mqttIngestion.ts:119) with `envelope.gatewayId` intact. Both call sites funnel
  through it: `mqttBrokerManager.handlePublish` (:272) and `mqttBridgeManager.handleDownlink`
  (:708). Uplink does not ingest. Dedup for the list view is **query-time grouping**.
- **Hook point:** immediately after the server-side decrypt block
  (mqttIngestion.ts:129–164, `const decoded = packet.decoded` at :166) and before the
  encrypted/geo/unsupported early returns — one fire-and-forget log call sees every copy,
  with the decrypted payload when available.
- **Template stack (MeshCore monitor):** migration `075_meshcore_packet_log.ts`; repository
  packet methods in `src/db/repositories/meshcore.ts` (~1375–1510, typed Drizzle builder);
  `src/server/services/meshcorePacketLogService.ts` (15-min cleanup interval, per-source
  trim); routes in `meshcoreRoutes.ts` (~3769–3931, `requirePermission('packetmonitor', …,
  { sourceIdFrom: 'params.id' })`); frontend `MeshCorePacketMonitorView.tsx` +
  `MeshCorePacketDetailModal.tsx` + `MeshCorePacketMonitor.css`.
- **Envelope fields available:** `gatewayId`, `channelId`, packet `id/from/to/channel/
  rxTime/rxSnr/rxRssi/hopLimit/hopStart`, `encrypted`, `decoded.portnum/payload`
  (ServiceEnvelopeShape, src/server/mqttPacketFilter.ts:28–46). `relayNode` is not on the
  typed shape.
- **Settings:** keys must be added to `VALID_SETTINGS_KEYS`
  (src/server/constants/settings.ts ~93–98); global (not per-source), values are strings,
  enabled = `'1'`.
- **Permissions:** reuse the existing `packetmonitor` resource (per-source scoped).
- **Latest migration:** 119 → this epic uses **121** (120 was taken by the geo-ignore epic mid-flight).
- **MQTT source pages** render through `<App>` (src/main.tsx:86–102); tab gating in
  src/App.tsx:676–684; `packetmonitor` tab renders `PacketMonitorPanel` at App.tsx:5196.

## Phases

### Phase 1 — Backend capture + API  [ ]

Branch: `feature/mqtt-packet-monitor` (worktree `../meshmonitor-wt-mqtt-packetmon`).

Deliverables:
- Migration **121** `mqtt_packet_log` (SQLite/PG/MySQL, idempotent, indexed) — one row per
  gateway reception: sourceId, packetId, fromNode(+id), toNode(+id), channel (wire hash),
  channelId (envelope name), gatewayId, gatewayNodeNum, timestamp (server ms), rxTime,
  rxSnr, rxRssi, hopLimit, hopStart, portnum(+name, nullable), encrypted, decryptedBy,
  ingestOutcome (ingested | encrypted | geo-filtered | unsupported-portnum | decode-error),
  payloadSize, payloadPreview, createdAt.
- Drizzle schema `src/db/schema/mqttPacketLog.ts` (three dialects).
- Repository `src/db/repositories/mqttPacketLog.ts`: insert; **grouped list** (group by
  packetId+fromNode, gateway count, first/last heard, representative fields, optional
  gateway-filter `gatewayId IN (…)`, portnum/since filters, limit/offset); receptions
  detail; distinct gateways (with counts/lastHeard); count; retention (deleteOlderThan,
  per-source trim, sourceIds); clear. MySQL ONLY_FULL_GROUP_BY-safe aggregates.
- Service `src/server/services/mqttPacketLogService.ts` mirroring meshcorePacketLogService
  (enable check, defaults 5000/24h, 15-min cleanup, best-effort logPacket).
- Ingestion hook in `ingestServiceEnvelope` (fire-and-forget; records ingest outcome).
- Routes `src/server/routes/mqttPacketRoutes.ts` mounted at `/api/sources/:id/mqtt/packets`:
  GET / (grouped list, `gateways` CSV param), GET /gateways, GET /receptions
  (packetId+fromNode), DELETE / (write perm + audit). `ok`/`fail` envelope,
  `requirePermission('packetmonitor', …, { sourceIdFrom: 'params.id' })`.
- Settings keys in VALID_SETTINGS_KEYS.
- Tests: migration idempotency, repository grouping/filter + `*.perSource.test.ts`
  isolation, route harness tests (`createRouteTestApp`), ingestion-hook test.

Exit criteria: full Vitest suite green, `lint:ci` green, typecheck green, PR merged.
No user-visible change (setting defaults off).

### Phase 2 — Frontend UI + validation  [ ]

Deliverables:
- `src/components/Mqtt/MqttPacketMonitorView.tsx` (+ CSS + `MqttPacketDetailModal.tsx`),
  modeled on the MeshCore view: toolbar (pause, filter, refresh, clear, enable banner),
  deduplicated packet table (time, from, to, type, channel, gateway count, size, preview),
  **gateway multi-select filter** fed by GET /gateways, row click → detail modal with the
  packet's fields plus a per-gateway receptions table (gateway id/name, time, RSSI, SNR,
  hops). Poll ~5 s; respects `packetmonitor` permissions; settings inputs gated on
  settings:write.
- App.tsx: `packetmonitor` tab renders the MQTT view for `mqtt_broker`/`mqtt_bridge`
  sources; tab gating updated so MQTT sources see the tab when permitted.
- i18n keys (en locale).
- Browser validation via dev-container deploy + chrome-devtools.
- Docs (README/docs feature blurb) + epic plan checkbox updates.

Exit criteria: UI validated in the browser against a live MQTT source, suite/lint/CI green,
PR merged.

## Deviations / notes

- Epic tracking issue: #4124.
- Phase 1 spec: `docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md`. Implemented
  as four work packages (WP1 schema/migration/settings → WP2 repository/wiring →
  WP3 service/ingest-hook ∥ WP4 routes/mount).
- Lint ratchet: migration 121's PG/MySQL params are typed (`pg.PoolClient` /
  `mysql2/promise.Pool`) like migration 119 — the 075 template's `any` params predate the
  ratchet. The one `any` in `ActiveSchema` carries a `#4124` eslint-disable.
- `decryptedBy` is recorded as `'server'` when a copy had encrypted bytes AND a decoded
  body after ingest (server-side PSK decrypt). `ingestOutcome` maps `no-decoded`/`no-packet`
  onto `decode-error`.
- Grouped-list semantics: with a gateway filter active, `gatewayCount` counts only the
  selected gateways (filter is in the WHERE clause) — Phase 2 UI should label accordingly.
