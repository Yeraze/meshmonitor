# MeshCore Parity P4 (#6262) Spec: Packet Monitor and contact graphs

**Mesh impact: none.** All new endpoints are GET reads. The only write-path change is a pure derivation in `meshcorePacketLogService.logPacket` (three extra columns, no TX). Link quality is replayed on read: no new manager state, timers or notifications. Client side: a debounced refresh and a pop-out poll fallback, both HTTP only.

## Decisions (2026-11-08)
- **Q1 [maintainer]: Signal Trend for MeshCore uses our DM reception.** Use `meshcore_messages.snr` / `rssi` of DMs we received from that contact (Meshtastic semantics: how well we hear them), plus the `mc_status_noise_floor` telemetry for noise where it has been polled. It is a read-side adapter in the same `/signal-trend` endpoint.
- **Q2 [maintainer]: Free-text search covers** advert name, payload type name, raw hex and sender key. **Channel plaintext is NOT searchable**: it is decrypted per viewer and not stored, and per-viewer gating stays intact.
- **Q3 [orchestrator]: No backfill** of the derived columns. Retention is 24 h by default and at most 720 h, so the gap closes within the retention window.
- **Q4 [orchestrator]: `meshcore_mqtt` distribution counts receptions (rows)**, matching the flat list.
- **Contact graphs use a read-side adapter, not new telemetry writers.** Reasons: no new write path or in-memory per-contact state in the two MeshCore managers; history is available at once; no duplicate rows to retain or purge. Both protocols share one endpoint, hook, component, windowing function and scoring function; only the sample source differs, behind `isMeshCorePubKey(nodeId)` (`/^[0-9a-f]{64}$/i`). `outPathLen` is not a series, so it is not used.

## 1. Reuse inventory (one implementation per feature)
| Feature | Shared piece | Meshtastic | MeshCore | New / why |
|---|---|---|---|---|
| Paged fetch + cache | New `hooks/usePagedPackets.ts`, generalised from `usePackets.ts`, which becomes a thin wrapper. Holds TanStack `useInfiniteQuery`, id de-dup, `hasMore`/`loadMore`, rate-limit handling and polling. Paging can be offset or keyset. | `usePackets` wrapper (offset, 5 s poll, own-echo filter) | New `useMeshCorePackets`: flat = keyset (repo already has `untilTs`/`untilId`), grouped = offset; live socket rows prepended; no poll when a socket is present | Refactor; the Meshtastic hook hard-codes `getPackets`/`PacketLog` |
| Virtualized list + load-more | New `hooks/useInfiniteVirtualRows.ts`, extracted from `PacketMonitorPanel.tsx:216-242` | PacketMonitorPanel, UnifiedPacketMonitorPage | MeshCorePacketMonitorView | extraction |
| Search box | New `components/packets/PacketSearchInput.tsx` (debounced), from `PacketMonitorPanel` 85-98 and 545-553 | Panel | MeshCore | extraction |
| Time window | New `components/packets/TimeWindowSelect.tsx` (1h/6h/24h/7d/all → `since` ms) | added to Panel (`PacketFilters.since` already server-side) | MeshCore | shared |
| Node/contact filter | Existing `common/SearchableSelect` | from_node / relay | sender pubkey (options from contacts) | — |
| Pop-out | `pages/PacketMonitorPage.tsx` gains `?sourceId=` dispatch. New `utils/packetMonitorPopout.ts` `openPacketMonitorPopout(sourceId?)` | no param, unchanged | `?sourceId=<mc>` → SourceProvider + WebSocketProvider + MeshCorePacketMonitorView `standalone` | — |
| Click resolved node | Same `onNodeClick(id)` contract | nodeId | publicKey (MeshCorePage → DM/contact; ingest → Nodes view) | — |
| Hash → contact | Existing `utils/meshcorePath.ts` `resolveHop` | — | src hash / path hops | — |
| Wire derivation | Existing `utils/meshcorePacketDecode.ts` `decodeMeshCorePacket`; new thin `utils/meshcorePacketDerived.ts` `deriveMeshCorePacketFields(rawHex)`, used by the server insert, the client live matcher and row rendering | — | — | MeshCore-only (no Meshtastic wire equivalent); one function, three callers |
| SQL LIKE | New `db/repositories/likeSearch.ts` `likeContains(cols, term, isPostgres)`, extracted from `packetLog.ts:155-163` (`~` escape, PG ILIKE) | packetLog refactored onto it | meshcore repo | extraction |
| Distribution charts | Existing `PacketStatsChart` + `DISTRIBUTION_COLORS`; new `toChartEntries()` in `packetStatsChartData.ts` | Unified page | MeshCore monitor stats strip | — |
| Unified distribution | Existing `/api/unified/packets/distribution` merge loop | portnum / nodeNum | payloadType / pubkey, protocol-tagged | — |
| Unified filters | Existing `/api/unified/packets` + `meshcoreEligible` | portnum etc. exclude MeshCore (unchanged) | `payload_type` / `route_type` exclude Meshtastic (mirror rule) | — |
| Smart Hops | Existing `SmartHopsGraphs` / `useSmartHops` / `GET /api/telemetry/:nodeId/smarthops`; rolling-window math → `server/utils/hopStats.ts` `computeRollingHopStats` | telemetry `messageHops` samples | `meshcore_messages.hopCount` samples | — |
| Link Quality | Existing `LinkQualityGraph` / `useLinkQuality` / `.../linkquality`; scoring → `server/utils/linkQuality.ts` (`LINK_QUALITY`, `initialLinkQuality`, `nextLinkQuality`, `replayLinkQuality`), also used by `meshtasticManager` | stored rows (stateful; traceroute penalties stay) | `replayLinkQuality(hopSamples)` on read | — |
| Signal Trend | Existing `computeSignalTrend` + `/signal-trend`; badge extracted from `NodeDetailsBlock.tsx` 141-166 / 484-502 → `components/SignalTrendBadge.tsx` | `rssi` / `snr_local` / `noiseFloor` | Q1 adapter: DM `snr`/`rssi` from `meshcore_messages` + `mc_status_noise_floor` | extraction |

