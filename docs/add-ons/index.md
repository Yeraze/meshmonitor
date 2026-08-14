# Community Add-ons

Community add-ons are third-party projects that extend MeshMonitor's capabilities. They integrate in one of two ways:

- **Virtual Node sidecars** connect to MeshMonitor's [Virtual Node](/configuration/virtual-node) (TCP port 4404) and speak the Meshtastic protobuf protocol, acting like another client of your mesh.
- **REST API clients** call MeshMonitor's [v1 REST API](/development/api-reference) with an API token, reading and sending through the data MeshMonitor already collects.

::: warning Third-Party Projects
These add-ons are developed and maintained by outside contributors, not the MeshMonitor team. While we've tested them and include them in our documentation, please direct bug reports and feature requests to each project's own repository.
:::

## Virtual Node Sidecars

### [MQTT Client Proxy](/add-ons/mqtt-proxy)
Route MQTT traffic through MeshMonitor instead of relying on your node's WiFi connection. Ideal for nodes with unreliable WiFi, serial/BLE-connected devices, or when you want server-grade MQTT reliability.

**By [LN4CY](https://github.com/LN4CY/mqtt-proxy)**

### [AI Responder](/add-ons/ai-responder)
Transform your Meshtastic node into an AI-powered assistant. Users on the mesh can ask questions, have conversations, and get intelligent responses through multiple AI providers (Ollama, Gemini, OpenAI, Anthropic).

**By [LN4CY](https://github.com/LN4CY/ai-responder)**

## REST API Clients

### [CardMesh](https://github.com/maxhayim/cardmeshformeshmonitor)
A keyboard-first pocket client for the [M5Stack CardputerZero](https://shop.m5stack.com/), turning it into a handheld console for your mesh. CardMesh talks to MeshMonitor's REST API rather than to a radio directly, so MeshMonitor keeps handling the connections, storage, and history while the CardputerZero is a compact field terminal.

::: tip Early preview
CardMesh is at **v0.1.0** and under active development. The dashboard is implemented; messaging, node browsing, and the remaining screens are still in progress. Treat it as a preview rather than a finished client.
:::

**By [maxhayim](https://github.com/maxhayim/cardmeshformeshmonitor)**

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

Pick the integration style that matches what you're building.

### As a Virtual Node sidecar

Best when your add-on needs to behave like another node on the mesh, sending and receiving packets directly.

1. **Connect via TCP** to the Virtual Node port (default 4404)
2. **Use the Meshtastic protobuf protocol**, the same protocol used by official Meshtastic mobile apps
3. **Libraries**: Use the official [meshtastic Python library](https://github.com/meshtastic/python) or any client that speaks the Meshtastic TCP protocol
4. **Reference**: See the [official protobuf definitions](https://github.com/meshtastic/protobufs/) for message formats

### As a REST API client

Best when your add-on wants the data MeshMonitor has already collected, nodes, messages, telemetry, traceroutes, without re-implementing any protocol handling. This also works across every source type, not just Meshtastic.

1. **Create an API token** in MeshMonitor and send it as `Authorization: Bearer <token>`
2. **Discover sources** with `GET /api/v1/sources`, then use the source-scoped routes:
   `/api/v1/sources/{sourceId}/` + `nodes`, `messages`, `channels`, `telemetry`, `traceroutes`, `network`, `packets`, `status`, `actions`
3. **`default` works as a sourceId alias** for the primary source, so single-source setups don't have to look one up first
4. **Reference**: the [API reference](/development/api-reference), the endpoint-by-endpoint [REST_API.md](https://github.com/Yeraze/meshmonitor/blob/main/docs/api/REST_API.md), and the OpenAPI spec served at `/api/v1/docs`

::: warning API tokens inherit their owner's permissions
A token is not independently scoped, it can do whatever the user who created it can do. For a device that leaves the house, create a dedicated user with only the permissions the add-on needs rather than issuing a token from an admin account.
:::

Want your add-on listed here? Open a [discussion on GitHub](https://github.com/yeraze/meshmonitor/discussions)!
