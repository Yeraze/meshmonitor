# Embedded MQTT Broker & Bridge

::: tip Added in 4.6
The embedded MQTT broker and bidirectional bridges shipped in MeshMonitor 4.6 (PR [#3053](https://github.com/Yeraze/meshmonitor/pull/3053), follow-up client-proxy bridge in PR [#3054](https://github.com/Yeraze/meshmonitor/pull/3054), resolving [issue #3003](https://github.com/Yeraze/meshmonitor/issues/3003)). **Standalone bridges** (no parent broker required) were added in a later release ([issue #3134](https://github.com/Yeraze/meshmonitor/issues/3134)).
:::

MeshMonitor can run its own MQTT broker inside the same container, so your Meshtastic devices (and any other MQTT clients on your network) can publish directly to MeshMonitor — and MeshMonitor can relay that traffic, with **filtering rules**, to public upstream brokers like `mqtt.meshtastic.org`.

## What problem does this solve?

Public Meshtastic brokers aggregate nodes across an entire country or continent. When a device subscribes to a broad topic (`msh/CA`, `msh/US`) with downlink enabled, its nodeDB and the RF mesh get polluted with packets from nodes hundreds of kilometres away. Per-device workarounds (narrow topics, `ignoreMqtt`) are incomplete and require firmware-version-specific config on every node.

The embedded broker shifts this fight to the server, where MeshMonitor already has full nodeDB context. You point your devices at MeshMonitor's local broker, let MeshMonitor bridge to whatever public upstreams you want, and apply filters (topic patterns, channel/node/portnum allow-block lists, **geographic bounding boxes**) at the bridge instead of on the device. The local mesh stays clean regardless of firmware version.

## Two source types

The feature adds two new source types in **Dashboard → Sources → Add Source**: an `mqtt_broker` that **accepts** MQTT connections (a server), and an `mqtt_bridge` that **opens** an MQTT connection (a client). They can run together, separately, or in any combination — picking the right one (or both) is the most common configuration question, so the rest of this section walks through each in detail and ends with a side-by-side feature matrix.

### `mqtt_broker` — accept connections from devices and other MQTT clients

A self-contained MQTT broker, backed by [Aedes](https://github.com/moscajs/aedes) (a pure-Node, MQTT 3.1.1 broker, MIT-licensed). MeshMonitor opens a TCP port (default `1883`), advertises shared username/password authentication, and accepts MQTT 3.1.1 clients that connect to it.

**What it does**

- Listens on `0.0.0.0:<port>` (configurable; defaults to the IANA-registered MQTT port `1883`).
- Authenticates every CONNECT with a single shared username/password pair (default-deny: connections without configured credentials are rejected).
- Decodes [`ServiceEnvelope`](https://github.com/meshtastic/protobufs/blob/master/meshtastic/mqtt.proto) packets from any client that publishes under its `rootTopic` (default `msh`), and ingests decodable payloads (NodeInfo, Position, TextMessage, Telemetry) into the database under this source's `sourceId`. Other clients subscribed to the broker still see the raw byte-for-byte publish, so devices can fan out to each other over MQTT just like they would on a public broker.
- Optionally clamps `hop_limit` to `0` on every Meshtastic packet it delivers to a connected client ("Zero-hop injection" — see below), matching `mqtt.meshtastic.org`'s behavior so MQTT-bridged packets don't trigger RF re-broadcasts.
- Generates a synthetic gateway identity (`nodeNum`, `!nodeId`, longName, shortName) at create time so its publishes look like they're coming from a real node to upstream brokers.

**When to use a broker**

- You want **multiple devices** to share a single set of MQTT credentials and converge on MeshMonitor instead of each holding its own upstream credentials.
- You want **other LAN clients** (Home Assistant, Grafana, custom scripts) to subscribe to the same Meshtastic traffic without setting up a separate broker.
- You need **server-side ingestion** of locally-published traffic — every NodeInfo / Position / Telemetry your devices publish via MQTT lands in the database under this source's `sourceId`, with no extra wiring.

### `mqtt_bridge` — open a connection to an upstream broker

A long-lived MQTT client, backed by [MQTT.js](https://github.com/mqttjs/MQTT.js). MeshMonitor opens a connection out to one upstream MQTT server (`mqtt.meshtastic.org`, a regional community broker, your own private one), subscribes to a list of topics, and decodes whatever comes back.

**What it does**

- Connects to one upstream URL (`mqtt://…` for plain TCP, `mqtts://…:8883` for TLS) with optional username/password.
- Subscribes to a configured list of upstream topics (MQTT wildcards: `+` single-segment, `#` multi-segment tail).
- Decodes inbound `ServiceEnvelope` packets and ingests them into the database under this bridge's `sourceId` — so traffic the bridge receives from upstream shows up as its own MeshMonitor source.
- Applies an **independent downlink filter pipeline** before ingestion and republish:
  - **Topic patterns** — allow / block lists
  - **Channel name** — allow / block lists
  - **Node ID** — allow / block lists (`!xxxxxxxx`)
  - **PortNum** — allow / block lists ([Meshtastic PortNum enum](https://github.com/meshtastic/protobufs/blob/master/meshtastic/portnums.proto))
  - **Geographic bounding box** — drop position packets whose `latitude_i / 1e7, longitude_i / 1e7` falls outside `{ minLat, maxLat, minLng, maxLng }`. Applied before republish so out-of-area positions never reach the local broker (when attached) or are injected into a device (when used as a client-proxy target).
- Optionally rewrites topics on republish via `downlinkTopicRewrite` / `uplinkTopicRewrite` ([Topic rewriting](#topic-rewriting)) for bridging between meshes that publish under different MQTT roots.
- Surfaces broker ACL state — if the upstream rejects authentication or denies your subscriptions, the bridge status shows `permissionMessage` so you know why traffic isn't flowing.
- 60-second `(topic, packetId)` echo suppression on both directions prevents bridge feedback loops.

**Two modes — with or without a parent broker**

A bridge can run in either of two configurations, picked when you create it ("Parent broker (optional)" dropdown):

1. **Attached to a parent `mqtt_broker`** (the default before the standalone option was added). In this mode the bridge is bidirectional:
   - **Downlink** (upstream → local broker): ingests, applies the downlink filter pipeline, and republishes raw bytes onto the parent broker so locally-connected devices see the same wire format.
   - **Uplink** (local broker → upstream): listens to the parent broker's `local-packet` event, applies an independent **uplink filter pipeline** (same filter shapes as downlink), and publishes raw bytes to the upstream broker.
2. **Standalone** — no parent broker. The bridge runs as a pure MQTT client. Downlink still ingests; there's no local republish (no local broker to republish to) and no uplink event source. The bridge can still **act as a client-proxy target** for a `meshtastic_tcp` source's `mqttLink`: device traffic flows `device → MeshMonitor → bridge.publish() → upstream`, with no embedded broker in between.

**When to use a bridge**

- **Attached**: you have an embedded broker hosting one or more local devices and you want their traffic to fan out upstream — and/or you want upstream traffic from a curated topic set to reach those devices.
- **Standalone, monitoring**: you want to watch what flows on an upstream broker (e.g. `mqtt.meshtastic.org` for a regional area) without hosting any local MQTT clients. The bridge subscribes, ingests, and persists; that data shows up as its own source in the sidebar.
- **Standalone, client-proxy target**: you have a Meshtastic device in `proxy_to_client` mode and you want its MQTT traffic forwarded straight upstream without an intermediate embedded broker. The Meshtastic source's `mqttLink` points at the bridge directly. This is the **MQTT-client-proxy** use case ([issue #3134](https://github.com/Yeraze/meshmonitor/issues/3134)).

**Direction — bridge `mode` dropdown**

Independent of the attached/standalone choice, every bridge has a **Mode** dropdown that controls which direction(s) it talks to the upstream broker:

| Mode | Upstream `SUBSCRIBE` | Uplink `PUBLISH` | Use case |
|---|---|---|---|
| `bidirectional` (default) | Yes | Yes | Default behavior — full round-trip bridging. |
| `publish_only` | **Skipped** entirely — never sends a `SUBSCRIBE` packet, and `SUBACK`-denied warnings are suppressed | Yes | Public/curated brokers (e.g. `mqtt.meshtastic.org`) that accept `PUBLISH` from gateways but ACL-reject `SUBSCRIBE`. Stops the `permission-denied` log spam without losing the publish path. |
| `subscribe_only` | Yes | **Refused** — the parent broker's `local-packet` listener is never bound, and explicit `publish()` calls throw `subscribe_only — publish refused` | Read-only monitoring of an upstream feed where you must not echo any local traffic outbound. |

The field is stored in the bridge's `config.mode` JSON field; omitting it (or storing `bidirectional`) preserves pre-existing behavior so older rows keep working without migration.

### Broker vs Bridge — feature matrix

| Capability | `mqtt_broker` | `mqtt_bridge` (attached) | `mqtt_bridge` (standalone) |
|---|---|---|---|
| **Role** | MQTT server — accepts connections | MQTT client — opens one connection | MQTT client — opens one connection |
| **Opens a TCP listener port?** | Yes (configurable, default `1883`) | No | No |
| **Connects to an upstream broker?** | No (it _is_ the broker) | Yes (one per bridge) | Yes (one per bridge) |
| **Locally-connected MQTT clients (devices, LAN apps)?** | Yes, many | Via the parent broker | No |
| **Multiple upstream brokers?** | n/a | Yes — N bridges, each independent | Yes — N bridges, each independent |
| **Per-source filter pipeline (topic / channel / node / portnum / geo)?** | No (broker is dumb relay) | **Yes** — downlink _and_ uplink | **Yes** — downlink only |
| **Topic rewriting (cross-root bridging)?** | No | **Yes** — `downlinkTopicRewrite` + `uplinkTopicRewrite` ([details](#topic-rewriting)) | No (requires parent broker) |
| **Server-side ingestion of decoded packets?** | Yes — under broker `sourceId` | Yes — under bridge `sourceId` (downlink) | Yes — under bridge `sourceId` (downlink) |
| **Echo suppression (no feedback loops)?** | n/a | Yes (60s `topic+packetId` cache) | Yes |
| **Zero-hop injection toggle?** | Yes ([details](#zero-hop-injection)) | n/a | n/a |
| **Synthetic gateway identity for outbound publishes?** | Yes (auto-generated at create) | Inherited from parent broker | n/a (no outbound until used as proxy target) |
| **Default-deny authentication on the listener?** | Yes | n/a | n/a |
| **Can serve as a `mqttLink` client-proxy target?** | Yes | Yes | **Yes** — primary use case |
| **TLS / WSS?** | Plain TCP only in v1 | `mqtts://` upstream supported | `mqtts://` upstream supported |
| **Survives a sibling source restart?** | Independent — broker keeps listening if a bridge restarts | Detaches if parent broker stops; reattaches when it comes back | Independent — runs without any sibling |
| **Status fields on `/api/sources/:id/status`** | `listening`, `clientCount`, `packetsIn`, `packetsIngested`, `packetsDropped`, `lastError` | `upstreamConnected`, `parentBrokerAttached`, `downlinkIn`, `downlinkIngested`, `downlinkRepublished`, `uplinkOut`, downlink/uplink drop counters, `permissionMessage` | Same as attached, but `parentBrokerAttached: false` and `uplinkOut` stays at 0 |
| **Required pair?** | Standalone — no bridge required | Requires a sibling `mqtt_broker` | None |

### Use-case recipes

- **"Filtered window onto the public Meshtastic broker."** Create one **standalone bridge** to `mqtt://mqtt.meshtastic.org` with a topic pattern and geo bbox that matches your region. No broker needed. You get a sidebar source whose nodes / messages / positions are sourced from upstream, filtered before ingestion.
- **"My devices on the LAN should fan out to each other, plus selectively reach a public broker."** Create one **broker** + one **attached bridge**. Devices connect to the broker (direct TCP or client-proxy). The bridge applies a filter pipeline in both directions and forwards the selected slice upstream.
- **"My BLE-only node should publish MQTT through MeshMonitor straight to a public broker, no embedded broker required."** Create one **standalone bridge** pointed at the public broker. On the Meshtastic source, set `mqttLink → <bridge>` (Sources → Edit → "Bridge MQTT proxy to", or use the Quick Configure dropdown on Device → MQTT). Enable `proxy_to_client_enabled` on the firmware. Device → MeshMonitor (over BLE/serial) → bridge → upstream.
- **"Same as above, plus I want a Home Assistant box on the LAN to subscribe to my devices."** Create one **broker** + one **attached bridge**. Devices use client-proxy mode pointing at the broker; Home Assistant subscribes to the broker on port 1883. Bridge handles the upstream fan-out.
- **"Two upstream brokers, one regional and one global, with different filters per upstream."** Create one **broker** + **two attached bridges**, each with its own topic/geo/portnum rules. Devices publish once; each bridge independently decides what to forward.
- **"Cross-mesh routing between two MQTT roots (e.g. our LA mesh on `msh/US/LA` and the Houston mesh on `msh/US/TX`)."** Create one **broker** + one **attached bridge** to the foreign upstream. Set the bridge's downlink rewrite `msh/US/TX → msh/US/LA` and uplink rewrite `msh/US/LA → msh/US/TX` so the foreign-root traffic appears under your local root (and vice versa). See [Topic rewriting](#topic-rewriting) below for the details and caveats (PSK match, zero-hop, loop suppression).

## Three ways a device can reach MQTT through MeshMonitor

| Path | Firmware setup | MeshMonitor setup | When to use |
|---|---|---|---|
| **Direct TCP to broker** | `mqtt.enabled = true`, `address = <host>:1883`, `proxy_to_client_enabled = false`, credentials match | Create an `mqtt_broker` source; expose port 1883 in `docker-compose.yml` | Devices with reliable WiFi/Ethernet that can reach the MeshMonitor host on the LAN |
| **Client-proxy → broker** | `mqtt.enabled = true`, `proxy_to_client_enabled = true`, credentials/address still set on firmware (mostly decorative in proxy mode) | Create an `mqtt_broker` source; set the Meshtastic source's `mqttLink` to the broker (Sources → Edit → "Bridge MQTT proxy to") | Devices without WiFi (Serial/BLE-attached), behind NAT, or on networks where port 1883 isn't reachable — and you also want **other LAN clients** to subscribe to the embedded broker |
| **Client-proxy → standalone bridge** | Same firmware setup as above (`proxy_to_client_enabled = true`) | Create a **standalone** `mqtt_bridge` (no parent broker); set the Meshtastic source's `mqttLink` to the **bridge** | Same connectivity scenarios as client-proxy → broker, but you don't need a local broker — device traffic goes straight upstream through the bridge ([issue #3134](https://github.com/Yeraze/meshmonitor/issues/3134)) |

In proxy mode, the firmware uses Meshtastic's [`MqttClientProxyMessage`](https://github.com/meshtastic/protobufs/blob/master/meshtastic/mesh.proto) protocol: the device hands every outbound publish off as a `FromRadio.mqttClientProxyMessage` over its existing TCP/serial connection to MeshMonitor, and MeshMonitor publishes on its behalf. Inbound messages from the linked target (broker or bridge) are wrapped as `ToRadio.MqttClientProxyMessage` and injected back to the device. This is the same mechanism the Meshtastic mobile apps use when proxying.

The Device → MQTT **Quick Configure** dropdown lists both brokers and bridges with type tags so you can pick either in one click; for bridges it parses the upstream URL into the firmware's MQTT address field so the device's local config reflects where its traffic is actually going.

## Quick setup

### 1. Create the broker source

In **Dashboard → Sources → Add Source**, pick **Embedded MQTT Broker (devices connect here)** and fill in:

| Field | Notes |
|---|---|
| Name | Anything — shows in the sidebar |
| Listener port | Default `1883` ([IANA-registered MQTT port](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml?search=mqtt)) |
| Username / Password | Shared credential for all clients |
| Root topic | Default `msh` — must match what your devices publish under |
| Zero-hop injection | Off by default. When on, the broker clamps `hop_limit` to `0` on every Meshtastic packet it delivers to a connected device — matching the behavior of [Meshtastic's public broker](https://meshtastic.org/docs/software/integrations/mqtt/). See [Zero-hop injection](#zero-hop-injection) below for when to use it. |

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
| Parent broker (optional) | Pick the `mqtt_broker` source from step 1 to make this an **attached** bridge, or leave as **"None — standalone client proxy"** for a pure upstream client. See [Two source types](#two-source-types) for which to pick. |
| Upstream URL | `mqtt://mqtt.meshtastic.org` (or `mqtts://...:8883` for TLS) |
| Username / Password | Whatever the upstream needs (e.g. `meshdev / large4cats` for `mqtt.meshtastic.org`) |
| Upstream topics | One per line, MQTT wildcards allowed (e.g. `msh/US/FL/#`) |
| Block topics | Optional — drop publishes matching these patterns (e.g. `msh/CA/QC/#`) |
| Geographic bounding box | Optional — drop position packets outside the box |

A standalone bridge is the right starting point when you have **no embedded broker** (pure upstream monitoring) or when you plan to wire a Meshtastic source's `mqttLink` directly at the bridge for client-proxy traffic — both are also covered in [Use-case recipes](#use-case-recipes) above.

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
| Address | Decorative in proxy mode, but conventionally set to the broker (or bridge upstream) hostname |
| Username / Password | Decorative in proxy mode |
| `proxy_to_client_enabled` | **true** (firmware hands every publish off via the TCP API) |

Then on the Meshtastic source in MeshMonitor (**Dashboard → Sources → Edit → Bridge MQTT proxy to**), pick either an embedded broker or a bridge as the target. The **Quick Configure** dropdown on the Device → MQTT page does all three of these things (firmware flag, firmware fields, source link) in one click and shows the target type next to the name.

- Picking a **broker** routes the device's MQTT traffic into the embedded broker (and from there, optionally onward via any attached bridge). Other LAN clients connected to the broker also see this traffic.
- Picking a **bridge** (typically a standalone one) routes the device's MQTT traffic straight to that bridge's upstream connection with no embedded broker in between. Useful when you have no other local MQTT clients.

In both cases MeshMonitor forwards `FromRadio.mqttClientProxyMessage` payloads to the target's MQTT layer, and injects the target's inbound MQTT traffic back to the device as `ToRadio.MqttClientProxyMessage`.

If `proxy_to_client_enabled` is on but no `mqttLink` is set, a yellow warning banner appears on the Device → MQTT page — without it, proxy traffic from the firmware would be silently dropped.

## Topic rewriting

::: tip Added in 4.7
Bridge **topic rewriting** ships in 4.7 ([issue #3166](https://github.com/Yeraze/meshmonitor/issues/3166)), driven by [discussion #3159](https://github.com/Yeraze/meshmonitor/discussions/3159) — operators bridging between meshes that publish under different MQTT root topics.
:::

By default an `mqtt_bridge` is a byte-for-byte relay — it republishes inbound traffic to the parent broker on the same topic, and forwards outbound traffic upstream on the same topic. That works when both ends use the same root, but breaks when the two ends use different roots (e.g. your LA mesh publishes under `msh/US/LA` while the Houston public mesh uses `msh/US/TX`). Locally-attached LA devices subscribe to `msh/US/LA/#`, so they never see `msh/US/TX/...` republishes — the traffic is ingested into the database fine, but never crosses to RF.

**Topic rewriting** adds a literal prefix-replacement step on each direction of the bridge:

| Field | Direction | Effect |
|---|---|---|
| `downlinkTopicRewrite` | upstream → parent broker | Republish an inbound topic on the parent broker under a different prefix, so locally-subscribed devices see it. |
| `uplinkTopicRewrite` | parent broker → upstream | Publish a parent-broker topic upstream under a different prefix, so the foreign mesh sees your local traffic. |

Each rule is `{ from, to }` — literal prefix match (no MQTT `+` / `#` wildcards), trailing slashes normalized away. Configured from the bridge's dedicated **Configuration page** (select the `mqtt_bridge` source in the sidebar → **Configuration** → **Topic rewrites** section). As of 4.8.3 the per-source bridge edit modal is slimmed to connection basics and deep-links to this Configuration page, which hosts the full set of bridge controls (Connection, Forwarding, Subscribe, Publish + advanced topic filter, and Topic rewrites). Equivalent fields are also accepted via the source API on the bridge itself (`PUT /api/sources/<bridgeId>` with `config.downlinkTopicRewrite` and `config.uplinkTopicRewrite`).

### Example — LA ↔ TX cross-mesh bridge

Local mesh on `msh/US/LA`, Houston public mesh on `mqtt.meshtastic.org` under `msh/US/TX`. Operator wants the two meshes to see each other's traffic on RF.

1. Run the embedded broker with `rootTopic = msh/US/LA` (or `msh`).
2. Create an attached `mqtt_bridge` to `mqtt://mqtt.meshtastic.org` subscribed to `msh/US/TX/#`.
3. Configure the rewrite rules:

```yaml
downlinkTopicRewrite:
  from: msh/US/TX        # foreign root
  to:   msh/US/LA        # local root — what LA devices subscribe to
uplinkTopicRewrite:
  from: msh/US/LA        # local root — what LA devices publish under
  to:   msh/US/TX        # foreign root — what Houston subscribers see
```

4. Optionally pair with a **geographic bounding box** in the downlink filter to drop TX traffic from outside the area you care about, and **Zero-hop injection** on the broker to keep the bridged packets from triggering extra RF hops.

Filters run on the original (pre-rewrite) topic; the rewrite only changes what gets published. Ingestion records and the bridge's `local-packet` event also use the original topic, so dashboards stay accurate.

### Loop suppression

Echo suppression is keyed on the **post-rewrite** topic — so an inbound TX packet republished to the parent broker as `msh/US/LA/...` is recorded under that rewritten topic. When the parent broker re-emits the same packet through the uplink path, the bridge sees `msh/US/LA/...` + the same packetId in the downlink echo cache and suppresses the uplink. The reverse direction works the same way. The existing 60-second `(topic, packetId)` cache covers it; no new infrastructure was needed.

### Caveats

::: warning Read before deploying
- **PSKs must match.** Topic rewriting moves bytes, not encryption. If the two meshes use different channel PSKs, the relayed packets arrive at devices on the other side as undecodable noise.
- **Filter the firehose first.** Without a topic block-list, channel allow-list, portnum allow-list, or **geographic bounding box** in the downlink filter, dropping the entire `msh/US/TX/#` into a local mesh can saturate RF.
- **Pair with Zero-hop injection** on the broker. Without it, inbound foreign-mesh packets arrive carrying their original `hop_limit` and devices on the receiving side will re-broadcast them over RF — re-flooding the foreign mesh's traffic across your local airwaves.
- **Standalone bridges cannot rewrite.** A bridge without a parent broker has no parent-broker republish path (downlink) and no `local-packet` event source (uplink), so rewriting would silently do nothing. The validator rejects rewrite fields on standalone bridges.
- **No wildcards.** `from` / `to` are literal prefixes only. `msh/US/+` is rejected by the validator.
- **Single rule per direction.** v1 supports one `{from, to}` per direction. Folding multiple foreign roots into one local root (`msh/US/TX/* → msh/US/LA/*` AND `msh/CA/QC/* → msh/US/LA/*`) would need separate bridges today.
:::

## Zero-hop injection

::: tip Added in 4.6.3
The **Zero-hop injection** toggle on the broker source ships in 4.6.3 ([issue #3084](https://github.com/Yeraze/meshmonitor/issues/3084)).
:::

Meshtastic's public broker at `mqtt.meshtastic.org` overwrites the `hop_limit` field on every packet it re-publishes to its MQTT clients, setting it to `0`. Devices that receive a packet via MQTT therefore see "no hops remaining" and skip the RF re-broadcast — the firmware enforces a max of 7 hops (10 on older firmware), so without this clamp an MQTT-bridged packet can flood several RF rings before dying out.

If you run a private broker and bridge it to public upstreams, you may want the same behavior. **Zero-hop injection** is an opt-in toggle on the `mqtt_broker` source that does exactly this:

- **Disabled (default)** — packets are forwarded byte-for-byte. Use this for fully private setups where you actually want MQTT-bridged packets to take additional RF hops (small isolated mesh, deliberate fan-out).
- **Enabled** — the broker decodes each Meshtastic `ServiceEnvelope` it delivers to a connected client, clamps `hop_limit` to `0`, and re-encodes. `hop_start` is preserved so receivers can still compute "how far has this travelled". Mirrors Meshtastic's public broker so private deployments behave the same way.

Implementation notes:

- The clamp only applies to packets the broker **delivers to its MQTT subscribers** (devices, sidecars, anything that connected to your `mqtt_broker` listener). The original `hop_limit` is preserved in:
  - The MeshMonitor database (so hop diagnostics stay accurate)
  - The payload re-published upstream via any attached `mqtt_bridge` (so the next broker in the chain sees the original value)
- Topics outside the broker's `rootTopic` (e.g. non-Meshtastic publishes), non-decodable payloads, and packets that already have `hop_limit == 0` are passed through unchanged.

If you're seeing your private broker flood the mesh after attaching a bridge to a public upstream, this toggle is almost certainly what you want.

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
| **Zero-hop injection** | n/a (no broker) | n/a (passthrough relay) | **Optional per broker** — clamp `hop_limit` to 0 on delivery to match public-broker behavior ([details](#zero-hop-injection)) |
| **Operational visibility** | Limited firmware logs | Docker logs | Per-source `packetsIn / packetsIngested / packetsDropped / lastError` in `/api/sources/:id/status` |

### Plain-English summary

- **Node built-in MQTT** is fine if you have one node, one upstream broker, reliable WiFi, and no filtering needs.
- **MQTT Proxy Sidecar** is the right answer if you mostly want a Serial/BLE node to still reach MQTT, without writing any new MeshMonitor source config — the sidecar is essentially a "mobile app, but always on".
- **Embedded MQTT Broker** is the right answer when you want **selective bridging** (e.g. only forward msh/US/FL/PALM-BEACH traffic from `mqtt.meshtastic.org`, and only re-broadcast your own self-originated traffic), **multiple upstreams** from one local mesh, **server-side ingestion** (the bridged traffic shows up as MeshMonitor source data, not just relay-through), or you need **devices without WiFi** to publish to a broker that other LAN clients can also subscribe to. Both paths (direct TCP + client-proxy) work simultaneously — you can mix them on a per-device basis.
- **Standalone MQTT Bridge** (no parent broker) is the right answer when you _don't_ need a local broker at all: either because you just want to **monitor** an upstream broker like `mqtt.meshtastic.org` without hosting anything, or because you have a single BLE/serial Meshtastic device in `proxy_to_client` mode whose MQTT traffic should go **straight upstream** with no intermediate broker. It's a smaller surface area than a broker + attached bridge — one source, one outbound TCP connection, no listener port to expose.

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

### A known node is missing from the map / messages, but its packets show up as "geo-ignored"

MeshMonitor supports a per-source **geo-ignore** membership model for MQTT: nodes reporting a position outside your configured coverage area can be automatically ignored so noisy public/community brokers don't flood your map with distant traffic. If a node you expect to see is missing:

- Check the [MQTT Packet Monitor](/features/packet-monitor#mqtt-sources) — copies dropped by this filter are still captured and flagged with a `geo-ignored` outcome badge, so you can confirm this is what happened to a specific packet.
- Review and manage the resulting entries in this source's **Edit Source → Automation → Ignored Nodes** list — geo-ignored nodes show a **Geo filter** badge (as opposed to a manually-ignored node), and can be un-ignored from there like any other ignored node.
- A node that moves back inside the coverage area is automatically un-ignored on a later packet — you don't need to intervene unless you want to.

### `packetsIn` climbing, `packetsIngested` stays low

Most upstream traffic and most device-publish traffic is encrypted at the channel-payload level (e.g. `LongFast` PSK). MeshMonitor doesn't have those PSKs at the broker level, so the packets get **republished** (they reach other devices and bridges) but **not ingested into the DB**. `packetsDropped` counts these. This is normal — only decodable packets (NodeInfo, unencrypted Position/Telemetry, etc.) end up in `nodes` / `messages` tables under the broker's sourceId.

### Bridge reports `lastError: "Bad username or password"`

The credentials configured on the bridge don't match what the upstream accepts for an MQTT subscriber. For `mqtt.meshtastic.org`, the public subscriber credentials are `meshdev / large4cats` ([Meshtastic public MQTT docs](https://meshtastic.org/docs/configuration/module/mqtt/#default-public-server)). Other community brokers may use uplink-only credentials that don't work for raw MQTT subscribers; check with the operator.

### Deleting the broker source

Deleting an `mqtt_broker` that has dependent `mqtt_bridge` sources pointing at it **auto-detaches** the bridges instead of refusing the delete ([issue #3134](https://github.com/Yeraze/meshmonitor/issues/3134)). Each dependent bridge has its `brokerSourceId` cleared (it becomes a **standalone** bridge), and any enabled bridge is restarted with the new config; then the broker is removed. Standalone bridges are valid — they keep ingesting upstream and can still act as `mqttLink` client-proxy targets.

If you also want the dependent bridges gone, delete them after the broker, or before — bridges don't require a parent.

::: warning Pre-4.7 behavior
Releases that shipped before the standalone-bridge feature refused this delete with a `409 Conflict` listing the dependent bridges. Repoint or delete those bridges first when running an older version.
:::

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
