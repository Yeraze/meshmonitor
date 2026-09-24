# Per-Transport Telemetry Breakdown Epic (#5101)

## Goal

Every dashboard/Info widget that shows a number accumulated across transports
either splits it by transport (RF / UDP / MQTT) or, where the data has no
transport axis, says so plainly. Follow-up to #5097 (PR #5144), which made map
route segments respect the Show RF / UDP / MQTT toggles.

## Feasibility (audit, 2026-09-23)

| Widget | Source | Transport data | Verdict |
|---|---|---|---|
| Network Survey → Reach by hop count | `traceroutes` newest answered per peer | `traceroutes.transportMechanism` (mig 160) + per-hop MQTT sentinel | Split, no migration |
| Nodes by Packet Type donut | `packet_log` | `packet_log.transport_mechanism` | Split, no migration |
| Network Stats → Total Nodes | nodes (poll) | `transportLastRf/Mqtt/Udp` (mig 126) | Split, client-side |
| Network Stats → Total Messages | poll window (capped at 100!) | `messages.viaMqtt` only | True count query in P1 (RF vs MQTT); UDP split after P2 column |
| Record Holder / Longest Active route segment | `route_segments` | none | Needs migration (P2) |
| Radio Statistics donuts, Packets TX/RX, Online Nodes, Duplicate Packets (Device) | firmware LocalStats telemetry | none — firmware counters have no transport axis | Cannot split; label + new MeshMonitor-computed series (P3) |

## Decisions (user interview, 2026-09-23)

- **Split style:** inline breakdown under the total (`42` / `RF 30 · UDP 2 · MQTT 10`); donuts get an All / RF / UDP / MQTT selector defaulting to All.
- **Route-segment records:** per-transport records (RF / MQTT / UDP), each labelled — an MQTT-bridged link must not beat a genuine RF record.
- **Total Messages:** a true per-source DB count, not the poll window.
- **UDP message split:** yes — add `messages.transportMechanism` (P2).
- **Network Survey:** stacked RF / UDP / MQTT bars per hop bucket.
- **New computed series (P3):** in both the Dashboard telemetry grid and the Info tab.
- **Classifier:** node counts use the per-transport-last timestamps (`transportLast*`, mig 126 / #4240) with additive (OR) semantics, so private-broker RF relay doesn't inflate MQTT. Legacy NULL transport reads as RF, matching `classifyNodeTransport`.
- **Phase 2 (2026-09-23):** old record holders get a best-effort reclassify (migration 171); message class = viaMqtt wins, then mechanism 6→UDP / 5→MQTT, else RF; outbound messages stamp INTERNAL (0); also fix Longest Active showing the record copy, give MQTT sources record holders, and scope route-segment permissions per source.
- **Mesh impact:** none — read-side analytics only; no packets, notifications or timers.

## Phases

### Phase 1 — splits that need no migration
- [x] Bug: MQTT-ingested traceroutes carry `transportMechanism = MQTT` (`mqttIngestion.ts`), not NULL→RF.
- [x] Bug: `packet_log` writes use `resolveRadioPacketTransport` so viaMqtt-only packets log as MQTT.
- [x] Network Survey hop histogram: stacked per-transport buckets.
- [x] Nodes by Packet Type donuts: transport selector backed by a server-side filter.
- [x] Network Stats: Total Nodes inline split; Total Messages true count with RF / MQTT split.

Exit: all of the above shipped, per-source isolation tested, full suite green on SQLite + PG + MySQL.

### Phase 2 — migrations
- [x] `route_segments` transport column, set per hop; legacy NULL = RF.
- [x] Record holder per (source, transport); Record Holder + Longest Active cards show per-transport records.
- [x] `messages.transportMechanism` stamped at ingest; Total Messages gains the UDP split.

Exit: migrations idempotent on all three backends; cards render per-transport records.

### Phase 3 — device counters
- [ ] Label firmware LocalStats widgets as device (all-transport) counters.
- [ ] New computed series: Nodes Heard per transport (from `transportLast*`), Packets RX per transport (from `packet_log`), in the Dashboard grid and the Info tab.

Exit: new series render in both places; labels make the device/computed distinction obvious.

## Status log

- 2026-09-23: epic planned; Phase 1 started on `feature/5101-p1-transport-widgets`.
- 2026-09-23: Phase 1 implemented (spec: TRANSPORT_BREAKDOWN_P1_SPEC.md). Deviations/decisions:
  - The per-source poll now passes `transportMechanism` + `transportLast*` through `mapDbNodeToDeviceInfo` (user sign-off, risk R1): the per-source map toggles now use the #4240 stamps and recognise UDP, matching the Dashboard map.
  - Survey reach classification: the forward-leg unknown-SNR sentinel wins (MQTT), else the record class; NULL = RF (`reachTransportClass`).
  - Total Messages comes from new `GET /api/messages/counts` (shares `resolveMessageReadAccess` with `GET /api/messages`); excludes TRACEROUTE_APP.
  - Follow-ups (not in this epic): poll's third copy of the message-read predicate; `/api/packets/stats/distribution` ignores per-channel permissions (pre-existing).
- 2026-09-23: Phase 1 merged (PR #5329). Phase 2 started on `feature/5101-p2-transport-migrations`; spec TRANSPORT_BREAKDOWN_P2_SPEC.md (migrations 169–171).
- 2026-09-23: Phase 2 implemented (migrations 169 route_segments.transportMechanism + index, 170 messages.transportMechanism, 171 best-effort record-holder reclassify). Deviations/decisions:
  - Route-segment routes are gated on the per-source `traceroute` permission (read for the cards, write for Clear Record), not `info` — `info` is cross-source by design, so it could not scope records per source (user decision). InfoTab hides the cards without traceroute:read.
  - Longest Active no longer returns the record-holder copy; MQTT sources now set record holders; DELETE requires sourceId.
  - Dev-DB run of 171: 2 legacy records examined, both unmatched (traceroutes pruned) → remain RF with the legacy note.