## 2. Changes

### 2a. Migration 224 (use the `/migration` skill; WP1 owns `src/db/migrations.ts`)
`src/server/migrations/224_meshcore_packet_log_derived_fields.ts`, idempotent on all three backends (158 recipe).
- `meshcore_packet_log` + columns: `srcHash` (TEXT / MySQL VARCHAR(8)), `senderPubKey` (TEXT / VARCHAR(64)), `advertName` (TEXT / VARCHAR(128)). The table's camelCase names are kept on every backend (075/158).
- Indexes `idx_mcpl_source_src (sourceId, srcHash)` and `idx_mcpl_source_sender (sourceId, senderPubKey)`. Paging and `since` already use `idx_mcpl_source_ts`.
- `meshcore_messages` index `idx_meshcore_messages_source_from_ts (sourceId, fromPublicKey, timestamp)` (MySQL TEXT → prefix `(64)`).
- No backfill. Backup classification unchanged (no new table).
- Schema `db/schema/meshcorePacketLog.ts`: 3 columns × 3 dialects. `DbMeshCorePacket` gets the optional fields.

### 2b. Shared utilities
- `utils/meshcorePacketDerived.ts`: `deriveMeshCorePacketFields(rawHex): { srcHash; senderPubKey; advertName }` (lowercase hex, never throws).
  - ADVERT → `senderPubKey` = advert pubkey, `srcHash` = its first byte, `advertName` = advert name.
  - Generic dest|src types → `srcHash` = decoded src byte.
  - ANON_REQ → `senderPubKey` if the decoder exposes it (check against `decodeMeshCorePacket`).
  - GRP_TXT / GRP_DATA / ACK / TRACE → nulls.
- `db/repositories/likeSearch.ts`: `likeContains(columns: SQL[], term, isPostgres): SQL`. Refactor packetLog onto it with no behaviour change.
- `server/utils/hopStats.ts`: `computeRollingHopStats(samples {timestamp,value}[], sinceTs, intervalMinutes, now) → {timestamp,minHops,maxHops,avgHops}[]`, moved from `telemetry.ts getSmartHopsStats` (~1432-1495); that method calls it.
- `server/utils/linkQuality.ts`: `LINK_QUALITY` moves here (re-exported from `meshtasticManager.ts`), plus `initialLinkQuality(hops)`, `nextLinkQuality(state,hops)` and `replayLinkQuality(samples, emitFrom)`. `meshtasticManager.getNodeLinkQuality` / `updateLinkQualityForMessage` delegate with NO behaviour change.
- `server/services/signalTrend.ts`: per Q1, `signalTrendSamplesFor(nodeId, sourceId, since)`:
  - Meshtastic ids → existing telemetry types.
  - MeshCore pubkeys → DM receptions from `meshcore_messages` (`snr` → `snr_local`, `rssi` → `rssi`) plus `mc_status_noise_floor` telemetry → `noiseFloor` (verify strings at `meshcoreRemoteTelemetryScheduler.ts:329-367`).
  - Then `computeSignalTrend`.

