# Traffic Management

Traffic Management is a Meshtastic **firmware module** that polices mesh traffic directly on the node — inspecting each packet and shaping what the node relays so it consumes less airtime and channel utilization. MeshMonitor works with it from both sides: it **configures the module** (under **Configuration → Module Settings**) and **charts the telemetry** the module emits, so you can tune the settings and then watch their effect.

Because this is a device-side module, the actual packet policing happens on the node's firmware. MeshMonitor sends the module configuration to the device as an admin set-config message and renders the `TrafficManagementStats` telemetry the module broadcasts back.

## Settings reference

The settings live under **Configuration → Module Settings → Traffic Management**, grouped exactly as they appear in the UI. Enabling the module reveals the grouped sub-settings below it. In MeshMonitor's editor every toggle starts **unchecked** and every numeric field starts at **0** until the device reports its own values; the numbers below describe what each field controls.

### Enable Traffic Management

- **Enable Traffic Management** — turns the module on. Its description: *packet inspection and traffic shaping to reduce channel utilization.* When off, none of the groups below have any effect. Default: **off**.

### Position Deduplication

Drops redundant position broadcasts so the same location isn't rebroadcast repeatedly.

- **Enable** — *drop redundant position broadcasts.* Default: **off**.
- **Precision Bits (0–32)** — *number of bits of precision (geohash) for position dedup. More bits = finer granularity.* A slider from 0 to 32; a higher value treats smaller movements as distinct positions (fewer drops), a lower value dedups more aggressively.
- **Minimum Interval (seconds)** — *minimum seconds between position updates from the same node.* Positions arriving sooner than this from a given node are dropped.

### NodeInfo Direct Response

Lets the node answer NodeInfo requests from its own cache instead of forwarding them across the mesh.

- **Enable** — *respond directly to NodeInfo requests from local cache.* Default: **off**.
- **Max Hops (0–7)** — *minimum hop distance from requestor before responding from cache.* Controls how far away a requestor must be before the node answers from cache rather than relaying.

### Rate Limiting

Throttles nodes that transmit too frequently.

- **Enable** — *throttle chatty nodes.* Default: **off**.
- **Window (seconds)** — *time window for rate limiting calculations.*
- **Max Packets Per Window** — *maximum packets allowed per node within the window.* Packets beyond this count within the window are dropped.

### Drop Unknown Packets

Discards packets the node cannot decode/decrypt once a node exceeds a threshold.

- **Enable** — *drop unknown/undecryptable packets after threshold.* Default: **off**.
- **Unknown Packet Threshold** — *number of unknown packets from a node before dropping.*

### Hop Limit Exhaustion

Controls how the node handles hop limits on traffic it relays. Own packets are never affected by the exhaust toggles.

- **Exhaust Hop Limit on Relayed Telemetry** — *set hop_limit=0 on relayed telemetry broadcasts (own packets unaffected).* Stops relayed telemetry from being rebroadcast further. Default: **off**.
- **Exhaust Hop Limit on Relayed Positions** — *set hop_limit=0 on relayed position broadcasts (own packets unaffected).* Default: **off**.
- **Router Preserve Hops** — *preserve hop_limit for router-to-router traffic.* Keeps the hop limit intact between routers even when the exhaust options above are active. Default: **off**.

## Telemetry display

When the module is running, the node broadcasts a `TrafficManagementStats` telemetry packet with seven counters. MeshMonitor surfaces them as labelled, integer-valued graphs in the node's telemetry view under a shared **"Traffic Mgmt:"** group:

- **Packets inspected** — total packets the module examined
- **Position-dedup drops** — position broadcasts dropped as redundant
- **NodeInfo cache hits** — NodeInfo requests answered from local cache
- **Rate-limit drops** — packets dropped for exceeding the rate limit
- **Unknown-packet drops** — undecodable packets dropped past the threshold
- **Hop-exhausted packets** — relayed packets whose hop limit was set to 0
- **Router hops preserved** — router-to-router packets whose hop limit was kept

These plot alongside the node's other telemetry. See [Telemetry Widgets](/features/telemetry-widgets) for how the graphs are grouped and displayed.

## Firmware requirements

Traffic Management requires **Meshtastic firmware 2.7.26 or newer**. MeshMonitor gates support on the firmware version and **disables the Traffic Management section as "Unsupported by this device" below 2.7.26**.

::: warning The 2.7.22–2.7.25 silent-drop gotcha
On firmware **2.7.22 through 2.7.25** the module's admin set-config message **decodes but is silently dropped** by the device — it never persists. A save would appear to succeed but the settings would not stick. The module's AdminModule handler only shipped in **v2.7.26**, so MeshMonitor gates support at that version. (An older MeshMonitor blog post advertised "2.7.22+"; that claim is stale — 2.7.26 is the correct floor.)
:::

## Recommended starting configuration

Start conservative and tighten only once you understand how your mesh behaves:

1. **Enable the module** and turn on **Position Deduplication** with a **moderate precision** and a **moderate minimum interval** — this trims the most common source of redundant airtime (repeated position broadcasts) with little risk.
2. **Leave Rate Limiting and Drop Unknown Packets off** until you have observed your mesh's normal traffic. Both drop packets, so enabling them before you know what "normal" looks like can silently discard legitimate traffic.
3. **Be cautious with Hop Limit Exhaustion and router settings on a router node.** These affect traffic the node relays for everyone, so aggressive settings on a router **affect its neighbors' reachability**, not just the local node. Change them one at a time and watch the telemetry counters for the effect.

Use the **"Traffic Mgmt:"** telemetry graphs to confirm each change is doing what you expect before making the next one.

## Related

- [Telemetry Widgets](/features/telemetry-widgets)
- [Packet Monitor](/features/packet-monitor)
- Upstream firmware module source: <https://github.com/meshtastic/firmware/blob/develop/src/modules/TrafficManagementModule.cpp>
