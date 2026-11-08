# MeshCore Parity P6 — Dashboard, Mesh Issues, metrics, v1 API, embeds (#6263)

Part of the parity epic (`MESHCORE_PARITY_EPIC.md`). Base: `main` incl. P5 (#6260): `utils/meshcoreNodeNum.ts`
`nodeNumFromPubkey`, `nodeKey` identity (`mc:<pk>`/`mt:<n>`), `MeshCoreHopSnrRepository.getResolvedLinks` /
`getLatestInitiatedTraceFor`, `GET /api/sources/:id/meshcore/hop-snr/latest-trace`, `components/map/RouteFlowMap.tsx`.
Paths relative to `src/`.

## Maintainer decisions (2026-11-08, binding)
1. **One implementation**: protocol adapters inside the shared widget / rule engine / collector / v1 handler. No MeshCore copies.
2. **v1 TX limits = Meshtastic's**: `messageLimiter` + v1 API limiter + existing MeshCore caps (`meshcoreDeviceLimiter`,
   60 s per-source mesh-TX gate, `requireMeshcoreTx`). No new caps. API docs carry an airtime warning on POST /messages.
3. **v1 identity**: MeshCore rows use `nodeId = mc:<publicKey>`, carry `publicKey` + synthetic `nodeNum`; EVERY v1 row gains
   additive `protocol: 'meshtastic' | 'meshcore'`. `/messages/search` keeps its `source` field (adds `protocol`).
4. **v1 trace on MeshCore: fire-and-forget** — sync pre-check (Companion device, contact known → 409
   `MESHCORE_TRACE_FAILED`), then async; 200 `{destination, channel:null, message, protocol}`; result appears in `/traceroutes`.
5. **New `actions/request-telemetry` for both protocols**, one handler, gated on `messages:write`.
6. **Mesh Issues on MeshCore**: A4 (mobile infra), A3 (uptime-reset clause only), C2 advert cadence — flag a repeater whose
   median flood-advert interval < 6 h or zero-hop interval < 60 min. Stale / no-position / low-battery / bad-position rules
   (protocol-neutral) → follow-up issue.
7. **Prometheus**: new `meshmonitor_packets_by_payload_type_last_hour{source,payload_type,payload_type_name}` (separate from
   portnum); MeshCore battery only as `node_voltage_volts`; per-node MeshCore series gated on `nodes:read`.
8. **Embed**: MeshCore neighbour links under existing `showNeighborInfo`, trace paths under `showTraceroutes`; no new fields,
   no migration.

## Mesh impact
LoRa ToA (8-sym preamble, explicit header, CRC): US narrow SF7/BW62.5/CR4:5 — 20 B 113 ms, 40 B 164 ms, 100 B 349 ms,
140 B 461 ms, 184 B 594 ms. EU narrow SF8/BW62.5/CR4:8 — 280 / 443 / 935 / 1263 / 1623 ms.
- POST /messages channel (flood, ~140 B): (1+R)·ToA → R=10 ≈ 5.1 s US / 13.9 s EU. DM known path h=3 ≈ 2.3 s / 6.2 s;
  unknown path floods.
- actions/traceroute (~20–25 B direct): (h+1)·113 ms ≈ 0.45 s US / 1.1 s EU at h=3. Capped 10/min (`meshcoreDeviceLimiter`).
- actions/request-telemetry MeshCore (~40 B req + ~60 B resp): ≈ 1.6 s / 4.2 s at h=3; 60 s per-source gate → ≤1/min/source.
- Worst case messageLimiter 30/min/IP channel sends at R=10 ≈ 152 s airtime/min (US) — same bucket as the UI; docs warn.
- Spam: v1 sends use `autoRetryOnMiss=false`; own-send rows re-enter the bus — WP4 verifies the MeshCore auto-responder /
  automation self-origin guard ignores them; `request-telemetry` stamps `recordMeshTx` before sending.
- No safety timers; no settings saved. Dashboard, Mesh Issues, metrics, embeds are passive (DB reads only).

