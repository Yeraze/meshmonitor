# Receive-Only Mode

::: tip Added in 4.14 (#4294)
Run a Meshtastic source with its radio's transmitter turned off — a legitimate, supported
listen-only configuration for gateways, monitoring stations, and MQTT relays that should never
key the radio.
:::

## What it is

Receive-only mode is what happens when a Meshtastic source's LoRa configuration has **TX
Enabled** turned off (`lora.txEnabled = false`). This maps directly to a hard kill switch in the
Meshtastic firmware itself (`RadioLibInterface.cpp`): every outbound LoRa packet is dropped at
the radio driver before it reaches the air. It isn't a MeshMonitor-side restriction — the device
will refuse to transmit no matter which client talks to it.

Common reasons to run a node this way:

- A **listen-only gateway** feeding packets into MQTT or another aggregator, with no business
  keying the radio
- Regulatory or spectrum constraints where a node should only observe
- A **`ROUTER_LATE`-style relay** you want visible on your dashboard without letting it transmit

Prior to #4294, MeshMonitor silently force-set `txEnabled: true` on every LoRa config write and
on every channel/config import — so a receive-only node would have TX quietly re-enabled the next
time someone touched its configuration through MeshMonitor. That override is gone: MeshMonitor
now **honors and persists** whatever value you set.

## What still works

- **All read-only surfaces** — Dashboard, Packet Monitor, Unified Telemetry, the Map, and message
  history all work normally, because RX and decode are completely unaffected.
- **Local-node admin** over the TCP API — config reads/writes, reboot, set-time (the time-sync
  scheduler is local admin and keeps running), and channel reads.
- Messages **arriving** from other nodes still show up as normal.

## What's disabled

Everything that requires putting a packet on the air from *this* node:

- Sending channel/DM messages, tapbacks, and resends
- Traceroute requests
- Position, NodeInfo, neighbor-info, and telemetry requests
- **Remote**-node admin commands (local-node admin is unaffected — see above)
- The node's **own** NodeInfo, Position, and Telemetry broadcasts

That last point matters: because the node stops announcing itself, **it goes invisible to the
rest of the mesh** over time, even though it can still hear everything happening around it.

## How MeshMonitor behaves

- A persistent warning banner appears while TX is disabled, linking back to the LoRa
  configuration section.
- Every send/transmit control (channel and DM send boxes, tapback, resend, the send bell,
  traceroute, position/nodeinfo/neighbor/telemetry request buttons, remote-node admin actions) is
  rendered disabled with a tooltip explaining why.
- If a race lets a transmit request through anyway, the backend rejects it with `409 TX_DISABLED`
  and the UI surfaces a toast rather than failing silently or crashing. See the
  [REST API reference](https://github.com/Yeraze/meshmonitor/blob/main/docs/api/API_REFERENCE.md)
  for the exact error shape.
- **Automations** that target a receive-only source skip the send and record it in the automation
  run history rather than failing the run; the automation builder also shows an inline warning
  badge next to any explicitly-selected source that currently has TX disabled.
- **Not gated:** the embedded MQTT bridge downlink (it publishes to a broker, bypassing the radio
  entirely) and MeshCore sources (a different protocol with no equivalent flag).

## How to enable / disable it

1. Open the source's **LoRa Configuration** section (see [Device Configuration](/features/device)).
2. Toggle **TX Enabled**.
3. Unchecking it shows a confirmation dialog spelling out the consequences (the node goes
   invisible to the mesh; no sending, traceroute, or remote admin until you re-enable it). Confirm
   to apply.

As of #4294, this setting **persists** — MeshMonitor no longer force-reverts it to `true` on
save, and channel-URL / remote-config imports **preserve** the device's current value instead of
silently forcing TX back on.

::: warning Some hardware re-reads its own config
A small number of devices have been observed re-reading their own configuration and reverting
`tx_enabled` back to `true` on their own, independent of MeshMonitor. If TX keeps re-enabling
itself after you disable it, that's a device-side quirk, not MeshMonitor overriding your setting
— check the node's own configuration/firmware behavior.
:::

## Related

- [Device Configuration](/features/device) — LoRa Radio Configuration, including the TX Enabled
  checkbox
- [REST API Reference](https://github.com/Yeraze/meshmonitor/blob/main/docs/api/API_REFERENCE.md) — `409 TX_DISABLED` error shape
- [Multi-Source](/features/multi-source) — TX state is tracked per source
