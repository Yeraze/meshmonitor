# Virtual Node Server

The Virtual Node Server is a powerful feature that allows multiple Meshtastic mobile apps to connect to MeshMonitor simultaneously without overwhelming your physical Meshtastic node.

## Overview

The Virtual Node Server acts as a TCP proxy between your mobile devices and your physical Meshtastic node. Instead of connecting directly to your physical node (typically on port 4403), mobile apps connect to MeshMonitor's Virtual Node Server (default port 4404). MeshMonitor then manages all communication with the physical node, caching configuration data and serializing messages to prevent overload.

### Architecture

```
Mobile App 1 ┐
Mobile App 2 ├─→ Virtual Node (4404) ─→ MeshMonitor ─→ Physical Node (4403)
Mobile App 3 ┘
```

## Key Benefits

1. **Multiple Simultaneous Connections**: Connect several mobile apps without degrading performance
2. **Reduced Physical Node Load**: Message queuing and caching minimize requests to the physical node
3. **Fast Connection Setup**: Cached configuration messages (240+ messages) enable instant mobile app connection
4. **Complete UI Visibility**: All messages sent from mobile apps appear in the MeshMonitor web interface
5. **Reliable Startup**: Virtual node starts correctly even if initial physical node connection fails
6. **Connection Stability**: Optimized message queue timing (10ms delays) ensures stable mobile app connections

## How It Works

### Configuration Capture & Replay

When MeshMonitor first connects to your physical Meshtastic node, it captures approximately 240 configuration messages including:
- Node information (MyNodeInfo)
- Channel configurations
- Node list and neighbor information
- Device settings and capabilities
- Network topology

These messages are cached in memory. When a mobile app connects to the Virtual Node Server, it receives this complete cached configuration instantly, allowing the app to connect and become fully operational in seconds instead of minutes.

### Message Queue Management

Outgoing messages from mobile apps are queued and serialized with 10ms delays between messages. This prevents overwhelming the physical node with rapid-fire requests that could cause connection instability or performance degradation.

### Bidirectional Message Forwarding

The Virtual Node Server forwards the following message types in both directions:
- Text messages (TEXT_MESSAGE_APP)
- Position updates (POSITION_APP)
- Telemetry data (TELEMETRY_APP)
- Traceroute requests and responses (TRACEROUTE_APP)
- Waypoints and other data packets

### Security Filtering

For safety, the Virtual Node Server **blocks** the following administrative message types from mobile clients:
- ADMIN_APP (device configuration changes)
- NODEINFO_APP (node information updates)

This prevents mobile apps from accidentally or maliciously modifying your physical node's configuration.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_VIRTUAL_NODE` | `true` | Enable/disable the Virtual Node Server |
| `VIRTUAL_NODE_PORT` | `4404` | TCP port for mobile app connections |

### Docker Compose Example

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    ports:
      - "8080:3001"      # Web interface
      - "4404:4404"      # Virtual Node Server
    volumes:
      - meshmonitor-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - ENABLE_VIRTUAL_NODE=true
      - VIRTUAL_NODE_PORT=4404
    restart: unless-stopped

volumes:
  meshmonitor-data:
```

### Kubernetes/Helm Example

```yaml
env:
  meshtasticNodeIp: "192.168.1.100"
  enableVirtualNode: "true"
  virtualNodePort: "4404"

service:
  type: LoadBalancer
  ports:
    - name: http
      port: 80
      targetPort: 3001
    - name: virtual-node
      port: 4404
      targetPort: 4404