## Shared pieces
| ID | Piece | Used by |
|---|---|---|
| S1 | `server/services/meshcoreNodeView.ts` `loadMeshCoreNodesForViewer(sourceId, access, {positions})` = `meshcore.getNodesBySource` + `applyMeshCorePositionOverridesForViewer` + viewOnMap mask + `applySignFlipToMeshCoreRows`; DB-backed (works disconnected). Move `maskContactPositionsForViewOnMap` (`routes/meshcoreRouteShared.ts:298`) to `server/utils/`, re-export. | v1 nodes/topology, metrics |
| S2 | `server/utils/protocolRows.ts` pure mappers `meshcoreNodeToV1`, `meshcoreMessageToV1`, `meshcoreTraceToV1`, `meshcorePacketToV1` (protocol, nodeKey, publicKey, synthetic nodeNum); Meshtastic rows gain `protocol:'meshtastic'`. | v1, metrics |
| S3 | `server/utils/transmitTarget.ts` `resolveTransmitTarget(sourceId)` → meshtastic / meshcore / refusal; generalises `checkMeshtasticDeviceSource` (`requireMeshtasticDeviceSource.ts:39-67`); refusals keep 400 `SOURCE_NOT_MESHTASTIC` / 409 `SOURCE_NOT_CONNECTED`; `meshcore_mqtt`, MQTT, Reticulum stay refused. | v1 POST /messages, actions |
| S4 | `server/routes/v1/metricsCollectors.ts` `SourceMetricsCollector` (Meshtastic + MeshCore); gauges defined once in `metrics.ts`. | metrics |
| S5 | Mesh Issues `PooledNode` + `protocol`, `nodeKey`, `infra`, `subjectKeyFor(node)`; rules declare `protocols`; MeshCore snapshot adapter. | Mesh Issues |
| S6 | `DashboardDataSource.widgets {supported, voltageFallback}` replaces `showCustomWidgets`; `useWidgetTrace(kind, …)` normalised trace for TracerouteWidget. | Dashboard |
| S7 | `GET /api/packets/stats/node-activity` stays one endpoint, dispatches by source type. | Live Mesh Activity |
| S8 | Embed wire: additive `fromKey/toKey`, `nodeKey/neighborKey`; `EmbedMap` keys segments on `fromKey ?? fromNum`. | Embed |

Joins always on nodeKey/publicKey, never the synthetic number. (`sourceDashboardData.ts:147` mints internal
`mc:<sourceId>:<pk12>` — leave it.)

## Findings (evidence)
- **Dashboard**: `dataSources.ts:174` `showCustomWidgets:false` hides the button (`Dashboard.tsx:250-253`); widgets save per
  source (`useCustomWidgets.ts:34-42`); widgets pure over `NodeInfo` (`DashboardGrid.tsx:133-207`). Hop distribution reads
  `hopsAway` (`HopDistributionWidget.tsx:48-60`) — MeshCore has `pathLen`. Distance/heatmap need `currentNodeId`
  (`useHomeNode.ts`; `MeshCoreTelemetryView.tsx:25-31` passes none; `MeshCorePage.tsx:155` has `status.localNode.publicKey`).
  NodeStatus falls back to Meshtastic-only `/api/telemetry/:nodeId` (`NodeStatusWidget.tsx:91-99`). **Latent bug**: MeshCore
  adapter passes `nodeNum:0` and `lastHeard` in ms (`dataSources.ts:146,153`) while widgets expect seconds. TracerouteWidget
  uses `useTraceroutes()` (`:112`) + `parseRoute` (`:182`). Live activity reads `packet_log` only (`packetRoutes.ts:282-336`).
- **Mesh Issues**: MeshCore excluded (`meshIssuesAnalysisService.ts:238-245`). Real rules in `types.ts:14-37` (A1, A2a/b, A3,
  A4, A5, Tier B, C1/C2). Role gates on Meshtastic numbers (`rules.ts:357` `INFRA_ROLES`, A1 `:82`, A5 `:397`). Snapshot keyed by
  nodeNum (`nodeSnapshot.ts:185-196`); `subjectKey` text, `nodeNum` nullable (`schema/meshIssues.ts:44-47`) → no migration.
  `NodeLink.tsx:35-37` nodeNum only.
- **Metrics**: loop `metrics.ts:206-292` Meshtastic tables only (`:214,:222,:232,:246`); per-node visibility by channel (`:257`);
  guards reusable: window (`:47-50`), `MAX_NODE_SERIES_PER_SOURCE=1000` (`:67`).
- **v1 read**: mounts `v1/index.ts:95-133` scope per source. Meshtastic-only: `nodes.ts:62-64,130`, `packets.ts:56-66`,
  `traceroutes.ts:42`, `network.ts:22-50,102-145`, `messages.ts:84-93,189`. `/channels` already returns MeshCore channels but
  non-admin filter `channels.ts:44` uses `channel_<id>:read` only → MeshCore idx>7 vanish; MeshCore rule
  `canAccessMeshcoreChannel` falls back to `messages`. Precedent: `/messages/search` (`messageSearch.ts:141-165`).
