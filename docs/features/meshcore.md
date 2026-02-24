# MeshCore Support

::: warning EXPERIMENTAL
MeshCore support is an **experimental feature** introduced in MeshMonitor v3.4.13. It is under active development and may have rough edges. If you encounter any issues, please [submit a bug report](https://github.com/yeraze/meshmonitor/issues/new) on GitHub.
:::

## Overview

[MeshCore](https://meshcore.co) is an alternative LoRa mesh networking protocol that runs on many of the same hardware devices as Meshtastic. MeshMonitor can now connect to and monitor MeshCore devices alongside your existing Meshtastic network.

When enabled, MeshCore adds a dedicated **MeshCore tab** to the MeshMonitor UI, providing:

- **Connection management** - Connect via serial port or TCP
- **Node list** - View all discovered MeshCore nodes with signal quality, battery, and radio info
- **Contact management** - Browse and refresh your contact list
- **Messaging** - Send and receive messages (broadcast or direct)
- **Admin commands** - Login to remote nodes, query status, configure settings
- **Map integration** - MeshCore nodes with GPS coordinates appear on the map

## Requirements

MeshCore support requires:

1. **A MeshCore device** - A LoRa device flashed with MeshCore firmware (Companion, Repeater, or Room Server)
2. **Python 3** - Must be available in the container/host as `python3`
3. **meshcore Python library** - Required for Companion device communication (`pip install meshcore`)
4. **Serial port access** - If connecting via USB serial, the device must be mapped into the container

## Environment Variables

MeshCore is disabled by default. To enable it, set the following environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `MESHCORE_ENABLED` | Yes | `false` | Set to `true` to enable MeshCore support |
| `MESHCORE_SERIAL_PORT` | Conditional | - | Serial port path (e.g., `/dev/ttyACM0`). Required for serial connections. |
| `MESHCORE_BAUD_RATE` | No | `115200` | Baud rate for serial connection |
| `MESHCORE_TCP_HOST` | Conditional | - | TCP host address. Required for TCP connections. |
| `MESHCORE_TCP_PORT` | No | `4403` | TCP port for network connection |

You must provide **either** `MESHCORE_SERIAL_PORT` (for USB serial) **or** `MESHCORE_TCP_HOST` (for TCP network) when MeshCore is enabled.

### Docker Compose Example

```yaml
services:
  meshmonitor:
    image: yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - MESHCORE_ENABLED=true
      - MESHCORE_SERIAL_PORT=/dev/ttyACM0
    devices:
      - /dev/ttyACM0:/dev/ttyACM0
    ports:
      - "8080:8080"
```

For TCP connections:

```yaml
services:
  meshmonitor:
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - MESHCORE_ENABLED=true
      - MESHCORE_TCP_HOST=192.168.1.200
      - MESHCORE_TCP_PORT=4403
    ports:
      - "8080:8080"
```

## Device Types

MeshCore firmware comes in several variants. MeshMonitor automatically detects the device type on connection:

| Device Type | Description | Connection Method |
|---|---|---|
| **Companion** | Full-featured device with binary protocol support | Python bridge (serial or TCP) |
| **Repeater** | Lightweight relay with text CLI interface | Direct serial |
| **Room Server** | Chat room server for group messaging | Python bridge |

## Using MeshCore

### Connecting

1. Enable MeshCore via environment variables and restart MeshMonitor
2. Navigate to the **MeshCore** tab in the UI
3. If environment variables are configured, MeshMonitor will auto-connect on startup
4. You can also connect manually by entering connection details in the UI

### Viewing Nodes and Contacts

Once connected, the MeshCore tab displays:

- **Connection status** - Shows the connected device name, type, and radio parameters
- **Node list** - All discovered nodes with their public key, signal quality (RSSI/SNR), battery voltage, and uptime
- **Contacts** - Your device's contact list with last-seen timestamps

### Sending Messages

1. Select a contact from the dropdown (or leave empty for broadcast)
2. Type your message (maximum 228 characters for LoRa)
3. Click Send

### Admin Commands

For nodes you have admin access to:

1. Enter the target node's public key (64-character hex string)
2. Enter the admin password
3. Click **Login** to authenticate
4. Once logged in, you can query node status (battery, uptime, radio settings)

### Radio Configuration

With admin access to your local node, you can configure radio parameters:

- **Frequency** (100-1000 MHz)
- **Bandwidth** (125, 250, 500 kHz)
- **Spreading Factor** (5-12)
- **Coding Rate** (5-8)

::: danger
Changing radio parameters will disconnect you from nodes using different settings. Make sure all nodes in your mesh use the same radio configuration.
:::

## Permissions

MeshCore access is controlled through MeshMonitor's permission system:

| Permission | Scope | Description |
|---|---|---|
| `meshcore` read | Unauthenticated | View connection status, nodes, contacts, and messages |
| `meshcore` write | Authenticated | Connect/disconnect, send messages, admin commands, configuration |

Anonymous users can view MeshCore data if the `meshcore` read permission is granted to the anonymous user (this is the default). Modifying settings or sending messages requires authentication.

## Troubleshooting

### MeshCore tab not visible
- Ensure `MESHCORE_ENABLED=true` is set in your environment
- Restart the MeshMonitor container after changing environment variables

### Connection fails
- Verify the serial port is accessible inside the container (check `devices:` mapping in docker-compose)
- Ensure `python3` is available and the `meshcore` Python library is installed
- Check MeshMonitor logs for `[MeshCore]` entries for detailed error messages

### Python bridge errors
- The MeshCore Python bridge (`scripts/meshcore-bridge.py`) requires the `meshcore` Python package
- Install it with: `pip install meshcore`
- For TCP connections, ensure your meshcore library version supports TCP (`TCPConnection`)

### No nodes appearing
- Verify your MeshCore device is properly flashed and operating
- Check that the radio frequency and parameters match other nodes in your mesh
- Try sending an advert to announce your presence on the network

## Reporting Issues

This is an experimental feature and we appreciate your feedback. If you encounter any problems:

1. Check the [existing issues](https://github.com/yeraze/meshmonitor/issues) to see if your problem has been reported
2. If not, [open a new issue](https://github.com/yeraze/meshmonitor/issues/new) with:
   - Your MeshCore device type and firmware version
   - MeshMonitor version
   - Relevant log output (look for `[MeshCore]` prefixed messages)
   - Steps to reproduce the issue