### 2c. Repository `db/repositories/meshcore.ts` (Drizzle; all backends)
- `MeshCorePacketQuery` + `search?`, `srcHash?`, `senderPubKey?` (prefix), `pathHash?`.
- `buildPacketConditions`:
  - `srcHash`: `eq(srcHash,h) OR senderPubKey LIKE 'h%'`
  - `senderPubKey`: `LIKE 'p%'`
  - `pathHash`: `pathHops = h OR LIKE 'h,%' OR LIKE '%,h' OR LIKE '%,h,%'`
  - `search`: `likeContains([advertName, payloadTypeName], q)`, OR `rawHex LIKE %q%` (when q is hex ≥2 chars), OR `senderPubKey LIKE q%` (hex)
  - All are already sourceId-scoped.
- `getPacketCountsByPayloadType(q)`, `getPacketCountsByRouteType(q)`.
- `getTopSenders(q, limit=10)`: `payloadType = 4`, `senderPubKey IS NOT NULL`, `MAX(advertName)`, group by sender, count desc.
- `getContactHopSamples(sourceId, publicKey, since, limit=50000)`: `meshcore_messages` with `hopCount IS NOT NULL`, ms timestamps, ascending; throws without `sourceId`.
- `getContactSignalSamples(sourceId, publicKey, since)`: DM `snr` / `rssi` (Q1); throws without `sourceId`.

### 2d. Services
- `meshcorePacketLogService.logPacket`: `{...packet, ...deriveMeshCorePacketFields(packet.rawHex)}` before insert. Both managers already call it, so this is the only write change.
- `getDistribution(q) → { byPayloadType, byRouteType, topSenders, total }`: four repo calls in parallel.
- New `services/contactLinkStats.ts`: `getSmartHopsSeries` / `getLinkQualitySeries`. Pubkey ids → hop samples from `since − 24h` → `computeRollingHopStats` / `replayLinkQuality(samples, since)`. Otherwise delegate to the existing Meshtastic methods.

### 2e. Routes
- **`meshcorePacketRoutes.ts`**:
  - One `parseMeshCorePacketFilters(query)` for all handlers. Params: `payload_type`, `route_type`, `since` (s or ms), `search`, `src_hash`, `sender` (alias `advert_pubkey`), `path_hash`.
  - 400 when: hash not `/^[0-9a-f]{2,6}$/i` of even length; sender not `/^[0-9a-f]{2,64}$/i`; search longer than 100 characters.
  - `GET /packets`: `cursor=ts_id` → `untilTs`/`untilId`; response adds `hasMore` and `nextCursor`; envelope otherwise unchanged; limit still clamped to 1000.
  - `GET /packets/grouped`: offset paging plus the new filters. `GET /packets/export`: honours the filters.
  - New `GET /packets/stats/distribution` → `{ byPayloadType, byRouteType, topSenders, total, enabled }`.
  - Guard unchanged: `optionalAuth(), requirePermission('packetmonitor','read',{ sourceIdFrom:'params.id' })`.
- **`unifiedRoutes.ts`**:
  - `/packets` (~1098): parse `payload_type` / `route_type`; `meshtasticEligible = both undefined`; non-MeshCore sources return empty when not eligible; pass both filters to MeshCore; `meshcoreEligible` stays.
  - `/packets/distribution` (~1293): MeshCore → `getDistribution`.
    - `typeMap` keyed `mt:<portnum>` / `mc:<payloadType>`; MeshCore entries `{portnum: payloadType, portnum_name: 'MeshCore ' + name, protocol: 'meshcore'}`.
    - `deviceMap` keyed `mt:<num>` / `mc:<pubkey>`; MeshCore entries `{from_node: 0, from_node_id: null, from_node_longName: advertName, publicKey, protocol: 'meshcore'}`.
    - Totals from the byType sum; drop the `meshcoreCount` special case. Per-source permission gating unchanged.