- **v1 TX**: `messages.ts:254` `messageLimiter` then refuses `:357`; `actions.ts:82,123,187,250` refuse at `:91,132,196,259`.
  MeshCore UI: send `meshcoreMessagingRoutes.ts:443`; trace `meshcoreContactsRoutes.ts:612-656`; telemetry `:1184-1256`.
  Meshtastic telemetry request internal only (`meshRequestRoutes.ts:301`).
- **Embed**: header says Meshtastic-only (`embedPublicRoutes.ts:8`); `visibleEmbedMeshCoreNodes` (`:198-246`) is the leak
  boundary; neighborinfo `:377-423`, traceroutes `:426-526` keyed by nodeNum; `EmbedMap.tsx:75-87,307,327` keys
  `${leg}:${fromNum}-${toNum}` (num 0 would collide → S8).

## Not feasible / out of scope
MeshCore battery %, chUtil/airUtil gauges; v1 `request-position` / `request-nodeinfo` / `request-neighbors` on MeshCore → 400
`UNSUPPORTED_FOR_PROTOCOL`; long-message splitting (413) and `replyId` (400) on MeshCore; copy-nodeinfo/enrichment; Mesh Issues
A1, A2a/b, A5, Tier B, C1 on MeshCore; the four protocol-neutral rules (follow-up); embed cross-protocol links and MeshCore
return leg; `/channels` for `meshcore_mqtt` → `[]`.

## Design
### Repositories (Drizzle, all backends)
- `meshcore.ts`: `countNodesBySource`, `countActiveNodesBySource(sourceId, sinceMs)`, `getNodesHeardSince(sourceId, sinceMs,
  limit)` (lastHeard desc), `countMessagesSince(sourceId, sinceMs)`, `listMessages({scopes, since, limit, channelIdx?,
  fromPublicKey?, toPublicKey?})` sharing the scope/key-access WHERE builder with `searchMessages`.
- `meshcorePacketLog.ts`: `getPacketCountsByPayloadTypeSince` (receptions), `getNodeActivity({sourceId, since})` grouped on
  `senderPubKey` else `srcHash`, `getOldestTimestamp`, `getDirectHeardStats(sourceId, sinceMs)` from hopCount=0 rows.
- `meshcoreHopSnr.ts`: `getInitiatedTraces(sourceId, sinceMs, limitTraces)` grouped by traceTag, sharing the grouping helper
  with `getLatestInitiatedTraceFor`.

### Dashboard (S6, S7)
MeshCore adapter: `nodeNum: nodeNumFromPubkey(pk)`, `hopsAway: pathLen`, `deviceMetrics {voltage: batteryMv/1000,
uptimeSeconds}`, `lastHeard` in seconds. `widgets.supported` = all six for MeshCore, none for Reticulum; MeshCore
`voltageFallback:false`; `AddWidgetModal` filters to supported. `MeshCoreTelemetryView` gets `currentNodeId` from MeshCorePage.
`useWidgetTrace`: Meshtastic wraps `useTraceroutes`+`parseRoute`; MeshCore wraps P5 latest-trace; both render via
`RouteFlowMap`. Node-activity on MeshCore: resolve `srcHash` only when exactly one node on the source has the prefix;
unresolved counted in new `unresolvedPackets`; local node excluded; transport rf/all same; `enabled` from
`meshcorePacketLogService.isEnabled()`; rows gain `nodeKey`, `publicKey`. Client `nodeIdOf` prefers `nodeKey`.

### Mesh Issues (S5)
`meshIssues/meshcoreSnapshot.ts` pools MeshCore nodes across enabled `meshcore`/`meshcore_mqtt` sources by lowercased pk;
`infra` = advType ∈ {2,3} (Meshtastic `infra` = `INFRA_ROLES`). A3/A4 read `node.infra`; A1, A2a/b, A5, Tier B, C1 declare
`protocols:['meshtastic']`. Findings: subjectKey `mc:<pk>`, `nodeNum` null, evidence `publicKey`, `nodeName`, `sourceIds`.
Inputs: A4 `positionSpanKm` over `meshcore_position_history`; A3 uptime decreasing in status telemetry (voltage clause
deferred); C2 median ADVERT interval per repeater from the packet log vs decision 6 thresholds — skipped with a coverage skip
reason when logging is off. `NodeLink` gains `publicKey + sourceIds` mode → MeshCore contact deep-link.

