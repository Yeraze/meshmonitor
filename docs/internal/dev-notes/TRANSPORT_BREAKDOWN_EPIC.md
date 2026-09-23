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
- **Mesh impact:** none — read-side analytics only; no packets, notifications or timers.

## Phases

### Phase 1 — splits that need no migration
- [ ] Bug: MQTT-ingested traceroutes carry `transportMechanism = MQTT` (`mqttIngestion.ts`), not NULL→RF.
- [ ] Bug: `packet_log` writes use `resolveRadioPacketTransport` so viaMqtt-only packets log as MQTT.
- [ ] Network Survey hop histogram: stacked per-transport buckets.
- [ ] Nodes by Packet Type donuts: transport selector backed by a server-side filter.
- [ ] Network Stats: Total Nodes inline split; Total Messages true count with RF / MQTT split.

Exit: all of the above shipped, per-source isolation tested, full suite green on SQLite + PG + MySQL.

### Phase 2 — migrations
- [ ] `route_segments` transport column, set per hop; legacy NULL = RF.
- [ ] Record holder per (source, transport); Record Holder + Longest Active cards show per-transport records.
- [ ] `messages.transportMechanism` stamped at ingest; Total Messages gains the UDP split.

Exit: migrations idempotent on all three backends; cards render per-transport records.

### Phase 3 — device counters
- [ ] Label firmware LocalStats widgets as device (all-transport) counters.
- [ ] New computed series: Nodes Heard per transport (from `transportLast*`), Packets RX per transport (from `packet_log`), in the Dashboard grid and the Info tab.

Exit: new series render in both places; labels make the device/computed distinction obvious.

## Status log

- 2026-09-23: epic planned; Phase 1 started on `feature/5101-p1-transport-widgets`.