- **`telemetryRoutes.ts`**:
  - `smarthops` / `linkquality` → `contactLinkStats.*`. Both must call `checkNodeChannelAccess(nodeId, req.user, sourceId)` like `signal-trend` (add it if missing); for a pubkey this enforces `nodes:viewOnMap` on that source.
  - `signal-trend` → the Q1 samples adapter.
  - `requireSourceId('query')` unchanged.

### 2f. Frontend
- `hooks/usePagedPackets.ts` (generic):
  - Input: `{ queryKey, filters, canView, pageSize, fetchPage(pageParam,pageSize,filters) → {packets,total,nextCursor?,hasMore?}, paging: 'offset'|'cursor', pollIntervalMs? }`.
  - Returns `{ packets, total, loading, loadingMore, hasMore, loadMore, refresh, prependLive, rateLimitError }`.
  - `usePackets.ts` becomes a wrapper with an unchanged public API (`getPacketsQueryKey`, `isOwnPacketEcho`, `PACKETS_QUERY_KEY`, result shape).
- `hooks/useMeshCorePackets.ts`:
  - Flat → `/meshcore/packets` with a cursor; grouped → `/packets/grouped` with offset.
  - Socket `meshcore:ota-packet`: in flat mode with only payload/route/srcHash/pathHash filters, `prependLive` after a client match via `deriveMeshCorePacketFields`; with search/sender filters or grouped mode, a 1 s debounced `refresh`.
  - With no socket (pop-out): 5 s poll.
- `hooks/useInfiniteVirtualRows.ts`: `({count, hasMore, loadingMore, loadMore, estimateSize, getScrollElement}) → rowVirtualizer`.
- `components/packets/{PacketSearchInput,TimeWindowSelect}.tsx`, `utils/packetMonitorPopout.ts`.
- `pages/PacketMonitorPage.tsx`: `?sourceId=` naming a MeshCore source (via `useDashboardSources`) → `<SourceProvider><WebSocketProvider><MeshCorePacketMonitorView standalone/>`, with contacts read-only from the `useMeshCore` endpoint. Otherwise unchanged.
- `PacketMonitorPanel.tsx`: adopt `useInfiniteVirtualRows`, `PacketSearchInput`, `TimeWindowSelect` (`filters.since`) and `openPacketMonitorPopout()`. No other change.
- `MeshCorePacketMonitorView.tsx`:
  - `useMeshCorePackets` + virtualized table, replacing the `MAX_BUFFER` table.
  - Filter bar: search, time window, payload, route, sender (`SearchableSelect` over contacts), src hash, path hash, clear.
  - New "From" column: advert name or `resolveHop(srcHash)`; a button calling `onNodeClick(pubkey)` when it resolves to exactly one contact.
  - Stats toggle: 3 × `PacketStatsChart bare stacked` from `/packets/stats/distribution` with the same `since`.
  - Pop-out button; props `standalone?`, `onNodeClick?`; count shows `total`; retention and capture controls unchanged.
- `MeshCorePage` / `MeshCoreIngestView`: pass `onNodeClick` (device → DM/contact; ingest → Nodes view).
- `packetStatsChartData.ts`: `toChartEntries<T>(rows, name, value, color?)`.
- `UnifiedPacketMonitorPage.tsx`:
  - Adopt `useInfiniteVirtualRows`.
  - MeshCore Payload/Route selects (`MESHCORE_PAYLOAD_TYPES` / `MESHCORE_ROUTE_TYPES`) when any readable source is MeshCore, with a mutual-exclusion hint.
  - Entries with `protocol === 'meshcore'` use `DISTRIBUTION_COLORS[i]`.
- `types/packet.ts`:
  - `UnifiedPacketFilters` + `payload_type?`, `route_type?`.
  - `PacketCountByType` / `PacketCountByDevice` + `protocol?`, `publicKey?`.
  - New `MeshCorePacketDistribution`.
