# Set up a MeshCore source

This page covers adding a MeshCore radio as a source: what you need, the USB and TCP links, first-boot env vars for headless installs, and fixes for common connection problems. For the short version, see [Start here](/features/meshcore#start-here).

## Source Types

MeshCore sources are added through the UI. The Sources sidebar lets you pick a device type of **Companion** (native JS backend via meshcore.js) or **Repeater** (direct serial), and a transport of **USB / Serial** or **TCP**.

::: tip Room Server
**Room Server** devices use the same Companion path — when present they're auto-detected on connection. There's no Room Server option in the device-type selector; pick Companion and the device will be identified correctly.
:::

## Requirements

1. **A MeshCore device** — A LoRa device flashed with MeshCore firmware (Companion, Repeater, or Room Server)
2. **Serial port access** — If connecting via USB serial, the device must be mapped into the container with `devices:`. MeshMonitor opens it as the unprivileged `node` user; the entrypoint grants that user the device's group automatically. See [USB serial devices and the non-root user](/configuration/production#usb-serial-devices-and-the-non-root-user) if you run the container with `user:`.

## Adding a MeshCore Source

Add MeshCore sources from the UI — they hot-connect immediately without a restart.

1. Open the **Sources sidebar** on the dashboard (admin only)
2. Click **+ Add** next to the Sources header
3. Pick **MeshCore** as the source type
4. Choose the transport — **USB / Serial** (enter the serial port, e.g. `/dev/ttyACM0`) or **TCP** (enter the host and port; see [TCP Transport](#tcp-transport) below)
5. Pick the **device type** — **Companion** for full-featured devices, **Repeater** for direct-serial repeaters (USB only)
6. *(Optional)* Set a **Heartbeat** interval in seconds (0 = off; new Companion sources start at 60). When set, MeshMonitor periodically probes the node and automatically reconnects with exponential backoff if the link drops — the same setting Meshtastic sources have. It works for Companion and Repeater devices. On a Repeater the probe is a `clock` command on the serial console: it uses no airtime, and three missed replies in a row reopen the port. A Repeater whose serial port closes (USB unplug, device reset) reconnects on its own even with the heartbeat off.
7. Save — the source connects immediately if **Auto-connect** is on

Sources you create from the UI are wired into the per-source MeshCore manager registry the same way Meshtastic TCP sources are, so create / update / delete / connect / disconnect all work without a process restart.

### TCP Transport

Added in 4.5.1. MeshCore Companions can now be reached over TCP directly from the UI — no env-var bootstrap, no container restart. Pick **TCP** in the transport selector when adding or editing a MeshCore source.

| Field | Default | Notes |
|---|---|---|
| Host | (none) | Hostname or IP of the device or proxy reachable from the MeshMonitor container |
| Port | `5000` | Where the companion listens. WiFi and Ethernet builds use `5000`. Change it for a native-TCP build (`4403`) or a `ser2net`/`esp-link` proxy. |

Common ways to put a MeshCore Companion on TCP:

- **WiFi / Ethernet firmware** — the common case, and what the port field expects. These builds listen on `5000`. Put the device on your network and point MeshMonitor at it.
- **Native TCP firmware** — a different Companion build that speaks the binary protocol straight over TCP. It listens on `4403`, so change the port when you add the source.
- **`ser2net`** — Bridge a serial-attached MeshCore device on another host to a TCP port. Useful when the companion is plugged into a Pi or workstation that isn't running MeshMonitor.
- **`esp-link`** — ESP8266/ESP32-based serial-to-WiFi adapter wired to the companion's UART. The same binary protocol flows transparently over the link.

::: tip Container networking
TCP sources connect from inside the MeshMonitor container, so the host must be reachable from there — use the device's LAN IP (or your gateway hostname), not `localhost` or `127.0.0.1`. If the companion is on the same host as MeshMonitor, use `host.docker.internal` (already configured in `docker-compose.dev.yml`) or the host's LAN IP.
:::

::: warning Companion only
TCP is a Companion-class feature. Repeater devices are still USB-only — pick the **USB / Serial** transport when adding a Repeater source.
:::

### Tuning Environment Variables

A couple of background-scheduler tuning knobs are still environment-driven:

| Variable | Default | Description |
|---|---|---|
| `MESHCORE_TELEMETRY_INTERVAL_MS` | `300000` | How often (ms) to poll the **local** companion for telemetry. Default 5 minutes. |
| `MESHCORE_REMOTE_TELEMETRY_TICK_MS` | `30000` | How often (ms) the remote-telemetry scheduler walks each source and picks an eligible node. |

### Headless installs: first-boot env vars

To get a MeshCore source with no clicks in the UI, set these before the first start. They create a source named **Default MeshCore**, with the same config the Add Source form would save:

```yaml
services:
  meshmonitor:
    environment:
      # TCP Companion (WiFi/Ethernet build)...
      - MESHCORE_TCP_HOST=192.168.1.60
      - MESHCORE_TCP_PORT=5000            # optional, defaults to 5000
      # ...or a USB device instead:
      # - MESHCORE_SERIAL_PORT=/dev/ttyACM0
      # - MESHCORE_BAUD_RATE=115200       # optional
      # - MESHCORE_DEVICE_TYPE=repeater   # optional: companion (default) or repeater
      - MESHCORE_ENABLE_VIRTUAL_NODE=true # optional, Companion only
    # devices:                            # needed for MESHCORE_SERIAL_PORT
    #   - /dev/ttyACM0:/dev/ttyACM0
```

- **First boot only.** The vars apply when MeshMonitor first creates its sources. An install that already has sources never grows a MeshCore source because you added them later, and later restarts never change the source.
- **Independent of Meshtastic.** `MESHTASTIC_NODE_IP` still creates the Meshtastic "Default" source. Set either, both, or neither. With only the MeshCore vars, the disabled Meshtastic placeholder is skipped.
- **TCP or serial.** Set `MESHCORE_TCP_HOST` or `MESHCORE_SERIAL_PORT`. Both set: MeshMonitor warns and uses TCP. A Repeater needs serial; `MESHCORE_DEVICE_TYPE=repeater` with a TCP host warns and creates no source.
- **Serial in Docker** needs the device mapped into the container with `devices:` (see [Requirements](#requirements)).
- **Virtual Node** (`MESHCORE_ENABLE_VIRTUAL_NODE`, `MESHCORE_VIRTUAL_NODE_PORT`, default port `5000`): Companion only, with admin commands and PKI export/import off. See [Virtual Node → MeshCore Virtual Node](/configuration/virtual-node#meshcore-virtual-node).
- The full list is in [Environment Variables → MeshCore Default Source](/configuration/#meshcore-default-source).

::: info 3.x env vars
3.x had a MeshCore env-var bootstrap that 4.6 removed. These vars reuse most of its names, but only seed a source on first boot. `MESHCORE_ENABLED` is gone, and `MESHCORE_FIRMWARE_TYPE` is now `MESHCORE_DEVICE_TYPE` (the old name logs a warning and is ignored).
:::

::: tip
`ENABLE_VIRTUAL_NODE` is the Meshtastic Virtual Node var. It has **no effect** on MeshCore sources; use `MESHCORE_ENABLE_VIRTUAL_NODE` for the MeshCore one.
:::

## Device Types

MeshMonitor automatically detects the device type on connection:

| Device Type | Description | Connection Method |
|---|---|---|
| **Companion** | Full-featured device with binary protocol support | Native JS backend (meshcore.js, serial or TCP) |
| **Repeater** | Lightweight relay with text CLI interface | Direct serial |
| **Room Server** | Chat room server for group messaging | Native JS backend (meshcore.js) |

## Virtual Node

A Companion source can share its radio with the MeshCore phone app. Tick **Expose this node to the MeshCore app over WiFi** in the source form and pick a port (default `5000`), then point the app at the MeshMonitor host and that port. **Allow admin commands**, **Allow PKI export** and **Allow PKI import** stay off unless you trust every client that can reach the port: it has no login. See [Virtual Node → MeshCore Virtual Node](/configuration/virtual-node#meshcore-virtual-node).

## Troubleshooting

### MeshCore source can't be added or connection fails
- For **USB** sources: Verify the serial port is accessible inside the container (check `devices:` mapping in docker-compose). The entrypoint auto-grants the `node` user access to mapped tty groups (look for `Granted node user access to /dev/...` in the container log); if you mounted a device after the container started, restart it. A `Permission denied` opening the port means the grant did not happen: see [USB serial devices and the non-root user](/configuration/production#usb-serial-devices-and-the-non-root-user).
- For **TCP** sources: Verify the host is reachable from inside the container (the MeshMonitor process resolves it, not your browser). Use a LAN IP rather than `localhost`/`127.0.0.1`, or `host.docker.internal` when the device shares a host with MeshMonitor. **Check the port first — a wrong port is the usual reason a MeshCore TCP source never connects.** Use `5000` for a WiFi/Ethernet build, `4403` for a native-TCP build, or whatever port your `ser2net`/`esp-link` proxy uses.
- Check MeshMonitor logs for `[MeshCore]` entries for detailed error messages.

### No nodes appearing
- Verify your MeshCore device is properly flashed and operating.
- Check that the radio frequency and parameters match other nodes in your mesh.
- Try sending an advert to announce your presence on the network. A zero-hop advert reaches nodes in direct range; use a flood advert only if distant nodes need to find you.

### Can't log in to or poll a node MeshMonitor shows
The node is probably missing from the radio's own contact table, often because auto-add contacts is off on the radio. See [Radio contact table vs MeshMonitor](/features/meshcore-configuration#radio-contact-table-vs-meshmonitor).

## Reporting Issues

If you hit a problem, please [open an issue](https://github.com/yeraze/meshmonitor/issues/new) with:

- Your MeshCore device type and firmware version
- MeshMonitor version
- Relevant log output (look for `[MeshCore]` prefixed messages)
- Steps to reproduce the issue
