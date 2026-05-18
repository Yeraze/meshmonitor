---
id: news-2026-05-17-embedded-mqtt-broker
title: MeshMonitor 4.6 — Embedded MQTT Broker + Bidirectional Bridges
date: '2026-05-17T22:00:00Z'
category: feature
priority: important
minVersion: 4.6.0
---
MeshMonitor 4.6 ships its own MQTT broker. Devices can connect to MeshMonitor directly (or via the existing client-proxy path), MeshMonitor can fan that traffic out to one or more upstream public brokers, and you can attach **filter rules** to each bridge — including a geographic bounding box that drops out-of-area position packets before they ever reach your local mesh.

This is the answer to [issue #3003](https://github.com/Yeraze/meshmonitor/issues/3003): "public Meshtastic MQTT brokers aggregate nodes across an entire country, and downlink pollutes my nodeDB and my RF mesh." It landed in two PRs — [#3053](https://github.com/Yeraze/meshmonitor/pull/3053) (the broker + bridges) and [#3054](https://github.com/Yeraze/meshmonitor/pull/3054) (the `FromRadio.mqttClientProxyMessage` follow-up so devices without WiFi can also reach it).

## Two new source types

Both register the same way as your existing Meshtastic and MeshCore sources — **Dashboard → Sources → Add Source**.

**`mqtt_broker`** — an [Aedes](https://github.com/moscajs/aedes)-backed MQTT 3.1.1 listener on a port you choose (default `1883`), with shared username/password auth. Whatever publishes against it (devices, bridges, other LAN clients) gets decoded as a [`ServiceEnvelope`](https://github.com/meshtastic/protobufs/blob/master/meshtastic/mqtt.proto), and decodable payloads (NodeInfo / Position / TextMessage / Telemetry) are persisted to the database under the broker's own `sourceId`. Encrypted channel payloads pass through to other clients but aren't ingested into MeshMonitor's tables (we don't have the PSKs at the broker level).

**`mqtt_bridge`** — references one parent `mqtt_broker` and one upstream MQTT server. Each bridge has independent **downlink** and **uplink** filter pipelines:

- topic patterns (MQTT wildcards)
- channel name allow/block
- node ID allow/block
- portnum allow/block ([Meshtastic PortNum enum](https://github.com/meshtastic/protobufs/blob/master/meshtastic/portnums.proto))
- **geographic bounding box** — drop position packets whose lat/lon falls outside `{ minLat, maxLat, minLng, maxLng }`. Applied before republish, so out-of-area positions never reach devices on the local broker.

60-second `(topic, packetId)` echo suppression on both sides keeps the broker → bridge → upstream → bridge → broker path from becoming a feedback loop.

## Two ways for a device to reach the broker

**Direct TCP** — Expose port `1883` from the container (the [Docker Configurator](https://meshmonitor.org/configurator) now has a one-click checkbox under section 8), point the device's MQTT module at `<host>:1883`, plug in the shared credentials. The firmware opens the TCP socket itself, exactly the same code path it uses against any other broker — IANA-registered MQTT port, RFC-standard protocol.

**Client-proxy** — Set `proxy_to_client_enabled = true` on the firmware (defined in [`module_config.proto`](https://github.com/meshtastic/protobufs/blob/master/meshtastic/module_config.proto): _"If true, we can use the connected phone / client to proxy messages to MQTT instead of a direct connection"_), and set a Meshtastic source's `mqttLink` to the embedded broker in the UI. The firmware now hands every outbound publish to MeshMonitor as a [`FromRadio.mqttClientProxyMessage`](https://github.com/meshtastic/protobufs/blob/master/meshtastic/mesh.proto) over its existing TCP/serial connection, MeshMonitor relays to the broker, and broker messages destined for the device come back as `ToRadio.MqttClientProxyMessage`. Same protocol the Meshtastic mobile apps use when proxying.

The **Quick Configure** dropdown on the firmware MQTT page does the firmware flag, firmware-side address/creds/root, AND the source's `mqttLink` stamp in one click. A yellow warning banner appears on the Device → MQTT page if `proxy_to_client_enabled` is on but no `mqttLink` is set — the failure mode used to be silent (firmware proxies into the void), now it's visible.

## Why pick this over the existing MQTT proxy sidecar?

The [LN4CY MQTT Proxy sidecar](/add-ons/mqtt-proxy) is still a perfectly good answer if you want a pure relay — no source row, no ingestion, the proxy is essentially "an always-on mobile app" against a single upstream. The embedded broker is the right answer when you want:

- **Multiple upstream brokers from one local mesh** — N bridges, each independent. Stream to `mqtt.meshtastic.org` for the wider mesh community, to a regional community broker (`mqtt.areyoumeshingwith.us`, etc.), and to a private one, all from the same device's publishes.
- **Selective bridging** — only forward `msh/US/FL/PALM-BEACH/#` from one upstream, only forward your own positions to another, drop everything outside a 50-mile radius of your home. Filters are per-bridge, server-side, and survive firmware updates.
- **Server-side ingestion** — bridged upstream traffic shows up as MeshMonitor source data, not just relay-through. You can search messages, see node counts, run telemetry analytics on packets that came from upstream brokers, all attributed to the bridge's `sourceId`.
- **Mixed device fleet** — some devices on WiFi using direct TCP, others on Serial/BLE using client-proxy, all hitting the same broker. Both paths coexist.

The [feature documentation](https://meshmonitor.org/features/mqtt-broker) has the full comparison table and a step-by-step setup walk-through.

## What's missing in 4.6

- **TLS / WSS listener** — the broker is plain TCP MQTT 3.1.1 only. Put a TLS-terminating reverse proxy in front if you need it. (Aedes supports TLS but wiring it up cleanly in MeshMonitor's source-config model is deferred.)
- **Per-device credentials** — single shared username/password per broker. Per-device creds + ACLs would be the natural next step but aren't in v1.
- **MQTT 5.0** — Aedes is 3.1.1 only. Meshtastic firmware speaks 3.1.1 anyway, so this only matters for non-Meshtastic clients on the broker.
- **Retained-message persistence** — broker is in-memory, retained-messages don't survive a MeshMonitor restart.

## Other changes in 4.6

- **Quick Configure dropdown** on the firmware MQTT page autopopulates address, creds, and root from any configured `mqtt_broker` source — and now also flips `proxy_to_client_enabled` and stamps `mqttLink` in one click ([#3054](https://github.com/Yeraze/meshmonitor/pull/3054)).
- **Source-card watermarks** for the two new types — hub-and-spoke for the broker, two-nodes-with-bidirectional-arrow for the bridge — keep the sidebar visually consistent with the existing Meshtastic and MeshCore styling.
- **`lastError` tooltip** on sidebar status pills — a disconnected source now surfaces the actual reason on hover (`Connection refused: Bad username or password`, etc.) instead of just showing a red dot.
- **System tests fail-fast** — the test harness no longer runs all 11 sub-tests on broken state when one fails ([#3060](https://github.com/Yeraze/meshmonitor/pull/3060)). Debugging CI failures is dramatically faster.

[Read the full Embedded MQTT Broker docs](https://meshmonitor.org/features/mqtt-broker) for setup details, the side-by-side comparison against the proxy sidecar and node's built-in MQTT, troubleshooting, and current limitations.
