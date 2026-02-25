# Reducing Node Load

MeshMonitor communicates with your Meshtastic node over a persistent TCP connection, sending protobuf-encoded admin packets to request configuration, telemetry, and status data. On memory-constrained devices (ESP32-based boards like Heltec V3/V4, RAK4631), excessive traffic can contribute to heap memory exhaustion over time.

::: tip
This is primarily a firmware-side issue tracked at [meshtastic/firmware#9632](https://github.com/meshtastic/firmware/issues/9632). The recommendations below help reduce MeshMonitor's contribution to node memory pressure while the firmware fix is developed.
:::

## How MeshMonitor Communicates with the Node

On every connection (or reconnect), MeshMonitor:

1. **Sends `wantConfigId`** to request the full node database and channel configuration
2. **Requests LoRa config** (1 admin packet)
3. **Requests all module configs** (15 admin packets) — only on first connect, skipped on reconnect
4. **Starts periodic schedulers** for traceroutes, LocalStats, time sync, announcements, etc.

During normal operation, MeshMonitor sends:
- **LocalStats requests** at a configurable interval (default: every 15 minutes)
- **Auto-traceroute requests** based on configured interval
- **Auto-acknowledge tapbacks and replies** when messages match the configured pattern
- **Auto-welcome messages** when new nodes appear
- **Auto-announce messages** on a schedule
- **TCP keepalive probes** every 5 minutes

## Features That Increase Node Load

### Auto-Traceroute
Sends traceroute requests to discovered nodes. On busy meshes with many nodes, this can generate significant traffic.

**Recommendation:** Increase the interval to 15-30 minutes, or disable (set to 0) on ESP32-based nodes.

### Remote Admin Scanner
Periodically probes nodes for remote admin capability. Each probe is an admin packet.

**Recommendation:** Increase the interval or disable if you don't need remote admin discovery.

### Auto-Acknowledge (Auto-ACK)
Responds to matching messages with tapback reactions and/or text replies. On high-traffic channels, this can generate many outgoing messages.

**Recommendation:** On busy channels, be selective about which channels have auto-ACK enabled. All auto-ACK sends (both tapbacks and replies) are rate-limited through the message queue (30-second minimum spacing).

### Auto-Announce
Broadcasts announcement messages on a schedule. Each announcement is one outgoing message per configured channel.

**Recommendation:** Use longer intervals (4-12 hours) on constrained nodes.

### LocalStats Collection
Requests device statistics (airtime, channel utilization, uptime) from the connected node.

**Recommendation:** The default interval is 15 minutes. Increase to 30-60 minutes on constrained nodes, or set to 0 to disable entirely. This setting is available under **Settings > Node Management > LocalStats Collection Interval**.

## Configuration Recommendations for Constrained Nodes

If your node is experiencing heap exhaustion or frequent reboots:

1. **Increase LocalStats interval** to 30+ minutes (Settings > Node Management)
2. **Increase or disable auto-traceroute** (Settings > Auto-Traceroute)
3. **Be selective with auto-ACK channels** — avoid enabling on high-traffic channels
4. **Increase announcement intervals** to 4+ hours
5. **Disable remote admin scanner** if not needed (set interval to 0)

## Technical Details

- **TCP keepalive:** 5 minutes (reduced from 1 minute to lower TCP stack overhead)
- **Module config caching:** Module configs are only requested on the first connection after MeshMonitor starts. Reconnects skip these 15 admin packets.
- **Message queue rate limiting:** All automated outgoing messages (auto-ACK tapbacks, auto-ACK replies, auto-welcome, auto-responder) go through a shared message queue with 30-second minimum spacing between sends.
- **LocalStats initial delay:** The first LocalStats request is delayed 30 seconds after connection to let the node settle.
