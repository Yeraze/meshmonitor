# Auto Heap Management

Automatically protects low-memory Meshtastic nodes from running out of heap by purging stale nodes and rebooting the device when free memory falls below a configurable threshold.

## Overview

Meshtastic devices have limited RAM. Nodes running multiple features simultaneously — MQTT bridging, networking, telemetry reporting, and storing a large node database — can exhaust their heap over time. When heap is fully depleted, the node crashes or freezes.

Auto Heap Management monitors the `heapFreeBytes` value reported in **LocalStats telemetry** from your connected node. When free heap drops below your configured threshold, MeshMonitor:

1. Removes the **10 least-recently-heard nodes** from the device's NodeDB
2. Waits briefly for the removals to complete
3. Sends a **reboot command** to the node

After rebooting (~10 seconds), the node reconnects with freed heap and returns to normal operation.

A **30-minute cooldown** prevents repeated triggers in rapid succession.

## Target Hardware

This feature is most useful on devices with constrained RAM:

| Hardware | Typical Free Heap | Risk Level |
|----------|-------------------|------------|
| Heltec LoRa32 V3 | ~60–120 KB | High |
| TTGO T-Beam | ~60–100 KB | High |
| RAK4631 (nRF52840) | ~100–150 KB | Medium |
| LilyGO T-Echo | ~80–120 KB | Medium |
| WIO Tracker 1110 | ~60–100 KB | High |
| ESP32-S3 based boards | ~150–250 KB | Low |

Risk increases when enabling MQTT, networking module, telemetry, and having more than 100 nodes in the device database simultaneously.

## When to Enable

Enable Auto Heap Management when your node:

- Runs **MQTT bridging** (significant heap consumer)
- Has the **networking module** enabled
- Reports **telemetry** to the mesh
- Has a **large node database** (100+ nodes heard)
- Has experienced **unexpected crashes or freezes**

Leave it disabled on high-memory devices (e.g., ESP32-S3 with >200 KB typical free heap) unless you observe problems.

## Configuration

Navigate to **Settings → Automation** and find the **Auto Heap Management** section.

| Setting | Description | Default | Recommended |
|---------|-------------|---------|-------------|
| **Enable** | Turn auto heap management on or off | Off | On for at-risk hardware |
| **Heap threshold (KB)** | Purge triggers when free heap falls below this value | 20 KB | 20 KB for most nodes; 10 KB for very constrained |

### Threshold Guidelines

- **20 KB** — Recommended for most nodes. Provides a safety buffer before the node becomes unstable.
- **10 KB** — For very constrained hardware where purges should only trigger in critical situations.
- **30 KB** — For early warning: triggers before the situation becomes critical, at the cost of more frequent purges.

The threshold is configured in **kilobytes** in the UI; MeshMonitor stores it internally as bytes.

### Live Heap Display

When LocalStats telemetry is flowing, the settings panel shows your node's **last known free heap**. Use this to calibrate your threshold — set it to roughly 50% of your typical lowest free-heap reading during normal operation.

If no heap data has been received yet, the display shows: *"No heap data received yet. Heap is reported via LocalStats telemetry from your node."*

## How It Works (Step by Step)

1. Your node sends a **LocalStats telemetry packet** to MeshMonitor (typically every few minutes).
2. MeshMonitor checks if `heapFreeBytes` is below your configured threshold.
3. If it is, and the **30-minute cooldown** has elapsed since the last purge:
   a. MeshMonitor queries the device NodeDB for nodes sorted by last-heard time (oldest first).
   b. The **10 oldest nodes** (excluding your local node) are removed via remote admin commands.
   c. After a short delay, a **reboot command** is sent to the node.
4. The node reboots. Expect **~10 seconds of disconnection**, then automatic reconnection.
5. The cooldown timer resets.

An **audit log entry** is written each time a purge occurs: *"Auto heap management: purged N nodes (heap was X bytes free)"*

## FAQ

### Will I lose important nodes?

The purge removes the **10 least-recently-heard nodes** — nodes that have not been seen for the longest time. Active, frequently-heard nodes are preserved. If a purged node comes back online, it will be re-added to the database when its next packet is heard.

You will not lose any message history or MeshMonitor data — only the device-side NodeDB entries are removed.

### How often will it trigger?

It depends on how quickly your node's heap is consumed. The built-in **30-minute cooldown** prevents repeated triggers. If your node is triggering frequently (multiple times per day), consider:

- Reducing the number of features running on the node
- Lowering the node database size limit in Meshtastic firmware settings
- Raising the threshold slightly so purges happen earlier and less dramatically

### Will the reboot cause problems?

A ~10-second disconnect is normal and expected. MeshMonitor will reconnect automatically once the node is back online. Messages sent during the disconnect may be missed, but this is the same behavior as any other node reboot.

### Does this affect other nodes on the mesh?

No. The purge only removes entries from your **connected node's** local database. Other nodes on the mesh are unaffected and retain their own node databases.

### Is there a way to see when it last triggered?

Yes. Check the MeshMonitor audit log for entries containing *"Auto heap management"*. Each triggered purge is logged with the node count and heap value at the time.

### What if my node has remote admin disabled?

Auto Heap Management uses MeshMonitor's existing remote admin connection to your **directly connected** node. It does **not** require remote admin to be enabled across the mesh — it only manages the node MeshMonitor is connected to.

## Related Documentation

- [Automation](/features/automation) — Overview of all MeshMonitor automation features
- [Admin Commands](/features/admin-commands) — Manual node management commands
- [Remote Admin Scanner](/features/automation#remote-admin-scanner) — Discover remotely manageable nodes across the mesh
- [Settings](/features/settings) — General MeshMonitor configuration
