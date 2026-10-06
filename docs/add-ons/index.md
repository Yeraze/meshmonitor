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

### [Mesh Screensaver](https://github.com/maxhayim/screensaver-mesh)
A screen saver that draws your mesh from live MeshMonitor data. Active nodes drift across the screen, and new messages travel between them as packets. It reads MeshMonitor's REST API and never talks to a radio. It shows no message text, node names, or node IDs. Builds exist for macOS, Windows, and Linux (XScreenSaver), plus a WebAssembly build for web pages. MIT licensed.

::: tip Early preview
Mesh Screensaver is at **v0.2.0**. Treat it as a preview. Before you install it:

- **Use a read-only user.** An API token can do whatever its creator can do. Create a user that can only read, and issue the token from that account.
- **The token sits in plain text** on your computer: in the screen saver's preferences on macOS, in the registry on Windows, and in a config file on Linux.
- **The macOS and Windows builds are not signed or notarized**, so the OS warns you the first time you open them.
- **The web build needs its page origin in [`ALLOWED_ORIGINS`](/configuration/#security-reverse-proxy-variables).** The native builds do not.
- **It polls while it runs:** every 4 seconds for new messages and every 5 minutes for nodes.
:::

**By [maxhayim](https://github.com/maxhayim/screensaver-mesh)**

### [Mesh Widget (Zebar)](https://github.com/maxhayim/widgets-pack)
A desktop widget that shows your mesh from live MeshMonitor data: node counts, the state of your local node, and the latest channel message. It never shows direct messages. The widget is part of Widgets Pack and runs in [Zebar](https://github.com/glzr-io/zebar) 3.x on Windows, macOS, and Linux. It reads MeshMonitor's REST API and never talks to a radio. MIT licensed.

To set it up:

1. Add `http://127.0.0.1:6124` to [`ALLOWED_ORIGINS`](/configuration/#security-reverse-proxy-variables) in MeshMonitor. Zebar serves widgets from that address.
2. Enter your server address and API token in the widget's settings.

::: tip Early preview
The Mesh widget ships in Widgets Pack **v1.4.3**. Treat it as a preview. Before you install it:

- **Use a read-only user.** An API token can do whatever its creator can do. Create a user that can only read, and issue the token from that account.
- **The token sits in plain text** in Zebar's storage on your computer, not in the system keychain.
- **Each open widget polls every 60 seconds** with three GET requests: `/api/v1/sources/{source}/nodes`, `/api/v1/sources/{source}/status`, and `/api/v1/sources/{source}/messages?limit=25`.
:::

**By [maxhayim](https://github.com/maxhayim/widgets-pack)**

## How Add-ons Work

An add-on reaches MeshMonitor in one of two ways. Neither kind talks to your radio: MeshMonitor holds that link.

```
┌─────────────────────────────────────────────────────┐
│                   Your Server                       │
│                                                     │
│  ┌────────────────┐     ┌────────────────────────┐  │
│  │  MeshMonitor   │     │  MQTT Proxy            │  │
│  │                │◄───►│  AI Responder          │  │
│  │  Virtual Node  │     │  (sidecars)            │  │
│  │  (port 4404)   │     └────────────────────────┘  │
│  │                │                                 │
│  │  REST API      │◄─────────────────┐              │
│  │  (/api/v1)     │                  │              │
│  └───────┬────────┘                  │              │
│          │                           │              │
└──────────┼───────────────────────────┼──────────────┘
           │ TCP (port 4403)           │ HTTP(S) + API token
           ▼                           │
   ┌───────────────┐     ┌─────────────┴──────────┐
   │  Meshtastic   │     │  CardMesh              │
   │    Node       │     │  Mesh Screensaver      │
   └───────────────┘     │  Mesh Widget           │
                         │  (REST API clients)    │
                         └────────────────────────┘
```

### Virtual Node sidecars

MQTT Proxy and AI Responder open a TCP connection to the [Virtual Node](/configuration/virtual-node) and speak the Meshtastic protocol, as a phone app does. They need:

1. **A Meshtastic TCP source with Virtual Node on.** Virtual Node is off by default and you set it per source: **Dashboard → Edit Source → Virtual Node**. See [Enabling Virtual Node on a Source](/configuration/virtual-node#enabling-virtual-node-on-a-source). MeshMonitor 4.0 removed the `ENABLE_VIRTUAL_NODE` and `VIRTUAL_NODE_PORT` environment variables; they now do nothing.
2. **The port you set there.** Most setups use 4404. Point the add-on at the same port.
3. **A network path to that port.** A sidecar in the same Docker Compose file reaches it as `meshmonitor:<port>`. Publish the port on the host only if the add-on runs somewhere else.

The [Docker Compose Configurator](/configurator) can add the MQTT Proxy to your compose file. Add the AI Responder by hand; its page has the block to paste.

### REST API clients

CardMesh, Mesh Screensaver, and Mesh Widget call the [v1 REST API](/development/api-reference) over HTTP(S). They never open the Virtual Node, so you can leave it off. They need:

1. **MeshMonitor's web address**: the one you open in a browser, with your [`BASE_URL`](/configuration/#optional-variables) path if you set one.
2. **An API token.** Sign in, open the user menu, choose **API Token**, and generate one. The client sends it as `Authorization: Bearer <token>`. Each user holds one token; a new one revokes the old.
3. **A read-only user to own the token.** A token can do whatever its creator can do. Create a user that can only read the sources the add-on needs, sign in as that user, and generate the token there.
4. **Source-scoped paths.** Mesh data lives under `/api/v1/sources/{sourceId}/…`, and `default` names the primary source. MeshMonitor 4.14 removed the old root paths such as `/api/v1/nodes`; they return `404`.
5. **An [`ALLOWED_ORIGINS`](/configuration/#security-reverse-proxy-variables) entry, for clients that run in a browser.** A web page or a widget host sends an `Origin` header, and MeshMonitor rejects origins that are not on the list. Native apps send no `Origin` header and need no entry.

Each project's README covers install steps. The [API reference](/development/api-reference) lists every endpoint, and your own server shows the same docs at `/api/v1/docs`.

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