### Metrics (S4)
Per-source `nodes_total`, `nodes_active` (2 h), `messages_last_hour` (needs `messages:read`); new payload-type metric
(`packetmonitor:read`, ≤16 series/source). Per-node from `getNodesHeardSince(window, MAX_NODE_SERIES_PER_SOURCE)`: labels
`node_id=mc:<pk>`, `short_name=name.slice(0,4)`; gauges `snr`, `rssi`, `last_heard` (s), `hops_away` (pathLen),
`voltage_volts`; gated `nodes:read`; never positions.

### v1 read (S1, S2)
Branch on `isAnyMeshCoreSourceType(req.source.type)`; envelopes/keys unchanged, fields additive.
- nodes, nodes/:nodeId (`mc:<pk>` or bare 64-hex); honour `active`, `sinceDays`; positions per `nodes:viewOnMap`, private
  override needs `nodes_private:read`.
- channels: MeshCore filter `canAccessMeshcoreChannel(read)`, PSK on write.
- packets: shared `listMeshCorePacketsForViewer` extracted from `meshcorePacketRoutes.ts:123` with per-viewer plaintext
  (`decodeGroupPacketForViewer`); `payload_type`, `route_type`, `since`, `limit`, `offset`; Meshtastic-only filters → 400
  `UNSUPPORTED_FILTER`.
- traceroutes: `route` JSON of synthetic nums (unresolved 4294967295), `snrTowards` snr×4, `routeBack`/`snrBack` null, plus
  `hops[{index, publicKey|null, hash, snr}]`.
- network: stats, topology (S1 nodes + trace edges), direct-neighbors (`getDirectHeardStats`, entries carry `nodeKey`).
- messages, messages/:id: `resolveReadableMeshcoreScope`; DMs/rooms `channel` -1 with `messageType`; broadcast `toNodeId`
  `!ffffffff`.

### v1 TX (S3)
- POST /messages MeshCore: `channel` (0–255) XOR `toNodeId` (`mc:<pk>`/64-hex), optional `scope` (≤63); byte limits
  `VALIDATION.MAX_MESSAGE_BYTES_*` → 413; DM needs `messages:write`, channel needs `canAccessMeshcoreChannel(write)`;
  TX disabled → 409 `TX_DISABLED` (`failIfTxDisabled`); not connected → 503; 201 same keys as Meshtastic (`messageId` row id
  or null, `requestId:null`, `deliveryState:'pending'`, `messageCount:1`, `protocol`).
- `protocolLimiter({meshcore: meshcoreDeviceLimiter})` after `attachSource`, same limiter instances (bucket shared with UI).
- actions/traceroute MeshCore: decision 4.
- actions/request-telemetry (decision 5): Meshtastic → logic extracted from `meshRequestRoutes.ts:301`, `type` =
  device/environment/airQuality/power; MeshCore → `pollMeshCoreNodeTelemetry` extracted from
  `meshcoreContactsRoutes.ts:1203-1249`, `type` = status/lpp, 429 + `Retry-After` inside the 60 s gate; UI route refactored
  onto it.

### Embed (S8)
neighborinfo (under `showNeighborInfo`): add `meshcore.getNeighbors` edges where both ends ∈ `visibleEmbedMeshCoreNodes`,
dedup pk pair, `nodeNum`/`neighborNodeNum` 0, `nodeKey`/`neighborKey` set. traceroutes (under `showTraceroutes`):
`getResolvedLinks` last 24 h, same endpoint gate, `leg:'forward'`, `isMqtt:false`, `avgSnr = snr`, `fromKey/toKey`, shares
`MAX_EMBED_TR_SEGMENTS`. Update header comment.

## Work packages — WP1 → (WP2 ∥ WP3 ∥ WP4 ∥ WP5 ∥ WP7); WP6 after WP1 repos; WP8 last
Every WP: typecheck, lint ratchet, `.js` server imports, `ok()/fail()` for new handlers (v1 shapes unchanged), CSS modules +
`var(--color-*)`, `UiIcon`, flat `en.json`. PG/MySQL up for repo work.

