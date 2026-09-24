# Coverage Report Epic (#5277)

## Goal

A passive, measured coverage map. Every position fix a receiver hears is stored
with the receiver's signal reading (SNR/RSSI) and hop data, then shown on
**Reports → Coverage** as dots coloured by signal. It replaces the Range Test
module that Meshtastic firmware 2.8 removed, without sending anything.

The active portnum-66 range test (issue "Approach B") is **not** built. See the
plan comment on #5277.

## Decisions (interview, 2026-09-24)

- **Airtime:** MeshMonitor sends nothing. The only cost is the operator's survey
  node setup; the report recommends hop_limit 0, smart position on, 30 s or more.
  MeshMonitor never pushes config to the survey node.
- **Storage:** new per-reception table, not more `telemetry` rows. One row per
  packet per path (direct, or each distinct relay), not every duplicate.
- **Radio sources record always**, no setting. Receptions flagged as arriving via
  MQTT on a radio source are skipped (their SNR is not our radio's).
- **MQTT sources:** opt-in per source (volume). Each gateway is its own receiver.
- **MeshCore:** included, in its own phase (P3).
- **Retention:** one global setting `coverage_retention_days`, default 7, clamped.
  Saved surveys are exempt until deleted.
- **No backfill** from existing telemetry.
- **Placement:** a new card on the global Reports page (`src/pages/ReportsPage.tsx`,
  `src/components/Analysis/AnalysisTab.tsx`). Receivers default to every source the
  user can read; per-source read permission applies; positions pass the same
  hidden-from-map / private-position checks as `/api/analysis/positions`.
- **No events:** receptions are not emitted onto `dataEventEmitter`; no
  notifications, no automation triggers.

## Phases

- [x] **P1 — Meshtastic RF receptions + Coverage report.**
  Table (all three backends) + repository + recording in the Meshtastic POSITION
  path + retention purge + global retention setting + API + Reports → Coverage
  card: map (dots by SNR/RSSI, receiver markers), filters (sender, receiver(s),
  hops exact/cumulative, time range, colour metric), point popup listing every
  receiver. Setup guidance with airtime estimate.
  *Exit:* live RF positions appear on the report; per-source isolation test;
  retention purge test; full suite green on SQLite/PG/MySQL.
- [ ] **P2 — MQTT gateway receptions.** Per-source opt-in; each gateway recorded as
  a receiver with its SNR/RSSI; report shows gateway receivers; note that nodes
  disallowing MQTT uploads won't appear.
  *Exit:* opt-in off by default; gateway receptions shown per receiver.
- [ ] **P3 — MeshCore receptions.** Advert positions with SNR/RSSI from the raw RX
  feed (LOG_RX_DATA 0x88) and hops from path_len.
  *Exit:* MeshCore receptions on the report alongside Meshtastic.
- [ ] **P4 — Gaps, surveys, summary, export.** Likely-gap lines; saved surveys
  (live start or past range) exempt from retention; summary panel (heard vs
  expected, best/worst, distance-vs-SNR chart, per-receiver table); grid view;
  CSV/GeoJSON export; "Show coverage" link on node details.

## Phase log

### P1 (2026-09-24)

- Spec: `COVERAGE_P1_SPEC.md`. Migration 172 creates `coverage_receptions`.
- **Zero-hop detection corrected during review:** a hop_limit-0 origin arrives
  hop_start=0, hop_limit=0, relay_node=0 (the receiver zeroes relay_node when
  hop_start is 0). True zero-hop is told apart from pre-2.3 firmware by
  `decoded.bitfield` presence, not by the relay byte. Receivers before fw 2.7.20
  drop zero-hop packets; the guidance offers hop_limit 1 as the fallback.
- `/receivers` derives receivers from recorded rows, not `source.type` strings, so
  P2 gateways and P3 MeshCore need no change there.
- Source deletion and purge-all-nodes delete a source's receptions.
- Browser validation caught an endless refetch loop (time window computed from
  `Date.now()` during render); the window now lives in state, with a
  query-stability regression test.
- Observed on live data: many packets carry no `rx_rssi`; the UI shows "—".
- Relay byte 0 is firmware's NO_RELAY_NODE; the popup omits "via" for it.
