# MQTT Client Proxy

The MQTT Client Proxy is an optional sidecar container that enables reliable MQTT connectivity for MeshMonitor deployments. It routes MQTT traffic through MeshMonitor instead of relying on your Meshtastic node's WiFi connection.

::: tip Credit
The MQTT Proxy was created by [LN4CY](https://github.com/LN4CY/mqtt-proxy). MeshMonitor integrates it as an optional Docker sidecar. See also: [AI Responder](/add-ons/ai-responder), another add-on by the same author.
:::

## Overview

The MQTT Client Proxy behaves like the official Meshtastic mobile apps - it uses the `mqttClientProxyMessage` protocol to route MQTT traffic through a client device instead of directly from the node. This provides several advantages over the node's built-in MQTT gateway.

## When to Use the MQTT Proxy

### Recommended Scenarios

| Scenario | Why MQTT Proxy Helps |
|----------|---------------------|
| **Unreliable node WiFi** | Nodes with poor WiFi (T-Deck, portable devices) frequently drop connections. The proxy runs on stable infrastructure. |
| **No WiFi-enabled node** | Serial or BLE-connected nodes can still use MQTT through the proxy. |
| **Mobile apps not running** | Get MQTT without keeping the Meshtastic app open on your phone. |
| **Server-grade reliability** | Docker containers with health checks and auto-restart are more reliable than embedded hardware. |
| **Centralized MQTT management** | All MQTT traffic flows through your server, making it easier to monitor and debug. |

### When NOT to Use It

- Your node has reliable, stable WiFi/Ethernet connectivity
- You're already running the mobile app and it handles MQTT fine
- You don't need MQTT connectivity at all
- You prefer minimal Docker complexity

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Server                              │
│                                                              │
│  ┌────────────────┐     ┌────────────────┐                  │
│  │  MeshMonitor   │────▶│  MQTT Proxy    │                  │
│  │  (port 3001)   │     │  (sidecar)     │                  │
│  │                │     │                │                  │
│  │  Virtual Node  │◀────│  TCP Client    │                  │
│  │  (port 4404)   │     │                │                  │
│  └────────┬───────┘     └───────┬────────┘                  │
│           │                     │                            │
│           │                     │ mqttClientProxyMessage     │
│           │                     ▼                            │
│           │             ┌───────────────┐                   │
│           │             │  MQTT Broker  │                   │
│           │             │  (external)   │                   │
│           │             └───────────────┘                   │
└───────────┼─────────────────────────────────────────────────┘
            │
            │ TCP (port 4403)
            ▼
    ┌───────────────┐
    │  Meshtastic   │
    │    Node       │
    │  (WiFi/BLE/   │
    │   Serial)     │
    └───────────────┘
```

**Key Points:**
1. The proxy connects to MeshMonitor's Virtual Node (port 4404)
2. It reads MQTT settings directly from your node - no duplicate configuration
3. Messages flow bidirectionally between your mesh and the MQTT broker
4. The proxy uses the same protocol as the official mobile apps

## Setup Instructions

### Prerequisites

1. **Virtual Node enabled** - The MQTT Proxy requires MeshMonitor's Virtual Node feature
2. **Node MQTT configured** - Your Meshtastic node must have MQTT settings configured
3. **Client Proxy mode enabled** - On your node, enable "Proxy to Client" in MQTT settings

### Step 1: Configure Your Meshtastic Node

In MeshMonitor's Device Configuration tab, or using the Meshtastic mobile app:

1. **Enable MQTT** on your node
2. **Set the MQTT broker address** (e.g., `mqtt.meshtastic.org:1883`)
3. **Configure username/password** if required by your broker
4. **Enable "Proxy to Client"** - This is critical! It tells the node to send MQTT traffic through a client rather than directly.

### Step 2: Enable in Docker Configurator

Use the [Docker Configurator](/configurator) to generate your docker-compose.yml with the MQTT Proxy enabled:

1. Check **"Enable MQTT Client Proxy Sidecar"** in the Additional Settings section
2. The Virtual Node will be automatically enabled if not already
3. Copy the generated docker-compose.yml

### Step 3: Deploy

```bash
docker compose up -d
```

The MQTT Proxy container will:
1. Connect to MeshMonitor's Virtual Node
2. Read MQTT configuration from your node
3. Establish connection to the MQTT broker
4. Begin forwarding messages bidirectionally

## Manual Docker Compose Configuration

If you prefer to add the MQTT Proxy manually to an existing setup:

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    # ... your existing MeshMonitor configuration ...
    environment:
      - ENABLE_VIRTUAL_NODE=true
      - VIRTUAL_NODE_PORT=4404
      # ... other environment variables ...

  # MQTT Client Proxy - routes MQTT through MeshMonitor
  # Credit: https://github.com/LN4CY/mqtt-proxy
  mqtt-proxy:
    image: ghcr.io/ln4cy/mqtt-proxy:master
    container_name: meshmonitor-mqtt-proxy
    restart: unless-stopped
    environment:
      - INTERFACE_TYPE=tcp
      - TCP_NODE_HOST=meshmonitor
      - TCP_NODE_PORT=4404
      - LOG_LEVEL=INFO
      - TCP_TIMEOUT=300
      - CONFIG_WAIT_TIMEOUT=60
      - HEALTH_CHECK_ACTIVITY_TIMEOUT=300
    depends_on:
      - meshmonitor
    healthcheck:
      test: ["CMD-SHELL", "test -f /tmp/healthy && find /tmp/healthy -mmin -1 | grep -q healthy"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
```

## Configuration Options

The MQTT Proxy is configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERFACE_TYPE` | `tcp` | Connection type: `tcp` or `serial` |
| `TCP_NODE_HOST` | - | Hostname of MeshMonitor (use `meshmonitor` in Docker) |
| `TCP_NODE_PORT` | `4403` | Port of Virtual Node (use `4404` for MeshMonitor) |
| `LOG_LEVEL` | `INFO` | Logging level: `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `TCP_TIMEOUT` | `300` | TCP connection timeout in seconds |
| `CONFIG_WAIT_TIMEOUT` | `60` | Time to wait for node configuration |
| `HEALTH_CHECK_ACTIVITY_TIMEOUT` | `300` | Restart if no activity for this many seconds |
| `HEALTH_CHECK_PROBE_INTERVAL` | `60` | Send probe message if idle this long |

## Monitoring & Troubleshooting

### Checking Logs

```bash
docker compose logs mqtt-proxy -f
```

### Common Issues

#### "No localNode available"
- Ensure MeshMonitor is connected to your Meshtastic node
- Check that Virtual Node is enabled in MeshMonitor
- Verify `TCP_NODE_HOST` and `TCP_NODE_PORT` are correct

#### "MQTT not enabled on node"
- Enable MQTT in your node's configuration
- Enable "Proxy to Client" mode

#### Connection Timeouts
- Verify network connectivity between containers
- Check that your MQTT broker is accessible
- Review `TCP_TIMEOUT` and `CONFIG_WAIT_TIMEOUT` settings

#### Health Check Failures
- The proxy expects regular message activity
- If your mesh is quiet, the proxy sends periodic probes
- Check `HEALTH_CHECK_ACTIVITY_TIMEOUT` setting

### Health Status

The proxy writes a health file at `/tmp/healthy` that Docker uses for health checks. The container will restart automatically if the health check fails.

## Comparison: Node MQTT vs Proxy MQTT

| Feature | Node's Built-in MQTT | MQTT Proxy |
|---------|---------------------|------------|
| **Reliability** | Depends on node WiFi | Server-grade reliability |
| **WiFi Required** | Yes (on node) | No (can use Serial/BLE) |
| **Configuration** | On node | Read from node |
| **Mobile App Needed** | No | No |
| **Resource Usage** | Node CPU/Memory | Server CPU/Memory |
| **Debugging** | Limited logs | Full Docker logs |
| **Recovery** | Manual restart | Auto-restart via Docker |

## Security Considerations

- The MQTT Proxy runs inside your Docker network
- It inherits your node's MQTT credentials (stored on the node)
- TLS/SSL for MQTT is configured on the node, not the proxy
- The proxy only forwards messages; it doesn't store or modify them

## Related Documentation

- [Virtual Node](/configuration/virtual-node) - Required for MQTT Proxy
- [Device Configuration](/features/device#mqtt-configuration) - Node MQTT settings
- [Docker Configurator](/configurator) - Generate deployment configs
- [AI Responder](/add-ons/ai-responder) - Another community add-on by LN4CY
- [Community Add-ons Overview](/add-ons/) - All available add-ons
- [LN4CY mqtt-proxy Repository](https://github.com/LN4CY/mqtt-proxy) - Original project

## License Note

The MQTT Proxy uses the Python meshtastic library which is licensed under GPLv3. The proxy is distributed separately from MeshMonitor as a Docker image maintained by LN4CY.
