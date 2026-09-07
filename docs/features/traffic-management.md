# Traffic Management

Traffic Management is a Meshtastic **firmware module** that polices mesh traffic directly on the node — inspecting each packet and shaping what the node relays so it consumes less airtime and channel utilization. MeshMonitor works with it from both sides: it **configures the module** (under **Configuration → Module Settings**) and **charts the telemetry** the module emits, so you can tune the settings and then watch their effect.

Because this is a device-side module, the actual packet policing happens on the node's firmware. MeshMonitor sends the module configuration to the device as an admin set-config message and renders the `TrafficManagementStats` telemetry the module broadcasts back.

## Settings reference

The settings live under **Configuration → Module Settings → Traffic Management**, grouped exactly as they appear in the UI.

::: tip Non-zero enables, 0 disables
Traffic Management has no separate on/off checkboxes. Every setting is a number, and the firmware treats a **non-zero value as "this feature is on"** and **0 as "off"**. Turning a feature off means setting its value back to 0. The module itself is switched on by the device the first time it receives a Traffic Management config.
:::

### Position Deduplication

Drops redundant position broadcasts so the same location isn't rebroadcast repeatedly.

- **Minimum Interval (seconds)** — minimum seconds between position updates from the same node. Positions arriving sooner than this from a given node are dropped. **0 disables position deduplication.**

The precision used to decide whether two positions are "the same place" comes from the **channel's own Position Precision setting**, not from Traffic Management.

### NodeInfo Direct Response

Lets the node answer NodeInfo requests from its own cache instead of forwarding them across the mesh.

- **Max Hops (0–7)** — maximum hop distance from the requestor at which the node answers from cache rather than relaying. **0 disables direct response.**

### Rate Limiting

Throttles nodes that transmit too frequently.

- **Window (seconds)** — time window for rate limiting calculations.
- **Max Packets Per Window** — maximum packets allowed per node within the window. Packets beyond this count within the window are dropped.

Rate limiting runs **only when both values are non-zero**. Leaving either at 0 turns it off.

### Drop Unknown Packets

Discards packets the node cannot decode/decrypt once a node exceeds a threshold.

- **Unknown Packet Threshold** — number of unknown/undecryptable packets from a node within the rate window before it is dropped. **0 disables unknown-packet filtering.**

### Settings that used to be here

Meshtastic protobufs commit `d4f7ddb1` removed nine fields from `TrafficManagementConfig` and reserved their tags, because none of them had shipped in a stable release:

| Removed setting | What replaced it |
|---|---|
| Enable Traffic Management | The device's own module flag, set when it receives a Traffic Management config |
| Position Dedup → Enable | Minimum Interval > 0 |
| Position Dedup → Precision Bits | The channel's Position Precision setting |
| NodeInfo Direct Response → Enable | Max Hops > 0 |
| Rate Limiting → Enable | Window and Max Packets both > 0 |
| Drop Unknown → Enable | Unknown Packet Threshold > 0 |
| Exhaust Hop Limit on Relayed Telemetry | Removed — shelved in the firmware module itself |
| Exhaust Hop Limit on Relayed Positions | Removed — shelved in the firmware module itself |
| Router Preserve Hops | Removed — shelved in the firmware module itself |

MeshMonitor no longer shows these controls. It used to, and on 2.8 firmware they did nothing: the device treats those tags as reserved and ignores them, so the config appeared to save while nothing changed on the node.

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

Traffic Management requires **Meshtastic firmware 2.8.0 or newer**. MeshMonitor gates support on the firmware version and **disables the Traffic Management section as "Unsupported by this device" on all 2.7.x firmware**.

::: warning The 2.7.x silent-drop gotcha
The released **v2.7.26** source contains neither `TrafficManagementModule` nor the `traffic_management` AdminModule set-config handler. A 2.7.x node can decode the config message but silently drop it, making a save appear successful without persisting. MeshMonitor therefore gates support at **2.8.0**, matching Meshtastic's documented requirement.
:::

## Recommended starting configuration

Start conservative and tighten only once you understand how your mesh behaves:

1. **Start with Position Deduplication alone** — set a **moderate Minimum Interval** and leave everything else at 0. This trims the most common source of redundant airtime (repeated position broadcasts) with little risk.
2. **Leave Rate Limiting and Drop Unknown Packets at 0** until you have observed your mesh's normal traffic. Both drop packets, so enabling them before you know what "normal" looks like can silently discard legitimate traffic.
3. **Be extra careful on a router node.** These settings affect traffic the node relays for everyone, so an aggressive value on a router **affects its neighbors' reachability**, not just the local node. Change one at a time and watch the telemetry counters for the effect.

Use the **"Traffic Mgmt:"** telemetry graphs to confirm each change is doing what you expect before making the next one.

## Related

- [Telemetry Widgets](/features/telemetry-widgets)
- [Packet Monitor](/features/packet-monitor)
- Upstream firmware module source: <https://github.com/meshtastic/firmware/blob/develop/src/modules/TrafficManagementModule.cpp>
