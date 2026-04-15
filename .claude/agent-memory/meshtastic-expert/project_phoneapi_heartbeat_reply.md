---
name: PhoneAPI Heartbeat Reply Mechanism
description: Firmware PhoneAPI replies to every ToRadio.heartbeat with a FromRadio.queueStatus — use this as a deterministic liveness pong for phone API clients
type: project
---

The Meshtastic firmware PhoneAPI (src/mesh/PhoneAPI.cpp on master) responds to every `ToRadio.heartbeat` with a single `FromRadio.queueStatus` message. This is a local, zero-radio-cost round-trip.

**Mechanism:**
- `handleToRadio()` receives `meshtastic_ToRadio_heartbeat_tag`, sets module-level `bool heartbeatReceived = true`, logs `"Got client heartbeat"`.
- Next call to `getFromRadio()` checks the flag FIRST (before state machine), emits `FromRadio` with `which_payload_variant = meshtastic_FromRadio_queueStatus_tag` carrying `router->getQueueStatus()`, clears the flag.
- Comment in source: *"Flag to indicate a heartbeat was received and we should send queue status"*.
- The `Heartbeat.nonce` field is NOT echoed — you cannot correlate individual heartbeats, only observe that some queueStatus arrived.

**Why:** The firmware does NOT proactively send heartbeats to clients (no `FromRadio.heartbeat` exists in the oneof). Liveness is entirely client-driven, and the queueStatus reply is the only deterministic, polling-style probe available without generating mesh traffic.

**How to apply:** When building a phone API client (TCP/Serial/BLE):
1. Send `ToRadio.heartbeat` periodically (e.g., 30s).
2. Treat any incoming `FromRadio.queueStatus` as a liveness pong — refresh a `lastQueueStatusMsec` timestamp.
3. Any other FromRadio (packet, nodeInfo, etc.) also proves device liveness.
4. If `now - lastQueueStatusMsec > ~3x interval`, force-close the socket — this bypasses kernel TCP write-buffer lag (which can mask dead hosts for minutes).
5. NEVER use self-addressed MeshPacket with wantAck=true as a heartbeat — costs radio airtime and pollutes the mesh.
6. Gracefully degrade: older firmware (<2.2.x) may not reply — fall back to socket-level detection.

**Source:** https://github.com/meshtastic/firmware/blob/master/src/mesh/PhoneAPI.cpp (see `handleToRadio` and `getFromRadio`)