```

## Mobile App Setup

### iOS (Official Meshtastic App)

1. Open the Meshtastic iOS app
2. Go to **Settings** > **Radio Configuration**
3. Select **Network** as your connection type
4. Enter your MeshMonitor server details:
   - **Host**: Your MeshMonitor server IP or hostname
   - **Port**: `4404` (or your custom VIRTUAL_NODE_PORT)
5. Save and connect

The app will connect to MeshMonitor's Virtual Node Server instead of directly to your physical node.

### Android (Official Meshtastic App)

1. Open the Meshtastic Android app
2. Tap the **+** button to add a new device
3. Select **Network (TCP)** as the connection method
4. Enter your server information:
   - **Address**: Your MeshMonitor server IP
   - **Port**: `4404`
5. Tap **Connect**

## Use Cases

### Home Network with Multiple Users

Perfect for families or groups where multiple people want to use the Meshtastic mobile app simultaneously:

```
Family's phones ──→ Virtual Node ──→ MeshMonitor ──→ Home mesh node
```

### Testing and Development

Developers can connect multiple test devices without overwhelming a single physical node:

```
Test Device 1 ┐
Test Device 2 ├──→ Virtual Node ──→ MeshMonitor ──→ Test node
Test Device 3 ┘
```

### Remote Access

Users can connect to your mesh network remotely via the Virtual Node Server (ensure proper security measures are in place):

```
Remote App ──→ Internet ──→ VPN/Port Forward ──→ Virtual Node ──→ MeshMonitor ──→ Local node
```

## Monitoring and Troubleshooting

### Checking Virtual Node Status

The Virtual Node Server logs its startup and connection events. Check your MeshMonitor logs:

```bash
# Docker logs
docker logs meshmonitor | grep -i "virtual"

# Look for messages like:
# "Starting virtual node server on port 4404..."
# "Virtual node server listening on 0.0.0.0:4404"
# "Virtual node: client connected"
```

### Connection Problems

**Mobile app can't connect:**

1. Verify the Virtual Node Server is enabled:
   ```bash
   docker exec meshmonitor printenv | grep VIRTUAL_NODE
   ```

2. Check that port 4404 is exposed in your Docker configuration

3. Ensure firewall rules allow TCP traffic on port 4404:
   ```bash
   # Linux/iptables
   sudo iptables -I INPUT -p tcp --dport 4404 -j ACCEPT

   # macOS
   # System Preferences > Security & Privacy > Firewall > Firewall Options

   # Windows
   # Windows Defender Firewall > Advanced Settings > Inbound Rules > New Rule
   ```

4. Test port accessibility:
   ```bash
   # From mobile device or another machine
   telnet <meshmonitor-ip> 4404
   # Or
   nc -zv <meshmonitor-ip> 4404
   ```

**Mobile app connects but doesn't receive data:**

1. Check that MeshMonitor is connected to the physical node
2. Review logs for configuration capture completion:
   ```bash
   docker logs meshmonitor | grep -i "config.*complete"
   ```
3. Verify the physical node is reachable from MeshMonitor

**Messages from mobile app don't appear in web UI:**

This was fixed in v2.13.0. Ensure you're running the latest version:
```bash
docker pull ghcr.io/yeraze/meshmonitor:latest
docker compose up -d
```

### Performance Tuning

The Virtual Node Server is optimized for stable connections with:
- 10ms message queue delays (prevents node overload)
- 240 cached configuration messages (ensures fast client connection)
- Automatic reconnection handling

These values are tuned for optimal performance and typically don't require adjustment.

## Security Considerations

### Network Exposure

By default, the Virtual Node Server listens on `0.0.0.0` (all interfaces). Consider these security measures:

**1. Firewall Rules**

Restrict access to known IPs:
```bash
# Allow only local network
sudo iptables -A INPUT -p tcp --dport 4404 -s 192.168.1.0/24 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 4404 -j DROP
```

**2. VPN Access**

Use a VPN (WireGuard, OpenVPN, Tailscale) instead of exposing the port to the internet:
```yaml
# Expose only to VPN interface
services:
  meshmonitor:
    ports:
      - "8080:3001"
      - "10.0.0.1:4404:4404"  # Only listen on VPN interface
```

**3. Authentication**

The Meshtastic protocol itself does not include authentication at the TCP level. Security relies on:
- Network-level access control (firewalls, VPNs)
- Mesh network encryption keys
- Channel-specific PSK (Pre-Shared Keys)

### Administrative Command Blocking

The Virtual Node Server automatically blocks these administrative commands from mobile clients:
- ADMIN_APP: Prevents configuration changes to the physical node
- NODEINFO_APP: Prevents node information updates

Text messages, positions, telemetry, and traceroutes are allowed and work normally.

## Advanced Configuration

### Custom Port

To use a different port (e.g., to avoid conflicts):

```yaml
environment:
  - VIRTUAL_NODE_PORT=14404
ports:
  - "14404:14404"
