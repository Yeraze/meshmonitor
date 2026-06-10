---
name: LocalStats noise_floor field
description: noise_floor field added to LocalStats telemetry message (field 15, int32, dBm) in protobufs master, Jan 2026
type: reference
---

The `noise_floor` field was added to the `LocalStats` message in `meshtastic/telemetry.proto` (firmware ~2.7.25 alpha, firmware PR #9347).

- **Proto field name (snake_case):** `noise_floor`
- **JS/camelCase name:** `noiseFloor`
- **Field number:** 15
- **Type:** `int32` (originally added as `float`, then changed to `int32` on 2026-01-19, commit 3193bab by thebentern). Initial add was 2026-01-17, commit 1b1dc09 by RCGV1.
- **Unit:** dBm. Proto comment: "Noise floor value measured in dBm".
- **Merged status:** YES, present in protobufs `master`.

Full LocalStats field list (for reference): uptime_seconds=1, channel_utilization=2, air_util_tx=3, num_packets_tx=4, num_packets_rx=5, num_packets_rx_bad=6, num_online_nodes=7, num_total_nodes=8, num_rx_dupe=9, num_tx_relay=10, num_tx_relay_canceled=11, heap_total_bytes=12, heap_free_bytes=13, num_tx_dropped=14, noise_floor=15.

For MeshMonitor storage: it's a signed integer (dBm, typically negative), not a float. Coerce appropriately.
