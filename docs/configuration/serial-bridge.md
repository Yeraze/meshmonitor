# Using the Serial Bridge with USB/Serial Meshtastic Devices

The [Meshtastic Serial Bridge](https://github.com/Yeraze/meshtastic-serial-bridge) is a lightweight gateway that enables MeshMonitor to communicate with USB and Serial-connected Meshtastic devices by translating between Serial and TCP protocols.

## What is the Serial Bridge?

The Serial Bridge is a Docker-based application that:

- Connects to Meshtastic devices via USB or Serial ports
- Exposes a TCP interface on port 4403 compatible with MeshMonitor
- Translates between Serial protocols and TCP's framed protocol
- Runs as a standalone Docker container alongside MeshMonitor
- Provides automatic reconnection and network discovery via mDNS
- Uses the battle-tested `socat` utility for reliable serial bridging

## When to Use the Serial Bridge

Use the Serial Bridge when:

- ✅ Your Meshtastic device is connected via **USB or Serial** port
- ✅ You want to monitor a **directly connected** Meshtastic device
- ✅ Your device doesn't have WiFi/Ethernet capabilities
- ✅ You're running MeshMonitor on a system with **USB ports** (server, Raspberry Pi, etc.)

**Do NOT use the Serial Bridge if:**

- ❌ Your device has WiFi/Ethernet - connect directly via TCP instead
- ❌ Your device is Bluetooth-only - use the [MeshMonitor BLE Bridge](/configuration/ble-bridge) instead
- ❌ You want to test without hardware - use [meshtasticd](/configuration/meshtasticd) for virtual nodes

## Prerequisites

Before setting up the Serial Bridge, ensure you have:

1. **USB or Serial-connected Meshtastic device**
   - Device connected to your system
   - Serial port accessible (usually `/dev/ttyUSB0` on Linux)

2. **Docker and Docker Compose**
   - Docker Engine 20.10+
   - Docker Compose v2

3. **Device configured for serial communication**
   - Serial mode must be enabled on the device
   - Proper baud rate configuration (115200)

## Quick Start

### 1. Prepare Your Meshtastic Device

Before using the Serial Bridge, configure your device for serial communication:

```bash
# Enable serial mode on the device
meshtastic --set serial.enabled true
meshtastic --set serial.echo false
meshtastic --set serial.mode SIMPLE
meshtastic --set serial.baud BAUD_115200

# Verify settings
meshtastic --get serial
```

**Important:** These settings must be configured while the device is connected directly (not through the bridge).

### 2. Find Your Serial Port

Identify which serial port your device is using:

```bash
# List USB serial devices
ls -la /dev/ttyUSB*
# or
ls -la /dev/ttyACM*

# Common ports:
# Linux: /dev/ttyUSB0, /dev/ttyACM0
# macOS: /dev/cu.usbserial-*
# Windows: COM3, COM4, etc. (requires WSL2)
```

### 3. Create Docker Compose Configuration

Create a `docker-compose.yml` file with both the Serial Bridge and MeshMonitor:

```yaml
services:
  serial-bridge:
    image: ghcr.io/yeraze/meshtastic-serial-bridge:latest
    container_name: meshtastic-serial-bridge
    devices:
      - /dev/ttyUSB0:/dev/ttyUSB0  # Change to your device
    ports:
      - "4403:4403"
    restart: unless-stopped
    environment:
      - SERIAL_DEVICE=/dev/ttyUSB0
      - BAUD_RATE=115200
      - TCP_PORT=4403

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
    environment:
      - MESHTASTIC_NODE_IP=serial-bridge
    restart: unless-stopped
    depends_on:
      - serial-bridge

volumes:
  meshmonitor-data:
```

### 4. Start the Services

```bash
docker compose up -d
```

### 5. Verify Connection

Check the logs to confirm the Serial Bridge is connected:

```bash
# Check Serial Bridge logs
docker compose logs serial-bridge

# Look for:
# "Device /dev/ttyUSB0 is ready"
# "mDNS service registered"
# "socat listening on 0.0.0.0:4403"

# Check MeshMonitor logs
docker compose logs meshmonitor

# Look for:
# "Connected to Meshtastic node at serial-bridge:4403"
```

Test with the Meshtastic CLI:

```bash
meshtastic --host localhost --info
```

## Configuration Details

### Environment Variables

The Serial Bridge supports the following configuration options:

| Variable | Default | Description |
|----------|---------|-------------|
| `SERIAL_DEVICE` | `/dev/ttyUSB0` | Path to the serial device |
| `BAUD_RATE` | `115200` | Serial communication speed (must match device config) |
| `TCP_PORT` | `4403` | TCP port for network connections |
| `SERVICE_NAME` | `Meshtastic Serial Bridge` | mDNS service name for network discovery |

### Custom Configuration Example

```yaml
services:
  serial-bridge:
    image: ghcr.io/yeraze/meshtastic-serial-bridge:latest
    devices:
      - /dev/ttyACM0:/dev/ttyACM0  # Different serial port
    ports:
      - "4404:4404"  # Custom TCP port
    environment:
      - SERIAL_DEVICE=/dev/ttyACM0
      - BAUD_RATE=115200
      - TCP_PORT=4404
      - SERVICE_NAME=My Custom Bridge
```

### Device Passthrough

The `devices` section in docker-compose.yml passes the serial device into the container:

```yaml
devices:
  - /dev/ttyUSB0:/dev/ttyUSB0  # Host device : Container device
```

**Important:** Both paths must match for the bridge to function correctly.

### MeshMonitor Configuration

When using the Serial Bridge, configure MeshMonitor to connect to it:

```yaml
environment:
  - MESHTASTIC_NODE_IP=serial-bridge  # Container name
  # or
  - MESHTASTIC_NODE_IP=localhost      # If using host network
```

## Device Preparation

### Required Serial Settings

Your Meshtastic device must have these serial settings configured:

```bash
serial.enabled = true
serial.echo = false
serial.mode = SIMPLE
serial.baud = BAUD_115200
```

**Why these settings matter:**

- **`serial.enabled`**: Activates serial communication
- **`serial.echo`**: Must be false to prevent echo interference
- **`serial.mode`**: SIMPLE mode provides direct serial communication
- **`serial.baud`**: 115200 is the standard baud rate

### Verifying Device Configuration

```bash
# Check all serial settings
meshtastic --get serial

# Should show:
# serial.enabled: True
# serial.echo: False
# serial.mode: SIMPLE
# serial.baud: BAUD_115200
```

### Configuring for the First Time

If your device has never been configured for serial:

```bash
# Connect device directly via USB
meshtastic --port /dev/ttyUSB0 --set serial.enabled true
meshtastic --port /dev/ttyUSB0 --set serial.echo false
meshtastic --port /dev/ttyUSB0 --set serial.mode SIMPLE
meshtastic --port /dev/ttyUSB0 --set serial.baud BAUD_115200

# Test connection
meshtastic --port /dev/ttyUSB0 --info
```

## Troubleshooting

### Device Not Found

**Problem:** Serial Bridge can't find `/dev/ttyUSB0`.

**Solutions:**

1. **Verify device is connected:**
   ```bash
   # List USB serial devices
   ls -la /dev/ttyUSB*

   # Check system logs
   dmesg | grep tty
   ```

2. **Update device path in docker-compose.yml:**
   ```yaml
   devices:
     - /dev/ttyACM0:/dev/ttyACM0  # Try different device
   ```

3. **Check device permissions:**
   ```bash
   # Add user to dialout group
   sudo usermod -aG dialout $USER

   # Log out and back in for changes to take effect
   ```

### Permission Denied

**Problem:** Bridge can't access the serial device.

**Solutions:**

1. **Run with proper permissions:**
   ```bash
   # Option 1: Add user to dialout group (recommended)
   sudo usermod -aG dialout $USER

   # Option 2: Change device permissions (temporary)
   sudo chmod 666 /dev/ttyUSB0
   ```

2. **Verify Docker can access the device:**
   ```bash
   docker run --rm --device /dev/ttyUSB0 alpine ls -la /dev/ttyUSB0
   ```

### Port Already in Use

**Problem:** TCP port 4403 is already occupied.

**Solutions:**

1. **Check what's using the port:**
   ```bash
   sudo lsof -i :4403
   # or
   sudo netstat -tlnp | grep 4403
   ```

2. **Stop conflicting services:**
   ```bash
   docker compose down
   ```

3. **Use a different port:**
   ```yaml
   environment:
     - TCP_PORT=4404
   ports:
     - "4404:4404"
   ```

### Device Keeps Rebooting

**Problem:** Meshtastic device reboots when the bridge connects.

**Cause:** HUPCL (hang up on close) signal is being sent.

**Solution:** The bridge automatically disables HUPCL on startup. Check logs:

```bash
docker compose logs serial-bridge | grep HUPCL

# Should show:
# "HUPCL disabled successfully"
```

If HUPCL disable fails, try:
```bash
# Manually disable HUPCL on host
stty -F /dev/ttyUSB0 -hupcl

# Restart bridge
docker compose restart serial-bridge
```

### Baud Rate Mismatch

**Problem:** Bridge connects but no data flows.

**Solutions:**

1. **Verify device baud rate:**
   ```bash
   meshtastic --get serial.baud
   ```

2. **Match bridge configuration:**
   ```yaml
   environment:
     - BAUD_RATE=115200  # Must match device setting
   ```

### Serial Mode Not Enabled

**Problem:** Can't communicate with device through bridge.

**Solution:**

1. **Check serial settings:**
   ```bash
   meshtastic --get serial.enabled
   ```

2. **Enable if disabled:**
   ```bash
   meshtastic --set serial.enabled true
   meshtastic --set serial.mode SIMPLE
   ```

### MeshMonitor Can't Connect to Bridge

**Problem:** Serial Bridge starts but MeshMonitor shows "Connection failed".

**Solutions:**

1. **Verify TCP server is listening:**
   ```bash
   # From host
   netstat -tln | grep 4403

   # Should show: tcp 0.0.0.0:4403 LISTEN
   ```

2. **Test with meshtastic CLI:**
   ```bash
   meshtastic --host localhost --info
   ```

3. **Check bridge logs:**
   ```bash
   docker compose logs serial-bridge
   ```

4. **Verify network connectivity between containers:**
   ```bash
   docker compose exec meshmonitor ping serial-bridge
   ```

## Advanced Configuration

### Using Host Network Mode

For simpler networking, use host network mode:

```yaml
services:
  serial-bridge:
    image: ghcr.io/yeraze/meshtastic-serial-bridge:latest
    network_mode: host
    devices:
      - /dev/ttyUSB0:/dev/ttyUSB0
    environment:
      - SERIAL_DEVICE=/dev/ttyUSB0

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    network_mode: host
    volumes:
      - meshmonitor-data:/data
    environment:
      - MESHTASTIC_NODE_IP=localhost
```

**Note:** Host networking removes container isolation but simplifies port management.

### Running on Raspberry Pi

The Serial Bridge works perfectly on Raspberry Pi:

```yaml
services:
  serial-bridge:
    image: ghcr.io/yeraze/meshtastic-serial-bridge:latest
    devices:
      - /dev/ttyUSB0:/dev/ttyUSB0
    ports:
      - "4403:4403"
    restart: unless-stopped
```

**Raspberry Pi tips:**
- USB serial devices usually appear as `/dev/ttyUSB0` or `/dev/ttyACM0`
- Add `pi` user to dialout group: `sudo usermod -aG dialout pi`
- Use `restart: unless-stopped` for automatic recovery after power outages

### Windows WSL Setup

> **Community Contribution:** These instructions were contributed by [@andresee](https://github.com/andresee) for running MeshMonitor and the Serial Bridge on Windows using WSL (Windows Subsystem for Linux) with USB passthrough.

Running the Serial Bridge on Windows requires WSL2 and the usbipd-win tool to pass USB devices from Windows to WSL.

#### Prerequisites

1. **Windows Subsystem for Linux (WSL2)**
   - Install WSL2 if not already installed
   - Use a supported Linux distribution (Ubuntu recommended)

2. **usbipd-win**
   - Download and install from: [usbipd-win releases](https://github.com/dorssel/usbipd-win/releases)
   - Recommended version: v5.3.0 or later
   - Official documentation: [WSL support guide](https://github.com/dorssel/usbipd-win/wiki/WSL-support)

#### Step 1: Find Your USB Device

In Windows PowerShell or Command Prompt (run as Administrator):

```powershell
# List all USB devices
usbipd list
```

Example output:
```
BUSID  DEVICE                                      STATE
1-7    USB Input Device                            Not shared
4-4    STMicroelectronics STLink dongle, STMic...  Not shared
5-2    Surface Ethernet Adapter                    Not shared
1-8    239a:8029  USB Serial Device (COM7)         Not shared
```

Identify your Meshtastic device's BUSID (e.g., `1-8` for the USB Serial Device above).

#### Step 2: Bind the Device to WSL

Bind the device to make it available for WSL sharing:

```powershell
# Replace 1-8 with your device's BUSID
usbipd bind --busid 1-8
```

Verify the device is now shared:

```powershell
usbipd list
```

You should see the device state changed to "Shared":
```
BUSID  DEVICE                                      STATE
1-8    239a:8029  USB Serial Device (COM7)         Shared
```

#### Step 3: Attach Device to WSL

Attach the shared device to your WSL instance:

```powershell
# Replace 1-8 with your device's BUSID
usbipd attach --wsl --busid 1-8
```

Verify the device is attached:

```powershell
usbipd list
```

The device state should now show "Attached":
```
BUSID  DEVICE                                      STATE
1-8    239a:8029  USB Serial Device (COM7)         Attached
```

#### Step 4: Verify Device in WSL

Open your WSL terminal and verify the device is available:

```bash
# List USB devices
lsusb
```

Example output:
```
Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub
Bus 001 Device 009: ID 239a:8029 Adafruit WisCore RAK4631 Board
Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub
```

Find the TTY device path:

```bash
# Check kernel messages for TTY assignment
dmesg | grep tty
```

Example output:
```
[1211963.942117] cdc_acm 1-1:1.0: ttyACM0: USB ACM device
```

Verify the device path exists:

```bash
ls /dev/ttyACM*
```

Expected output:
```
/dev/ttyACM0
```

#### Step 5: Configure Docker Compose

Create or update your `docker-compose.yml` with the WSL device path:

```yaml
services:
  serial-bridge:
    image: ghcr.io/yeraze/meshtastic-serial-bridge:latest
    container_name: meshtastic-serial-bridge
    devices:
      - /dev/ttyACM0:/dev/ttyACM0  # WSL serial device → container
    ports:
      - "4403:4403"
    restart: unless-stopped
    environment:
      - SERIAL_DEVICE=/dev/ttyACM0  # Must match device mapping
      - BAUD_RATE=115200
      - TCP_PORT=4403

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
    environment:
      - MESHTASTIC_NODE_IP=serial-bridge
    restart: unless-stopped
    depends_on:
      - serial-bridge

volumes:
  meshmonitor-data:
```

**Important notes:**
- Replace `/dev/ttyACM0` with your actual device path from Step 4
- The device path in `devices:` and `SERIAL_DEVICE` environment variable must match
- Common device paths in WSL: `/dev/ttyACM0`, `/dev/ttyUSB0`

#### Step 6: Start the Services

In your WSL terminal:

```bash
docker compose up -d
```

#### Step 7: Verify Operation

Check that both services are running correctly:

```bash
# Check Serial Bridge logs
docker compose logs serial-bridge

# Check MeshMonitor logs
docker compose logs meshmonitor
```

Access MeshMonitor at: http://localhost:8080

#### Windows WSL Troubleshooting

**Device not appearing in WSL:**
- Ensure usbipd-win is running as Administrator
- Try detaching and reattaching: `usbipd detach --busid 1-8` then `usbipd attach --wsl --busid 1-8`
- Verify WSL2 is being used: `wsl --list --verbose`

**Permission denied in WSL:**
- Add your WSL user to the dialout group: `sudo usermod -aG dialout $USER`
- Log out and back into WSL
- Check device permissions: `ls -la /dev/ttyACM0`

**Device path changes after reboot:**
- The device path (`/dev/ttyACM0` vs `/dev/ttyUSB0`) may vary
- Update your docker-compose.yml if the path changes
- Consider using udev rules for consistent device naming

**USB device resets when attaching:**
- This is normal WSL behavior
- Wait a few seconds after attaching before starting Docker services
- Check `dmesg` to confirm device enumeration completed

**Docker can't access device:**
- Verify Docker Desktop is using WSL2 integration
- Ensure WSL integration is enabled for your distribution in Docker Desktop settings
- Restart Docker Desktop if needed

### Multiple Serial Devices

To bridge multiple devices, run separate instances:

```yaml
services:
  serial-bridge-1:
    image: ghcr.io/yeraze/meshtastic-serial-bridge:latest
    container_name: bridge-device1
    devices:
      - /dev/ttyUSB0:/dev/ttyUSB0
    ports:
      - "4403:4403"
    environment:
      - SERIAL_DEVICE=/dev/ttyUSB0
      - SERVICE_NAME=Device 1

  serial-bridge-2:
    image: ghcr.io/yeraze/meshtastic-serial-bridge:latest
    container_name: bridge-device2
    devices:
      - /dev/ttyUSB1:/dev/ttyUSB1
    ports:
      - "4404:4404"
    environment:
      - SERIAL_DEVICE=/dev/ttyUSB1
      - TCP_PORT=4404
      - SERVICE_NAME=Device 2
```

### Network Discovery with mDNS

The Serial Bridge automatically registers itself via Avahi mDNS for network discovery.

**Browse available services:**
```bash
# Install avahi-utils if needed
sudo apt-get install avahi-utils

# Discover Serial Bridges on network
avahi-browse -rt _meshtastic._tcp
```

**Service information includes:**
- Service type: `_meshtastic._tcp`
- Bridge type and version
- TCP port
- Serial device path
- Baud rate

## Performance and Resource Usage

The Serial Bridge is extremely lightweight:

- **Memory:** ~15-25 MB
- **CPU:** Minimal (< 1% on idle)
- **Network:** ~1-5 KB/s (depends on mesh activity)
- **Disk:** ~47 MB Docker image (Alpine-based)
- **Startup time:** < 2 seconds

## Technical Details

### Architecture

The bridge uses `socat` (SOcket CAT) for serial-to-TCP translation:

```
meshtastic CLI → TCP:4403 → socat → /dev/ttyUSB0 → Meshtastic Device
```

**Why socat?**
- Battle-tested serial protocol handler
- Proper low-level serial communication
- Handles wake sequences correctly
- No async I/O blocking issues
- Reliable for long-running connections

### Startup Process

When the container starts:

1. Display version information
2. Verify serial device exists at configured path
3. Disable HUPCL to prevent device reboots
4. Register mDNS service via Avahi
5. Start socat listener on 0.0.0.0:TCP_PORT
6. Establish bidirectional serial bridge at configured baud rate

### Serial Protocol

The bridge maintains a direct serial connection with these characteristics:
- **Baud rate:** 115200 (configurable)
- **Data bits:** 8
- **Parity:** None
- **Stop bits:** 1
- **Flow control:** None (raw mode)

### TCP Protocol

The bridge exposes the standard Meshtastic TCP protocol:
- **Frame Structure:** `[0x94][0xC3][LENGTH_MSB][LENGTH_LSB][PROTOBUF_DATA]`
- **Port:** 4403 (default, configurable)
- **Format:** 4-byte header + protobuf payload

All translation between serial and TCP protocols is handled automatically by socat and the Meshtastic firmware.

## Security Considerations

1. **USB device access:**
   - Container requires direct device passthrough
   - Use minimal privileges where possible
   - Consider running in isolated Docker networks

2. **Serial port security:**
   - Restrict access to serial devices on host
   - Use dialout group membership instead of root
   - Monitor device permissions

3. **Network security:**
   - The TCP interface is unencrypted
   - Use firewall rules to restrict access to port 4403
   - Consider running on isolated network segment
   - Use Docker networks to control container communication

## Next Steps

- [Configure notifications](/features/notifications) for real-time alerts
- [Set up a reverse proxy](/configuration/reverse-proxy) for remote access
- [Deploy to production](/configuration/production) with monitoring
- [Serial Bridge GitHub Repository](https://github.com/Yeraze/meshtastic-serial-bridge) for source code and updates

## Alternative Solutions

If the Serial Bridge doesn't meet your needs:

- **WiFi/Ethernet devices:** Connect directly via TCP (no bridge needed)
- **Bluetooth devices:** Use the [MeshMonitor BLE Bridge](/configuration/ble-bridge) instead
- **Virtual nodes:** Use [meshtasticd](/configuration/meshtasticd) for testing without hardware
- **Network-based deployment:** Consider adding WiFi to your Meshtastic device
