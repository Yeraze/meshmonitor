# Embedded MQTT Broker

::: tip Added in 4.6
The embedded MQTT broker and bidirectional bridges shipped in MeshMonitor 4.6 (PR [#3053](https://github.com/Yeraze/meshmonitor/pull/3053), follow-up client-proxy bridge in PR [#3054](https://github.com/Yeraze/meshmonitor/pull/3054), resolving [issue #3003](https://github.com/Yeraze/meshmonitor/issues/3003)).
:::

MeshMonitor can run its own MQTT broker inside the same container, so your Meshtastic devices (and any other MQTT clients on your network) can publish directly to MeshMonitor — and MeshMonitor can relay that traffic, with **filtering rules**, to public upstream brokers like `mqtt.meshtastic.org`.

## What problem does this solve?

Public Meshtastic brokers aggregate nodes across an entire country or continent. When a device subscribes to a broad topic (`msh/CA`, `msh/US`) with downlink enabled, its nodeDB and the RF mesh get polluted with packets from nodes hundreds of kilometres away. Per-device workarounds (narrow topics, `ignoreMqtt`) are incomplete and require firmware-version-specific config on every node.

The embedded broker shifts this fight to the server, where MeshMonitor already has full nodeDB context. You point your devices at MeshMonitor's local broker, let MeshMonitor bridge to whatever public upstreams you want, and apply filters (topic patterns, channel/node/portnum allow-block lists, **geographic bounding boxes**) at the bridge instead of on the device. The local mesh stays clean regardless of firmware version.

## Two source types

The feature adds two new source types in **Dashboard → Sources → Add Source**:

### `mqtt_broker` — the listener

A self-contained MQTT broker, backed by [Aedes](https://github.com/moscajs/aedes) (a pure-Node, MQTT 3.1.1 broker, MIT-licensed). Listens on a configurable TCP port (default `1883`) with shared username/password authentication. Decodes [`ServiceEnvelope`](https://github.com/meshtastic/protobufs/blob/master/meshtastic/mqtt.proto) packets from any client that publishes, and ingests decodable payloads (NodeInfo, Position, TextMessage, Telemetry) into the database under this source's `sourceId`.

### `mqtt_bridge` — the upstream connection

References a parent `mqtt_broker` by ID and connects to one upstream MQTT server via [MQTT.js](https://github.com/mqttjs/MQTT.js). Each bridge has independent **downlink** (upstream → local) and **uplink** (local → upstream) filter pipelines:

- **Topic patterns** (MQTT wildcards: `+` single-segment, `#` multi-segment tail)
- **Channel name** allow / block lists
- **Node ID** allow / block lists (`!xxxxxxxx`)
- **PortNum** allow / block lists ([Meshtastic PortNum enum](https://github.com/meshtastic/protobufs/blob/master/meshtastic/portnums.proto))
- **Geographic bounding box** — drop position packets whose `latitude_i / 1e7, longitude_i / 1e7` falls outside `{ minLat, maxLat, minLng, maxLng }`. Applied before republish so out-of-area positions never reach devices on the local broker.

60-second `(topic, packetId)` echo suppression on both directions prevents bridge feedback loops.

## Two ways a device can reach the broker

| Path | Firmware setup | MeshMonitor setup | When to use |
|---|---|---|---|
| **Direct TCP** | `mqtt.enabled = true`, `address = <host>:1883`, `proxy_to_client_enabled = false`, credentials match | Expose port 1883 in `docker-compose.yml` | Devices with reliable WiFi/Ethernet that can reach the MeshMonitor host on the LAN |
| **Client-proxy** | `mqtt.enabled = true`, `proxy_to_client_enabled = true`, credentials/address still set on firmware (mostly decorative in proxy mode) | Set the Meshtastic source's `mqttLink` to the embedded broker (Sources → Edit → "Bridge MQTT proxy to") | Devices without WiFi (Serial/BLE-attached), behind NAT, or on networks where port 1883 isn't reachable |

In proxy mode, the firmware uses Meshtastic's [`MqttClientProxyMessage`](https://github.com/meshtastic/protobufs/blob/master/meshtastic/mesh.proto) protocol: the device hands every outbound publish off as a `FromRadio.mqttClientProxyMessage` over its existing TCP/serial connection to MeshMonitor, and MeshMonitor publishes on its behalf. Inbound messages from the broker are wrapped as `ToRadio.MqttClientProxyMessage` and injected back to the device. This is the same mechanism the Meshtastic mobile apps use when proxying.

## Quick setup

### 1. Create the broker source

In **Dashboard → Sources → Add Source**, pick **Embedded MQTT Broker (devices connect here)** and fill in:

| Field | Notes |
|---|---|
| Name | Anything — shows in the sidebar |
| Listener port | Default `1883` ([IANA-registered MQTT port](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml?search=mqtt)) |
| Username / Password | Shared credential for all clients |
| Root topic | Default `msh` — must match what your devices publish under |

Save. MeshMonitor will start the broker; you'll see `MQTT broker listening on 0.0.0.0:1883` in the container logs and a new source card in the sidebar.

If you plan to use the **direct-TCP path**, make sure your `docker-compose.yml` exposes port 1883:

```yaml
services:
  meshmonitor:
    ports:
      - "8080:3001"
      - "1883:1883"  # Embedded MQTT broker
```

The [Docker Configurator](/configurator) has a one-click checkbox for this under section 8.

### 2. (Optional) Add bridges to public upstreams

For each upstream broker (e.g. `mqtt.meshtastic.org`, regional community brokers), pick **MQTT Bridge (forward to/from an upstream broker)** in Add Source:

| Field | Notes |
|---|---|
| Parent broker | Pick the `mqtt_broker` source created in step 1 |
| Upstream URL | `mqtt://mqtt.meshtastic.org` (or `mqtts://...:8883` for TLS) |
| Username / Password | Whatever the upstream needs (e.g. `meshdev / large4cats` for `mqtt.meshtastic.org`) |
| Upstream topics | One per line, MQTT wildcards allowed (e.g. `msh/US/FL/#`) |
| Block topics | Optional — drop publishes matching these patterns (e.g. `msh/CA/QC/#`) |
| Geographic bounding box | Optional — drop position packets outside the box |

### 3. Configure your Meshtastic devices

**Direct TCP path** — On the device (via MeshMonitor's Device → MQTT tab, the Meshtastic mobile app, or the CLI):

| Field | Value |
|---|---|
| Enabled | true |
| Address | `<MeshMonitor host LAN IP>:1883` |
| Username / Password | Same as set on the broker source |
| Root | Same as set on the broker source (default `msh`) |
| `proxy_to_client_enabled` | **false** (firmware opens the TCP socket itself) |

**Client-proxy path** — On the device:

| Field | Value |
|---|---|
| Enabled | true |
| Address | Decorative in proxy mode, but conventionally set to the broker's hostname |
| Username / Password | Decorative in proxy mode |
| `proxy_to_client_enabled` | **true** (firmware hands every publish off via the TCP API) |

Then on the Meshtastic source in MeshMonitor (**Dashboard → Sources → Edit → Bridge MQTT proxy to**), pick the embedded broker. MeshMonitor will forward `FromRadio.mqttClientProxyMessage` payloads to the broker, and inject broker messages back as `ToRadio.MqttClientProxyMessage`. The **Quick Configure** dropdown on the Device → MQTT page does all three of these things (firmware flag, firmware fields, source link) in one click.

If `proxy_to_client_enabled` is on but no `mqttLink` is set, a yellow warning banner appears on the Device → MQTT page — without it, proxy traffic from the firmware would be silently dropped.

## Comparison: embedded broker vs MQTT proxy sidecar vs node's built-in MQTT

| Concern | Node's built-in MQTT | MQTT Proxy Sidecar ([LN4CY](https://github.com/LN4CY/mqtt-proxy)) | **Embedded MQTT Broker** (this feature) |
|---|---|---|---|
| **Extra container** | No | Yes (one per node group) | No — runs inside MeshMonitor |
| **Where credentials live** | On every device | On the device (proxy reads them) | Once on the broker source; devices share creds |
| **WiFi required on device?** | Yes | No — works over Serial/BLE | Both paths supported (direct = WiFi, proxy = any) |
| **Filtering** | Limited (topic prefix, `ignoreMqtt`) | None — passthrough | **Per-bridge** allow/block lists + geo bbox, applied server-side |
| **Server-side ingestion** | None (mesh only sees the message after it lands locally) | None (sidecar is pure relay) | **Yes** — decoded NodeInfo/Position/Text/Telemetry persist under the broker's `sourceId` |
| **Multiple upstream brokers from one mesh?** | No (single config field) | No (single sidecar instance ≈ single upstream) | **Yes** — N bridges, each with independent filter rules |
| **Reliability** | Depends on node WiFi | Auto-restart via Docker | Auto-restart via Docker; broker survives bridge failures |
| **Recovery on broker outage** | Manual node restart | Manual sidecar restart | mqtt.js auto-reconnect with backoff |
| **Default-deny auth** | Per-device | Per-device | Broker refuses connections without configured username/password |
| **TLS** | Yes (on device) | Yes (on device + proxy) | **Plain TCP only in v1** (TLS / WSS deferred — track in [#3003](https://github.com/Yeraze/meshmonitor/issues/3003)) |
| **Operational visibility** | Limited firmware logs | Docker logs | Per-source `packetsIn / packetsIngested / packetsDropped / lastError` in `/api/sources/:id/status` |

### Plain-English summary

- **Node built-in MQTT** is fine if you have one node, one upstream broker, reliable WiFi, and no filtering needs.
- **MQTT Proxy Sidecar** is the right answer if you mostly want a Serial/BLE node to still reach MQTT, without writing any new MeshMonitor source config — the sidecar is essentially a "mobile app, but always on".
- **Embedded MQTT Broker** is the right answer when you want **selective bridging** (e.g. only forward msh/US/FL/PALM-BEACH traffic from `mqtt.meshtastic.org`, and only re-broadcast your own self-originated traffic), **multiple upstreams** from one local mesh, **server-side ingestion** (the bridged traffic shows up as MeshMonitor source data, not just relay-through), or you need **devices without WiFi** to publish to a broker that other LAN clients can also subscribe to. Both paths (direct TCP + client-proxy) work simultaneously — you can mix them on a per-device basis.

## Troubleshooting

### "Client proxy is enabled but no broker is linked" (yellow banner on Device → MQTT)

`proxy_to_client_enabled` is set on the firmware, but the Meshtastic source has no `mqttLink`. MeshMonitor will silently drop the proxy publishes unless:
1. You pick an embedded broker from the **Quick Configure** dropdown on Device → MQTT (one click — also stamps the link via PUT); **or**
2. You have the [MQTT Proxy Sidecar](/add-ons/mqtt-proxy) attached to this source's Virtual Node Server, which publishes to its own configured upstream.

### Broker has `clientCount: 0` but I configured a device

- Confirm port 1883 is exposed on the container (`docker port meshmonitor | grep 1883`).
- Confirm the device's `mqtt.address` resolves to the MeshMonitor host's LAN IP (not `localhost` from the device's perspective).
- Confirm the device's MQTT credentials match the broker source's `auth.username` / `auth.password`.
- The broker enforces default-deny auth: connections without configured credentials are rejected. Check the device's MQTT log for "Connection refused: Bad username or password" — if firmware logs aren't visible, watch the broker's `lastError` field on `/api/sources/:id/status`.

### `packetsIn` climbing, `packetsIngested` stays low

Most upstream traffic and most device-publish traffic is encrypted at the channel-payload level (e.g. `LongFast` PSK). MeshMonitor doesn't have those PSKs at the broker level, so the packets get **republished** (they reach other devices and bridges) but **not ingested into the DB**. `packetsDropped` counts these. This is normal — only decodable packets (NodeInfo, unencrypted Position/Telemetry, etc.) end up in `nodes` / `messages` tables under the broker's sourceId.

### Bridge reports `lastError: "Bad username or password"`

The credentials configured on the bridge don't match what the upstream accepts for an MQTT subscriber. For `mqtt.meshtastic.org`, the public subscriber credentials are `meshdev / large4cats` ([Meshtastic public MQTT docs](https://meshtastic.org/docs/configuration/module/mqtt/#default-public-server)). Other community brokers may use uplink-only credentials that don't work for raw MQTT subscribers; check with the operator.

### Deleting the broker source

If any `mqtt_bridge` source still references the broker, the delete is refused with a 409 — delete or repoint dependent bridges first.

## Limitations (v1)

- **TLS / WSS not supported** — listener is plain TCP MQTT 3.1.1 only. Deploy behind a TLS-terminating reverse proxy if you need encrypted device → broker.
- **Single shared credential per broker** — no per-device usernames in v1.
- **No persistence layer for retained messages** — the broker is ephemeral in-memory (Aedes default).
- **No MQTT 5.0** — the firmware speaks 3.1.1 anyway, so this only matters if you have non-Meshtastic MQTT clients that require v5.

## Related

- [Multi-Source Architecture](/features/multi-source) — the source-row model the broker plugs into
- [Device Configuration → MQTT](/features/device#mqtt-configuration) — the firmware-side fields and the **Quick Configure** dropdown
- [MQTT Client Proxy (sidecar)](/add-ons/mqtt-proxy) — the LN4CY-maintained alternative for Serial/BLE-only deployments
- [Docker Configurator](/configurator) — generate a `docker-compose.yml` with the right port already exposed
- [Meshtastic MQTT Module documentation](https://meshtastic.org/docs/configuration/module/mqtt/) — upstream documentation for `proxy_to_client_enabled` and the firmware-side knobs
- [`MqttClientProxyMessage` protobuf definition](https://github.com/meshtastic/protobufs/blob/master/meshtastic/mesh.proto) — wire format for the proxy path
- [`ServiceEnvelope` protobuf definition](https://github.com/meshtastic/protobufs/blob/master/meshtastic/mqtt.proto) — wire format for MQTT-published Meshtastic packets
