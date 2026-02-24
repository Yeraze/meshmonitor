# Community Add-ons

Community add-ons are third-party sidecar containers that extend MeshMonitor's capabilities. They connect to MeshMonitor's [Virtual Node](/configuration/virtual-node) (TCP port 4404) to interact with your Meshtastic mesh network.

::: warning Third-Party Projects
These add-ons are developed and maintained by outside contributors, not the MeshMonitor team. While we've tested them and include them in our documentation, please direct bug reports and feature requests to each project's own repository.
:::

## Available Add-ons

### [MQTT Client Proxy](/add-ons/mqtt-proxy)
Route MQTT traffic through MeshMonitor instead of relying on your node's WiFi connection. Ideal for nodes with unreliable WiFi, serial/BLE-connected devices, or when you want server-grade MQTT reliability.

**By [LN4CY](https://github.com/LN4CY/mqtt-proxy)**

### [AI Responder](/add-ons/ai-responder)
Transform your Meshtastic node into an AI-powered assistant. Users on the mesh can ask questions, have conversations, and get intelligent responses through multiple AI providers (Ollama, Gemini, OpenAI, Anthropic).

**By [LN4CY](https://github.com/LN4CY/ai-responder)**

## How Add-ons Work

All community add-ons connect to MeshMonitor through the Virtual Node server:

```
┌─────────────────────────────────────────────────────┐
│                   Your Server                       │
│                                                     │
│  ┌────────────────┐     ┌────────────────────────┐  │
│  │  MeshMonitor   │◄───►│  MQTT Proxy            │  │
│  │                │     │  (sidecar)             │  │
│  │  Virtual Node  │     └────────────────────────┘  │
│  │  (port 4404)   │                                 │
│  │                │     ┌────────────────────────┐  │
│  │                │◄───►│  AI Responder          │  │
│  │                │     │  (sidecar)             │  │
│  └───────┬────────┘     └────────────────────────┘  │
│          │                                          │
└──────────┼──────────────────────────────────────────┘
           │ TCP (port 4403)
           ▼
   ┌───────────────┐
   │  Meshtastic   │
   │    Node       │
   └───────────────┘
```

### Prerequisites

All add-ons require:
1. **Virtual Node enabled** in MeshMonitor (`ENABLE_VIRTUAL_NODE=true`)
2. **Virtual Node port exposed** (default: 4404)
3. **Docker networking** so sidecar containers can reach MeshMonitor

### Deploying Add-ons

The easiest way to deploy add-ons is with the [Docker Compose Configurator](/configurator), which can generate the appropriate configuration. You can also add them manually to your existing `docker-compose.yml`.

## Building Your Own Add-on

If you're interested in building a sidecar that integrates with MeshMonitor:

1. **Connect via TCP** to the Virtual Node port (default 4404)
2. **Use the Meshtastic protobuf protocol** — the same protocol used by official Meshtastic mobile apps
3. **Libraries**: Use the official [meshtastic Python library](https://github.com/meshtastic/python) or any client that speaks the Meshtastic TCP protocol
4. **Reference**: See the [official protobuf definitions](https://github.com/meshtastic/protobufs/) for message formats

Want your add-on listed here? Open a [discussion on GitHub](https://github.com/yeraze/meshmonitor/discussions)!