- `services/packetApi.ts`: pass the new filters.
- `components/SignalTrendBadge.tsx` `{nodeId, sourceId?}`: extracted from NodeDetailsBlock, which then renders it.
- `SmartHopsGraphs` / `LinkQualityGraph` / `useSmartHops` / `useLinkQuality`: optional `sourceId?` (wins over `useResolvedSourceId`) and `allowFavorite?` (default true; MeshCore passes false).
- `MeshCoreContactDetailPanel.tsx`: collapsible "Link history" with lazy `SmartHopsGraphs`, `LinkQualityGraph` and `SignalTrendBadge` for `publicKey` (`telemetryHours` from settings, else 24).
- English i18n for all new labels.

## 3. Tests (Vitest)
- **Repo:**
  - `meshcore.packetFilters.multiBackend.test.ts` (search, srcHash, sender prefix, pathHash, keyset cursor, distribution; SQLite / PG / MySQL via `createIsolated*Database`).
  - `meshcore.packetFilters.perSource.test.ts`, `meshcore.contactHopSamples.perSource.test.ts`.
  - `likeSearch.test.ts` (`%` `_` `~` escaping); packetLog search tests still green.
- **Migration:** 224 pgmysql test (idempotent rerun, indexes) modelled on `158_meshcore_packet_log_observer.pgmysql.test.ts`.
- **Pure:** `meshcorePacketDerived.test.ts` (decode-test fixtures); `hopStats.test.ts` (golden equal to the old `getSmartHopsStats`); `linkQuality.test.ts` (init clamp, ±1/0 steps, 0..10 clamp, replay); signalTrend adapter.
- **Routes:**
  - MeshCore packet routes: cursor/hasMore, 400 validation, distribution shape, 403 without `packetmonitor:read` on that source.
  - `unifiedRoutes.meshcoreFilters.test.ts`: `payload_type` excludes Meshtastic; `portnum` excludes MeshCore; protocol tagging with no portnum collision.
  - `telemetryRoutes.contactGraphs.test.ts`: pubkey branch uses `meshcore_messages`; Meshtastic unchanged; `nodes:viewOnMap` gate.
  - Extend `unifiedRoutes.perSource`.
- **Service:** `logPacket` stores the derived fields.
- **Frontend:**
  - `usePagedPackets` (offset/cursor, de-dup, `prependLive`); `usePackets` tests stay green.
  - `MeshCorePacketMonitorView.paging` (virtual rows, load-more, filter query string, contact click); `.repeater` / `.stopButton` stay green.
  - `PacketMonitorPage.dispatch`, `SignalTrendBadge` (NodeDetailsBlock stays green), `MeshCoreContactDetailPanel.linkHistory`, a UnifiedPacketMonitorPage filter test.
- **Gate:** full suite with the PG/MySQL containers up; `lint:ci` clean.

## 4. Work packages — WP1 → (WP2 ∥ WP3) → WP4
- **WP1 server packet log:** migration 224 (incl. `meshcore_messages` index), schema, types, `meshcorePacketDerived`, `likeSearch` + packetLog refactor, repo packet filters + distribution, service `logPacket` / `getDistribution`, `meshcorePacketRoutes`, tests. Owns `db/migrations.ts`.
- **WP2 unified server + contact graphs:** `unifiedRoutes` filters + distribution, `hopStats`, `linkQuality` + meshtasticManager delegation, `telemetry.ts` refactor, repo `getContactHopSamples` / `getContactSignalSamples`, `contactLinkStats`, `signalTrend` adapter, `telemetryRoutes`, tests. In `meshcore.ts` it appends a separate section and stays out of `buildPacketConditions`.
- **WP3 shared packet-list machinery + MeshCore monitor:** `usePagedPackets`, `usePackets` wrapper, `useMeshCorePackets`, `useInfiniteVirtualRows`, `PacketSearchInput`, `TimeWindowSelect`, `packetMonitorPopout`, `toChartEntries`, `PacketMonitorPage`, PacketMonitorPanel refactor, MeshCorePacketMonitorView rewrite, MeshCorePage / MeshCoreIngestView `onNodeClick`. Must not edit `UnifiedPacketMonitorPage` or `types/packet.ts`.
- **WP4 unified UI + contact-graph mount:** UnifiedPacketMonitorPage, `types/packet.ts`, `packetApi.ts`, SignalTrendBadge extraction + NodeDetailsBlock, SmartHops/LinkQuality props, MeshCoreContactDetailPanel section.