- **WP1 Foundations**: repos above, `meshcoreNodeView.ts`, `protocolRows.ts`, `transmitTarget.ts`, moved mask helper. Tests:
  multi-backend isolated (counts, heard-since order/limit, countMessagesSince, listMessages key-access parity with search,
  payload-type counts, getNodeActivity, getInitiatedTraces grouping, getDirectHeardStats — all source-scoped); units for
  mappers (ms→s, snr×4, sentinel) and transmitTarget matrix.
- **WP2 Metrics**: `v1/metrics.ts`, `v1/metricsCollectors.ts`. Tests (`metrics.meshcore.test.ts`, harness): MeshCore totals and
  active nonzero; payload-type series; per-node labels; window + cap; no `messages:read` → no volume; unpermitted source
  absent; Meshtastic output byte-identical.
- **WP3 v1 read**: `v1/{nodes,channels,packets,traceroutes,network,messages}.ts`, `v1/openapi.yaml`, `docs/public/openapi.yaml`.
  Tests (harness): each endpoint returns `protocol` rows on MeshCore; viewOnMap masking; private override hidden; channel
  idx>7 visible with `messages:read`; unsupported filter 400; plaintext withheld without grant; Meshtastic responses only gain
  `protocol`; `default` alias resolves.
- **WP4 v1 TX**: `v1/messages.ts`, `v1/actions.ts`, `meshRequestRoutes.ts` + `meshcoreContactsRoutes.ts` extractions,
  `rateLimiters.ts` (`protocolLimiter`), `meshcoreRoutes.scope.test.ts`, v1 gate tests. Tests (harness, mocked managers):
  DM/channel permission matrix; 413; 409 TX_DISABLED; 503; `meshcore_mqtt` → 400; shared limiter bucket; trace pre-check 409
  then async 200; telemetry 429 + Retry-After; Meshtastic telemetry works; unsupported actions 400; self-origin (v1 send does
  not trigger MeshCore auto-responder).
- **WP5 Dashboard**: `Dashboard/dataSources.ts`, `Dashboard.tsx`, `AddWidgetModal.tsx`, `TracerouteWidget.tsx`,
  `hooks/useWidgetTrace.ts`, `NodeStatusWidget.tsx`, `LiveMeshActivityWidget.tsx`, `MeshCore/MeshCoreTelemetryView.tsx`,
  `MeshCore/MeshCorePage.tsx`, `server/routes/packetRoutes.ts`, `services/packetApi.ts`, `en.json`. Tests: adapter mapping,
  modal filtering, widgets render MeshCore NodeInfo, trace hook both protocols, node-activity dispatch / disabled / local
  excluded / ambiguous hash; Meshtastic widget tests green.
- **WP6 Mesh Issues**: `meshIssues/{nodeSnapshot,rules,rulesTierC,types,meshcoreSnapshot}.ts`,
  `meshIssuesAnalysisService.ts`, `components/Analysis/meshIssues/NodeLink.tsx` (+ callers), `en.json`,
  `docs/features/mesh-issues.md`. Tests: `mc:` repeater fires A4, A3-resets, C2; companion does not; A1/A5/Tier B never see
  MeshCore; service run persists subjectKey with `nodeNum` null and route intersects `sourceIds`; Meshtastic suites unchanged.
- **WP7 Embed**: `embedPublicRoutes.ts`, `EmbedMap.tsx`. Tests (harness): links only when both ends visible; private-override
  node never a line end; toggle off → 404; two MeshCore segments don't collide; cap holds; legacy Meshtastic shape unchanged.
- **WP8 Docs + epic**: `docs/api/{API,REST_API}.md` (MeshCore rows; airtime warning on POST /messages),
  `docs/features/embed-maps.md`, Prometheus section, epic log.

## Browser / API check
Throwaway volume, seeded MeshCore nodes / packet log / hop_snr. API via token: `/api/v1/sources/<mc>/{nodes,channels,packets,
traceroutes,network,network/topology,messages}` → `protocol` rows; Meshtastic unchanged. `curl /api/v1/metrics | grep <mc>`.
TX without RF: POST /messages TX-disabled → 409; `meshcore_mqtt` → 400; `request-position` → 400; 31st POST/min → 429.
Browser: MeshCore Telemetry view Add Widget lists six; hop/distance/node-status render; traceroute widget on RouteFlowMap; live
activity disabled notice then rows. Embed: MeshCore neighbour + trace lines; private override removes them. Mesh Issues
run-now: moving repeater → A4; link opens MeshCore contact.
