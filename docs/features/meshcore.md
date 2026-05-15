# MeshCore Support

::: warning STILL EARLY
MeshCore support is still **new and basic**. The core capabilities are stable and shipping incrementally — but expect rough edges, missing pieces compared to the Meshtastic side, and a fast-moving feature surface. If something doesn't behave the way you'd expect, [open an issue](https://github.com/yeraze/meshmonitor/issues/new).
:::

## Overview

[MeshCore](https://meshcore.co) is an alternative LoRa mesh networking protocol that runs on much of the same hardware as Meshtastic. In MeshMonitor 4.5+, each MeshCore device is a first-class **source** — it lives in the Sources sidebar next to your Meshtastic nodes, has its own per-source permissions, its own page, its own telemetry, and contributes contacts with valid coordinates to the unified dashboard map.

A single MeshMonitor deployment can run multiple MeshCore sources alongside multiple Meshtastic sources and gate access to each one independently. MeshCore sources are added from the UI and support both USB (Companion or Repeater) and TCP (Companion) transports.

When a MeshCore source is connected, you get:

- **Per-source MeshCore page** — Nodes, Channels, Direct Messages, Configuration, and a Node Info page in a single multi-pane layout
- **Dashboard integration** — MeshCore sources appear as styled cards in the dashboard sidebar with their own logo, status, and node count
- **Unified map** — MeshCore contacts with GPS appear on the dashboard map alongside Meshtastic nodes
- **Local-node telemetry** — Battery, radio stats, packet rates, and duty-cycle graphs from the connected companion
- **Per-node remote telemetry** — Scheduled cross-mesh telemetry pulls from other MeshCore nodes, written into the same telemetry store as Meshtastic
- **Radio preset selector** — Pick from the official MeshCore preset list instead of hand-tuning freq/bw/sf/cr
- **Contact-detail panel** — Hops, RSSI/SNR, last heard, position, and the full public key shown next to DM threads
- **Telemetry-mode configuration** — Toggle base / location / environment telemetry on the device itself
- **UI permission gating** — Write controls are disabled (not just rejected) for users without the right permission

## Source Types

MeshCore sources are added through the UI. The Sources sidebar lets you pick a device type of **Companion** (native JS backend via meshcore.js) or **Repeater** (direct serial), and a transport of **USB** or **TCP**.

::: tip Room Server
**Room Server** devices use the same Companion path — when present they're auto-detected on connection. There's no Room Server option in the device-type selector; pick Companion and the device will be identified correctly.
:::

## Requirements

1. **A MeshCore device** — A LoRa device flashed with MeshCore firmware (Companion, Repeater, or Room Server)
2. **Serial port access** — If connecting via USB serial, the device must be mapped into the container with `devices:`

## Adding a MeshCore Source

Add MeshCore sources from the UI — they hot-connect immediately without a restart.

1. Open the **Sources sidebar** on the dashboard (admin only)
2. Click the **+** button next to the Sources header
3. Pick **MeshCore** as the source type
4. Choose the transport — **USB** (enter the serial port, e.g. `/dev/ttyACM0`) or **TCP** (enter the host and port)
5. Pick the **device type** — **Companion** for full-featured devices, **Repeater** for direct-serial repeaters
6. Save — the source connects immediately if **Auto-connect** is on

Sources you create from the UI are wired into the per-source MeshCore manager registry the same way Meshtastic TCP sources are, so create / update / delete / connect / disconnect all work without a process restart.

### Tuning Environment Variables

A couple of background-scheduler tuning knobs are still environment-driven:

| Variable | Default | Description |
|---|---|---|
| `MESHCORE_TELEMETRY_INTERVAL_MS` | `300000` | How often (ms) to poll the **local** companion for telemetry. Default 5 minutes. |
| `MESHCORE_REMOTE_TELEMETRY_TICK_MS` | `30000` | How often (ms) the remote-telemetry scheduler walks each source and picks an eligible node. |

::: warning Removed in 4.6
The 3.x `MESHCORE_ENABLED`, `MESHCORE_SERIAL_PORT`, `MESHCORE_BAUD_RATE`, `MESHCORE_TCP_HOST`, `MESHCORE_TCP_PORT`, and `MESHCORE_FIRMWARE_TYPE` env-var bootstrap was removed when MeshCore became a first-class source type. Add a MeshCore source from the Sources sidebar instead.
:::

::: tip
`ENABLE_VIRTUAL_NODE` is a separate Meshtastic feature for proxying the Meshtastic protocol to mobile apps — it has **no relation** to MeshCore connectivity and is ignored by MeshCore sources.
:::

## Device Types

MeshMonitor automatically detects the device type on connection:

| Device Type | Description | Connection Method |
|---|---|---|
| **Companion** | Full-featured device with binary protocol support | Native JS backend (meshcore.js, serial or TCP) |
| **Repeater** | Lightweight relay with text CLI interface | Direct serial |
| **Room Server** | Chat room server for group messaging | Native JS backend (meshcore.js) |

## The MeshCore Page

Each MeshCore source has its own multi-pane page accessible by clicking the source in the dashboard sidebar. The page has a sub-toolbar with these views:

### Nodes

A map of every contact with valid coordinates, plus a styled row list aligned to the same visual vocabulary as the Meshtastic nodes view. The map honours zoom-based label visibility and falls through to the dashboard map when the source is selected at the dashboard level.

### Channels

The device's channels with the most recent message stream. Channel-message senders are now extracted from the `"Name: body"` prefix that MeshCore embeds in the text body, so the sender column and the message body are no longer collapsed into one string.

### Direct Messages

Per-contact DM view with a **contact-detail panel** that mirrors the Meshtastic NodeDetailsBlock. It surfaces:

- Contact name and type (companion / repeater / room server)
- Hops away (`pathLen`)
- RSSI and SNR
- Last heard and last advert
- Position (if known)
- Full public key

The panel is collapsible with state persisted to localStorage.

The **per-node remote-telemetry config** panel hangs off the contact-detail panel (see [Per-Node Remote Telemetry](#per-node-remote-telemetry) below).

### Node Info

A dashboard-style view of the connected local companion. It graphs the data collected by the local-telemetry poller (see [Local-Node Telemetry](#local-node-telemetry) below) across 1h / 6h / 24h / 3d / 7d ranges, plus identity (firmware version, build, model), current radio settings, current health, and cumulative counters.

This view is only available when the page is mounted from a per-source URL — the legacy app-shell mount path does not have a `sourceId` and hides the Node Info entry.

### Configuration

Where you change the device's settings:

- **Identity** — Name and advert
- **Location** — Position and advert-location policy
- **Radio** — Frequency, bandwidth, spreading factor, coding rate (now with a preset selector)
- **Telemetry mode** — Which telemetry classes the device emits (see [Telemetry Modes](#telemetry-modes))

## Telemetry

MeshMonitor collects three kinds of telemetry from MeshCore sources, all written into the same `telemetry` table the Meshtastic side uses (just with `mc_*` type names) so the graphing UI works the same way.

### Local-Node Telemetry

A module-level singleton polls every connected companion every `MESHCORE_TELEMETRY_INTERVAL_MS` (default 5 minutes). It calls `GetStats core / radio / packets`, `GetDeviceTime`, and `DeviceQuery` — **none of which transmit on the air** — and writes batched rows stamped with `sourceId` and prefixed `mc_`. tx/rx duty-cycle and packet rates are computed as deltas vs the prior sample.

This drives the [Node Info](#node-info) view.

### Telemetry Modes

You can toggle which telemetry classes the device itself emits over the air:

- **base** — Battery, voltage, uptime
- **loc** — Position
- **env** — Environmental sensors (where supported by the hardware)

Set these from the Configuration view; the device-side flag is persisted on the companion.

### Per-Node Remote Telemetry

Each row in `meshcore_nodes` can opt in to periodic `req_telemetry_sync` requests with a per-node interval. The remote-telemetry scheduler walks every registered manager every `MESHCORE_REMOTE_TELEMETRY_TICK_MS` (default 30s), picks at most one most-overdue eligible node per source, decodes the LPP response, and writes `mc_<lpp-type-name>` rows into the same `telemetry` table.

A global 60-second minimum spacing between any two scheduled mesh ops on the same source is enforced through `MeshCoreManager.lastMeshTxAt`, so future scheduled operations on the same manager (auto-traceroute, periodic adverts, etc.) coordinate against a single field instead of each owning their own throttle.

You configure this from the contact-detail panel in the Direct Messages view:

1. Open the DM with the target contact
2. Open the contact-detail panel
3. Toggle **Remote telemetry** on
4. Set the **interval** (minutes)
5. Save

The config requires `configuration:write` on the source. Read-only users see the panel with controls disabled and a banner explaining why.

The composite primary key on `meshcore_nodes` is `(sourceId, publicKey)`, so the same device advertising under two different sources is tracked independently.

## Multi-Source Dashboard

MeshCore sources appear as styled cards in the dashboard sidebar — same visual language as Meshtastic sources, with a MeshCore logo and per-source status.

The aggregate dashboard map and `/api/nodes` endpoint enumerate every connected MeshCore manager and include contacts that have valid `(latitude, longitude)` (zeros are rejected). Each contact gets a synthetic `nodeId` of `mc:<sourceId>:<pubkeyPrefix>` so cross-source duplicates don't collide on React keys, and `getNodeLatLng` resolves either the flat `{latitude, longitude}` shape or the nested `position` shape.

## Permissions

In 4.5 the global `meshcore` permission is gone. Migration 058 expanded every legacy `meshcore` grant into the per-source **sourcey** resource set, matching how Meshtastic resources are scoped:

| Resource | Scope | Description |
|---|---|---|
| `connection` | Per-source | Connect/disconnect, status |
| `configuration` | Per-source | Identity, radio, telemetry mode, location, per-node remote-telemetry config |
| `nodes` | Per-source | Node list, contacts, map data |
| `messages` | Per-source | Read and send DMs / channel messages |

Anonymous users can view MeshCore data on sources where the anonymous user has the relevant `*:read` permission. Sending messages, changing config, and toggling remote telemetry all require `configuration:write` (or `messages:write` for sends).

### UI Permission Gating

Write controls in the MeshCore UI are now **disabled in place** for users without the right permission — not just rejected on submit. The Configuration view, Channels view, DM compose box, and remote-telemetry toggle all dim themselves and surface an explanatory banner, mirroring how the Meshtastic side handles permission gating.

See [Per-Source Permissions](/features/per-source-permissions) for the full model.

## Radio Configuration

Use the Configuration view's **Preset** dropdown to pick from the official MeshCore preset list, or choose **Custom** to manually set:

- **Frequency** (100-1000 MHz)
- **Bandwidth** (125, 250, 500 kHz)
- **Spreading Factor** (5-12)
- **Coding Rate** (5-8)

::: danger
Changing radio parameters will disconnect you from nodes using different settings. Make sure all nodes in your mesh use the same radio configuration.
:::

Saved radio params are now persisted authoritatively: the backend propagates device-side errors back instead of silently returning success, and the manager optimistically updates `localNode.radio*` then refreshes from the device so the next snapshot reflects the real device state.

## Still Early

This is the part that's worth being honest about. MeshCore support is **basic** today — the core "see your network, send messages, watch telemetry" loop works, but plenty is missing.

Known gaps and limitations:

- **Repeater / Room Server per-source parity** is behind Companion. Repeater is selectable as a USB device type, but most new 4.5 features (local telemetry poller, remote-telemetry scheduler, telemetry-mode toggles) require a Companion connection on the source side.
- **No remote-admin equivalent** for MeshCore yet — the Meshtastic-side admin scanner, password rotation, OTA flow, etc. don't have MeshCore counterparts.
- **No auto-responder / auto-announce / auto-traceroute** schedulers for MeshCore. The per-source scheduler primitives are wired up, but the user-facing features haven't been built yet.
- **Notifications** for MeshCore events are minimal — apprise/push surfaces aren't yet first-class.
- **Map rendering** uses the dashboard map's existing primitives, so MeshCore-specific link visualization (direct radio links, route quality) is not yet there.
- **Companion-only telemetry mode toggles** — Repeaters report what they report; the base/loc/env toggle is meaningful on Companions.

The roadmap is incremental: keep landing one or two MeshCore features per release, keep aligning the UI vocabulary with Meshtastic, and gradually close the parity gap.

## Troubleshooting

### MeshCore source can't be added or connection fails
- Verify the serial port is accessible inside the container (check `devices:` mapping in docker-compose). The entrypoint auto-grants the `node` user access to mapped tty groups; if you mounted a device after the container started, restart it.
- Check MeshMonitor logs for `[MeshCore]` entries for detailed error messages.

### Runtime-added MeshCore source idle until restart
This is fixed in 4.5 — source create/update/delete/connect/disconnect endpoints all wire MeshCore into the per-source registry. If you're seeing this on an earlier 4.x version, restart the container as a workaround and upgrade.

### No nodes appearing
- Verify your MeshCore device is properly flashed and operating.
- Check that the radio frequency and parameters match other nodes in your mesh.
- Try sending an advert to announce your presence on the network.

### Radio parameter changes "revert" on save
Earlier 4.x versions had a hook-dependency bug where Phase 3 push events overwrote staged radio/location edits before Save fired. Fixed in 4.5.

## Reporting Issues

If you hit a problem, please [open an issue](https://github.com/yeraze/meshmonitor/issues/new) with:

- Your MeshCore device type and firmware version
- MeshMonitor version
- Relevant log output (look for `[MeshCore]` prefixed messages)
- Steps to reproduce the issue
