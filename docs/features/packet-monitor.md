# Packet Monitor

The Packet Monitor is a diagnostic tool that displays raw Meshtastic packets as they are received from the mesh network. It provides visibility into the low-level packet traffic for debugging and analysis purposes.

## Accessing the Packet Monitor

The Packet Monitor appears at the bottom of the Map tab once enabled in Settings. It requires appropriate permissions to view.

## What the Packet Monitor Shows

::: info Incoming Packets Only
The Packet Monitor displays **only incoming packets** received from the mesh network. It acts as a "radio sniffer" showing what your node hears over the air, not what MeshMonitor transmits.
:::

### Packets That Appear

| Packet Type | Description |
|-------------|-------------|
| TEXT_MESSAGE (1) | Text messages received from other nodes |
| POSITION (3) | GPS position updates from nodes |
| NODEINFO (4) | Node information broadcasts |
| ROUTING (5) | Routing acknowledgments and errors |
| ADMIN (6) | Administrative messages |
| PAXCOUNTER (34) | Paxcounter telemetry |
| TELEMETRY (67) | Device/environment telemetry |
| TRACEROUTE (70) | Traceroute responses |
| NEIGHBORINFO (71) | Neighbor information |

### Packets That Do NOT Appear

The following packets sent **by MeshMonitor** are not logged to the Packet Monitor:

- **Outgoing text messages** - Messages you send via the chat interface
- **Outgoing traceroute requests** - Traceroutes initiated manually or by Auto Traceroute
- **Outgoing position requests** - Position exchange requests
- **Auto-acknowledge responses** - Automated replies sent by MeshMonitor
- **Auto-welcome messages** - Welcome messages sent to new nodes
- **Auto-announcements** - Scheduled announcement messages

This is by design - the Packet Monitor shows what is received from the mesh, not what MeshMonitor transmits.

## Filtering Packets

Use the packet type dropdown to filter by specific packet types (portnums). Common filters include:

- **All Types** - Show all received packets
- **TEXT_MESSAGE** - Show only text messages
- **POSITION** - Show only position updates
- **TELEMETRY** - Show only telemetry data
- **TRACEROUTE** - Show only traceroute responses
- **NODEINFO** - Show only node information packets

::: tip Traceroute Filter
If you filter on TRACEROUTE and see no results, this likely means no traceroute operations have been performed on your mesh recently. Traceroute packets only appear when:
1. A node on your mesh initiates a traceroute
2. The traceroute response is received back

To see traceroute packets, initiate a traceroute from MeshMonitor's Node Details page or from another device on your mesh.
:::

## Packet Information

Each packet entry shows:

- **Timestamp** - When the packet was received
- **From Node** - The sending node's ID and name
- **To Node** - The destination (broadcast or specific node)
- **Channel** - The channel number
- **Port Type** - The Meshtastic portnum/application type
- **SNR/RSSI** - Signal quality metrics
- **Hop Count** - Number of hops the packet traveled
- **Encrypted** - Whether the packet was encrypted
- **Payload Preview** - A summary of the packet contents

## Permissions

Viewing the Packet Monitor requires:
- `channel_0:read` permission
- `messages:read` permission

These permissions are typically granted to admin users or can be configured per-user in the Admin tab.

## Use Cases

The Packet Monitor is useful for:

- **Debugging connectivity issues** - See if packets are being received
- **Analyzing mesh traffic patterns** - Understand what types of traffic flow through your node
- **Verifying encryption** - Check which packets are encrypted vs unencrypted
- **Signal quality analysis** - Monitor SNR/RSSI values over time
- **Troubleshooting packet delivery** - Verify packets are reaching your node
