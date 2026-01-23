# Using the BLE Bridge with Bluetooth Meshtastic Devices

The [MeshMonitor BLE Bridge](https://github.com/Yeraze/meshtastic-ble-bridge) is a specialized gateway that enables MeshMonitor to communicate with Bluetooth Low Energy (BLE) Meshtastic devices by translating between BLE and TCP protocols.

## What is the BLE Bridge?

The BLE Bridge is a lightweight application that:

- Connects to Meshtastic devices via Bluetooth Low Energy (BLE)
- Exposes a TCP interface on port 4403 compatible with MeshMonitor
- Translates between BLE's raw protobuf format and TCP's framed protocol
- Available as a **native Windows application** or **Docker container** for Linux
- Provides automatic reconnection and error recovery

## When to Use the BLE Bridge

Use the BLE Bridge when:

- ✅ Your Meshtastic device only has **Bluetooth** connectivity (no WiFi/Ethernet)
- ✅ You want to monitor a **portable/mobile** Meshtastic device
- ✅ Your device is **nearby** (within Bluetooth range, typically 10-30 meters)
- ✅ You're running MeshMonitor on a system with **Bluetooth hardware** (Linux with BlueZ)

**Do NOT use the BLE Bridge if:**

- ❌ Your device has WiFi/Ethernet - connect directly via TCP instead
- ❌ Your device is USB/Serial connected - use the [Meshtastic Serial Bridge](/configuration/serial-bridge) instead
- ❌ Your system doesn't have Bluetooth hardware

## Prerequisites

Before setting up the BLE Bridge, ensure you have:

**For Windows:**
1. **Windows 10/11** with Bluetooth hardware
2. **BLE MAC address of your Meshtastic device**
   - Find it using the scan feature in the app
   - Usually visible in Android/iOS Bluetooth settings

**For Linux (Docker):**
1. **Linux system with Bluetooth support**
   - BlueZ Bluetooth stack installed
   - D-Bus system bus running
   - Bluetooth adapter enabled

2. **Docker and Docker Compose**
   - Docker Engine 20.10+
   - Docker Compose v2

3. **BLE MAC address of your Meshtastic device**
   - Find it using the scan command (see below)
   - Usually visible in Android/iOS Bluetooth settings

## Windows Quick Start

For Windows users, a native GUI application is available that runs in the system tray.

### 1. Download the Windows Application

Download the latest `meshtastic-ble-bridge.exe` from the [GitHub Releases](https://github.com/Yeraze/meshtastic-ble-bridge/releases) page.

### 2. Run the Application

Double-click the executable to launch. The application will appear in your system tray with a gray icon (disconnected state).

### 3. Configure the Bridge

Right-click the system tray icon and select **Settings** to open the configuration dialog:

- **BLE Address**: Enter your Meshtastic device's Bluetooth MAC address (e.g., `AA:BB:CC:DD:EE:FF`)
- **TCP Port**: Default is `4403` (standard Meshtastic port)
- **Auto-start**: Enable to automatically connect when the application launches
- **Config Caching**: Optional performance optimization

### 4. Connect to Your Device

Click **Connect** in the settings dialog or right-click the tray icon and select **Connect**.

The tray icon provides visual feedback:
- 🟢 **Green**: Connected to BLE device
- ⚪ **Gray**: Disconnected
- 🔴 **Red**: Connection failed after retry attempts

### 5. View Statistics

Right-click the tray icon and select **Statistics** to view:
- Connection status
- Packet counts (sent/received)
- Connected TCP clients
- Cache performance (if enabled)

### 6. Configure MeshMonitor

Point MeshMonitor to your Windows machine's IP address on port 4403:

```
MESHTASTIC_NODE_IP=192.168.1.100  # Your Windows PC's IP
MESHTASTIC_NODE_PORT=4403
```

::: tip Windows Firewall
You may need to allow the BLE Bridge through Windows Firewall to accept connections from MeshMonitor on port 4403.
:::

## Linux Quick Start (Docker)

For Linux users, the BLE Bridge runs as a Docker container alongside MeshMonitor.

### 1. Find Your Device's BLE MAC Address

Run the BLE bridge in scan mode to discover nearby Meshtastic devices:

```bash
docker run --rm --privileged \
  -v /var/run/dbus:/var/run/dbus \
  ghcr.io/yeraze/meshtastic-ble-bridge:latest --scan
```

Look for output like:
```
Found Meshtastic device: Meshtastic_1a2b (AA:BB:CC:DD:EE:FF)
```

The MAC address is `AA:BB:CC:DD:EE:FF`.

### 2. Create Environment File

Create a `.env` file in your MeshMonitor directory:

```bash
# .env file
BLE_ADDRESS=AA:BB:CC:DD:EE:FF  # Replace with your device's MAC address
```

### 3. Start MeshMonitor with BLE Bridge

Use the docker-compose overlay to add the BLE bridge:

```bash
docker compose -f docker-compose.yml -f docker-compose.ble.yml up -d
```

### 4. Verify Connection

Check the logs to confirm the BLE bridge is connected:

```bash
# Check BLE bridge logs
docker compose -f docker-compose.ble.yml logs ble-bridge

# Look for:
# "Connected to BLE device AA:BB:CC:DD:EE:FF"
# "TCP server listening on 0.0.0.0:4403"

# Check MeshMonitor logs
docker compose logs meshmonitor

# Look for:
# "Connected to Meshtastic node at localhost:4403"
```

## Configuration Details

### Docker Compose Overlay

The `docker-compose.ble.yml` file adds the BLE bridge service:

```yaml
services:
  ble-bridge:
    image: ghcr.io/yeraze/meshtastic-ble-bridge:latest
    container_name: meshmonitor-ble-bridge
    privileged: true  # Required for BLE hardware access
    restart: unless-stopped
    volumes:
      - /var/run/dbus:/var/run/dbus  # Required for D-Bus/Bluetooth
      - /var/lib/bluetooth:/var/lib/bluetooth:ro  # Pairing information
    environment:
      - BLE_ADDRESS=${BLE_ADDRESS:-}
    command: ${BLE_ADDRESS:-}
```

### Key Configuration Options

#### Privileged Mode

The BLE bridge requires `privileged: true` to access Bluetooth hardware. This grants the container direct access to the host's Bluetooth adapter.

**Security Note:** Privileged mode should only be used on trusted systems. For production, consider using device-specific capabilities instead.

#### Docker Networking

The BLE bridge and MeshMonitor communicate using Docker's internal networking. MeshMonitor connects to the BLE bridge using its container name (`meshmonitor-ble-bridge`) as the hostname.

#### Volume Mounts

Two volumes are required for Bluetooth access:

1. **D-Bus socket** (`/var/run/dbus`): Communication with BlueZ daemon
2. **Bluetooth config** (`/var/lib/bluetooth`): Access to pairing database

### MeshMonitor Configuration

When using the overlay, MeshMonitor automatically configures itself:

```yaml
environment:
  - MESHTASTIC_NODE_IP=meshmonitor-ble-bridge
  - MESHTASTIC_NODE_PORT=4403
```

The BLE bridge acts as a transparent TCP proxy on port 4403. MeshMonitor connects to it using Docker's internal DNS, which resolves the container name to the correct IP.

## Pairing Your Device

Some Meshtastic devices require Bluetooth pairing before the bridge can connect.

### Pairing on Linux Host

If the device requires pairing, use `bluetoothctl` on your host system:

```bash
# Start bluetoothctl
bluetoothctl

# Enable scanning
scan on

# Wait for your device to appear
# You'll see: Device AA:BB:CC:DD:EE:FF Meshtastic_1234

# Pair with the device
pair AA:BB:CC:DD:EE:FF

# Trust the device
trust AA:BB:CC:DD:EE:FF

# Exit
exit
```

After pairing on the host, the BLE bridge container can access the paired device through the `/var/lib/bluetooth` mount.

## Troubleshooting

### Device Not Found During Scan

**Problem:** `--scan` doesn't show your Meshtastic device.

**Solutions:**

1. **Ensure Bluetooth is enabled on the device:**
   - Check Meshtastic app settings
   - Verify BLE is not disabled in device configuration

2. **Check host Bluetooth adapter:**
   ```bash
   # Verify adapter is up
   hciconfig

   # Should show: hci0 UP RUNNING

   # If down, bring it up:
   sudo hciconfig hci0 up
   ```

3. **Verify BlueZ is running:**
   ```bash
   systemctl status bluetooth
   ```

### Connection Refused or Timeout

**Problem:** BLE bridge can't connect to the device even though scan finds it.

**Solutions:**

1. **Pair the device** (see [Pairing](#pairing-your-device) section)

2. **Ensure device is in range:**
   - BLE typically works within 10-30 meters
   - Move device closer to the host system

3. **Check for interference:**
   - WiFi routers and other 2.4GHz devices can interfere
   - Try moving away from interference sources

### MeshMonitor Can't Connect to BLE Bridge

**Problem:** BLE bridge starts but MeshMonitor shows "Connection failed".

**Solutions:**

1. **Verify TCP server is listening:**
   ```bash
   # From host
   netstat -tln | grep 4403

   # Should show: tcp 0.0.0.0:4403 LISTEN
   ```

2. **Check BLE bridge logs:**
   ```bash
   docker compose -f docker-compose.ble.yml logs ble-bridge
   ```

3. **Verify environment variables:**
   ```bash
   docker compose -f docker-compose.ble.yml config
   ```

### BLE Bridge Keeps Disconnecting

**Problem:** Connection drops frequently or BLE bridge restarts.

**Solutions:**

1. **Check Bluetooth signal strength:**
   - Move device closer to host
   - Remove obstacles between device and host

2. **Review BLE bridge logs for errors:**
   ```bash
   docker compose -f docker-compose.ble.yml logs -f ble-bridge
   ```

3. **Verify power management isn't disabling Bluetooth:**
   ```bash
   # Disable USB autosuspend for Bluetooth adapter
   echo 'on' | sudo tee /sys/bus/usb/devices/*/power/level
   ```

## Advanced Networking

### Using Bridge Network Instead of Host Network

For better container isolation, you can use a bridge network instead of host networking:

```yaml
services:
  ble-bridge:
    image: ghcr.io/yeraze/meshtastic-ble-bridge:latest
    privileged: true
    networks:
      - mesh-network
    volumes:
      - /var/run/dbus:/var/run/dbus
      - /var/lib/bluetooth:/var/lib/bluetooth:ro
    environment:
      - BLE_ADDRESS=${BLE_ADDRESS}

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    networks:
      - mesh-network
    environment:
      - MESHTASTIC_NODE_IP=ble-bridge
      - MESHTASTIC_NODE_PORT=4403
    depends_on:
      - ble-bridge

networks:
  mesh-network:
    driver: bridge
```

### Running BLE Bridge on Separate Host

If your MeshMonitor server doesn't have Bluetooth hardware, run the BLE bridge on a separate machine:

**On Bluetooth-enabled host:**
```yaml
services:
  ble-bridge:
    image: ghcr.io/yeraze/meshtastic-ble-bridge:latest
    privileged: true
    network_mode: host
    volumes:
      - /var/run/dbus:/var/run/dbus
      - /var/lib/bluetooth:/var/lib/bluetooth:ro
    environment:
      - BLE_ADDRESS=AA:BB:CC:DD:EE:FF
```

**On MeshMonitor host:**
```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.50  # IP of BLE bridge host
      - MESHTASTIC_NODE_PORT=4403
```

**Note:** Ensure port 4403 is accessible between hosts (check firewalls).

## Building from Source

### Linux (Docker)

To build the Docker image from source:

```bash
# Clone the repository
git clone https://github.com/Yeraze/meshtastic-ble-bridge.git
cd meshtastic-ble-bridge

# Build the image
docker build -t meshtastic-ble-bridge:local .

# Update docker-compose.ble.yml to use local build
# Uncomment the 'build' section and comment out 'image'
```

### Windows (Executable)

To build the Windows executable from source:

```bash
# Clone the repository
git clone https://github.com/Yeraze/meshtastic-ble-bridge.git
cd meshtastic-ble-bridge

# Create virtual environment
python -m venv venv
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
pip install pyinstaller

# Build the executable
pyinstaller --onefile --windowed --name meshtastic-ble-bridge gui.py
```

The executable will be created in the `dist` folder.

## Performance and Resource Usage

The BLE bridge is lightweight:

- **Memory:** ~50-100 MB
- **CPU:** Minimal (< 5% on idle)
- **Network:** ~1-5 KB/s (depends on mesh activity)
- **Bluetooth:** Standard BLE power consumption

## Security Considerations

1. **Linux: Privileged containers** have full access to host hardware
   - Only run on trusted systems
   - Consider using specific device capabilities in production

2. **Windows: Firewall configuration**
   - Allow only trusted IPs to connect to port 4403
   - Consider running MeshMonitor and BLE Bridge on the same machine

3. **Bluetooth security:**
   - Use pairing when possible
   - Keep Bluetooth firmware updated
   - Monitor for unauthorized connections

4. **Network security:**
   - The TCP interface is unencrypted
   - Use firewall rules to restrict access to port 4403
   - Consider running on isolated network segment

## Protocol Details

For developers and advanced users:

### BLE Protocol

- **Service UUID:** `6ba1b218-15a8-461f-9fa8-5dcae273eafd`
- **ToRadio (Write):** `f75c76d2-129e-4dad-a1dd-7866124401e7`
- **FromRadio (Read/Notify):** `2c55e69e-4993-11ed-b878-0242ac120002`
- **Format:** Raw protobuf bytes (no framing)

### TCP Protocol

- **Frame Structure:** `[0x94][0xC3][LENGTH_MSB][LENGTH_LSB][PROTOBUF_DATA]`
- **Port:** 4403 (Meshtastic standard)
- **Format:** 4-byte header + protobuf payload

The BLE bridge handles translation between these protocols automatically.

## Next Steps

- [Configure notifications](/features/notifications) for real-time alerts
- [Set up a reverse proxy](/configuration/reverse-proxy) for remote access
- [Deploy to production](/configuration/production) with monitoring
- [BLE Bridge GitHub Repository](https://github.com/Yeraze/meshtastic-ble-bridge) for source code and updates

## Alternative Solutions

If the BLE bridge doesn't meet your needs:

- **WiFi/Ethernet devices:** Connect directly via TCP (no bridge needed)
- **Serial/USB devices:** Use the [Meshtastic Serial Bridge](/configuration/serial-bridge) instead
- **Virtual nodes:** Use [meshtasticd](/configuration/meshtasticd) for testing without hardware
- **HomeAssistant users:** Connect through HomeAssistant's Meshtastic integration
- **Long-range BLE:** Consider using a BLE-to-WiFi bridge device