```

### Disabling Virtual Node

If you don't need multiple mobile connections:

```yaml
environment:
  - ENABLE_VIRTUAL_NODE=false
```

This frees up the port and reduces memory usage slightly.

### Multiple MeshMonitor Instances

You can run multiple MeshMonitor instances, each with its own Virtual Node Server, to monitor multiple physical nodes:

```yaml
services:
  meshmonitor-node1:
    image: ghcr.io/yeraze/meshmonitor:latest
    ports:
      - "8080:3001"
      - "4404:4404"
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - ENABLE_VIRTUAL_NODE=true
    volumes:
      - node1-data:/data

  meshmonitor-node2:
    image: ghcr.io/yeraze/meshmonitor:latest
    ports:
      - "8081:3001"
      - "4405:4404"  # Different external port
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.101
      - ENABLE_VIRTUAL_NODE=true
    volumes:
      - node2-data:/data

volumes:
  node1-data:
  node2-data:
```

Mobile apps can then connect to different MeshMonitor instances (and different physical nodes) by changing the port.

## Technical Details

### Connection Flow

1. **Client Connection**: Mobile app establishes TCP connection to port 4404
2. **Config Replay**: Virtual Node Server immediately sends cached configuration (MyNodeInfo, channels, nodes)
3. **Client Ready**: Mobile app transitions through "Communicating" phase and becomes fully operational
4. **Bidirectional Forwarding**: Messages flow in both directions with queue management
5. **Graceful Disconnect**: When client disconnects, resources are cleaned up automatically

### Message Processing

**Inbound (from physical node):**
```
Physical Node → MeshMonitor → Virtual Node → All Connected Clients
```

**Outbound (from mobile apps):**
```
Mobile App → Virtual Node Queue (10ms delays) → MeshMonitor → Physical Node
```

### Protocol Compatibility

The Virtual Node Server implements the Meshtastic TCP streaming protocol:
- 4-byte framed packets: `[0x94][0x93][LEN_MSB][LEN_LSB][PROTOBUF]`
- Binary protobuf payload (FromRadio/ToRadio messages)
- Compatible with official Meshtastic mobile apps (iOS, Android, Python CLI)

## Frequently Asked Questions

### Can I use the Virtual Node with meshtasticd?

Yes! If you're using meshtasticd (virtual Meshtastic node daemon), MeshMonitor's Virtual Node Server works perfectly as a proxy:

```
Mobile Apps → Virtual Node (4404) → MeshMonitor → meshtasticd (4403)
```

### Does the Virtual Node work with HTTP API calls?

No. The Virtual Node Server uses the Meshtastic TCP protocol (binary protobuf messages), not HTTP. It's designed specifically for Meshtastic mobile apps and TCP clients.

For HTTP access, use MeshMonitor's REST API endpoints (see [API Documentation](/api/REST_API.md)).

### What happens if MeshMonitor restarts?

Mobile apps will disconnect when MeshMonitor restarts. They should automatically attempt to reconnect. When MeshMonitor comes back online, the Virtual Node Server starts, captures configuration from the physical node, and accepts new connections.

### Can I disable the Virtual Node and use direct connections?

Yes. Set `ENABLE_VIRTUAL_NODE=false` and connect your mobile apps directly to the physical node on port 4403. However, this means:
- Only one mobile connection may be stable
- No configuration caching
- Messages from mobile apps won't appear in MeshMonitor's web UI

### Is there a limit to how many mobile apps can connect?

There's no hard-coded limit, but practical considerations apply:
- Each connection consumes memory (cached config messages)
- More clients = more outgoing messages queued
- Your physical node's processing capacity is the real bottleneck

In practice, 3-5 simultaneous mobile connections work well. Beyond that, you may experience delays as the message queue grows.

## Version History

- **v2.13.0**: Virtual Node Server officially released with capture/replay and connection stability improvements
- **v2.12.x**: Virtual Node Server beta testing and refinements

## See Also

- [Getting Started Guide](/getting-started) - Basic MeshMonitor setup
- [Configuration Overview](/configuration/index) - All configuration options
- [REST API Reference](/api/REST_API.md) - HTTP API for web/automation access
- [Production Deployment](/configuration/production) - Best practices for production use
