# Using meshtasticd

`meshtasticd` runs Meshtastic firmware on Linux using portduino. It supports both **simulated virtual nodes** (no hardware needed) and **physical LoRa radios** connected via USB.

## What is meshtasticd?

`meshtasticd` provides a software Meshtastic node that can run with or without physical LoRa hardware.

Use cases include:

- **Testing MeshMonitor** without physical hardware (use `-s` flag)
- **Running node software with a real LoRa radio** on a server or Raspberry Pi (omit `-s`)
- Developing and testing mesh applications
- Creating virtual mesh networks for simulation and testing

## Physical Device Connections

`meshtasticd` can connect to **physical LoRa radios** using Portduino — most commonly a radio exposed as a USB serial device, though some boards present the radio over SPI/GPIO (a HAT). Simply omit the `-s` flag and pass the radio's device node(s) through to the container.

**For Serial/USB Meshtastic devices (non-LoRa):** Use the [Meshtastic Serial Bridge](/configuration/serial-bridge) instead

**For Bluetooth (BLE) devices:** Use the [MeshMonitor BLE Bridge](/configuration/ble-bridge) instead

## Installing meshtasticd

### Docker (Recommended)

The easiest way to run `meshtasticd` is via Docker:

```bash
docker pull meshtastic/meshtasticd:latest
```

### Native Installation

For native installation on Linux, see the [official Meshtastic documentation](https://meshtastic.org/docs/hardware/devices/linux-native-hardware/).

## Running meshtasticd

### Configuration File

meshtasticd requires a `config.yaml` configuration file. Create one with your desired settings:

```yaml
# config.yaml
Lora:
  Module: sx1262
  DIO2_AS_RF_SWITCH: true
  CS: 1
  IRQ: 2
  Busy: 3
  Reset: 4

Webserver:
  Port: 80

General:
  MACAddress: AA:BB:CC:DD:EE:01
```

### Basic Usage (Docker)

Run meshtasticd in simulation mode (no real LoRa hardware):

```bash
docker run -d \
  --name meshtasticd \
  -v ./config.yaml:/etc/meshtasticd/config.yaml:ro \
  -p 4403:4403 \
  meshtastic/meshtasticd:latest \
  meshtasticd -s
```

### Command Line Options

| Option | Description |
|--------|-------------|
| `-s` | Simulation mode - run without real LoRa hardware |
| `-c <file>` | Specify configuration file path |
| `-p <port>` | TCP port for client connections (default: 4403) |
| `-d` | Enable debug logging |

### With Custom TCP Port

To specify a different TCP port:

```bash
docker run -d \
  --name meshtasticd \
  -v ./config.yaml:/etc/meshtasticd/config.yaml:ro \
  -p 4404:4404 \
  meshtastic/meshtasticd:latest \
  meshtasticd -s -p 4404
```

## Configuring MeshMonitor

### Point to localhost

When using `meshtasticd`, set the node IP to localhost:

```bash
export MESHTASTIC_NODE_IP=localhost
```

Or in your `.env` file:

```env
MESHTASTIC_NODE_IP=localhost
```

### Docker Compose Setup

When running both `meshtasticd` and MeshMonitor in Docker, use Docker's bridge networking:

```yaml
services:
  meshtasticd:
    image: meshtastic/meshtasticd:latest
    container_name: meshtasticd-sim
    command: meshtasticd -s
    volumes:
      - ./config.yaml:/etc/meshtasticd/config.yaml:ro
    ports:
      - "4403:4403"
    restart: unless-stopped

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    environment:
      - MESHTASTIC_NODE_IP=meshtasticd
      - MESHTASTIC_NODE_PORT=4403
    ports:
      - "8080:3001"
    depends_on:
      - meshtasticd
    restart: unless-stopped
```

Create the `config.yaml` file in the same directory:

```yaml
# config.yaml
Lora:
  Module: sx1262
  DIO2_AS_RF_SWITCH: true
  CS: 1
  IRQ: 2
  Busy: 3
  Reset: 4

Webserver:
  Port: 80

General:
  MACAddress: AA:BB:CC:DD:EE:01
```

Then start both services:

```bash
docker compose up -d
```

MeshMonitor will be accessible at `http://localhost:8080`.

::: warning Important Notes
- MeshMonitor's internal port is **3001**, not 8080. Always map to port 3001.
- Use the Docker service name (`meshtasticd`) as the IP address when using bridge networking.
- Do **not** use `network_mode: host` with port mappings - they are mutually exclusive.
:::

::: tip Using a real radio?
The example above runs in **simulation mode** (the `-s` flag) and does **not** talk to attached hardware. To use a physical USB LoRa radio, drop `-s` and pass the radio's device(s) into the container — see [Docker Compose with Physical LoRa Hardware](#docker-compose-with-physical-lora-hardware-no-simulation) below.
:::

### Docker Compose with Physical LoRa Hardware (No Simulation)

To run `meshtasticd` with a **real USB LoRa radio** (e.g., Heltec, RAK, Lilygo):

1. **Omit the `-s` flag** from the command
2. **Pass through the USB device** to the container

```yaml
services:
  meshtasticd:
    image: meshtastic/meshtasticd:latest
    container_name: meshtasticd
    command: meshtasticd  # No -s flag = real hardware mode
    volumes:
      - ./config.yaml:/etc/meshtasticd/config.yaml:ro
    devices:
      - /dev/bus/usb:/dev/bus/usb  # Pass through USB LoRa radio
    ports:
      - "4403:4403"
    restart: unless-stopped

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    environment:
      - MESHTASTIC_NODE_IP=meshtasticd
      - MESHTASTIC_NODE_PORT=4403
    ports:
      - "8080:3001"
    depends_on:
      - meshtasticd
    restart: unless-stopped
```

You'll also need a `config.yaml` configured for your specific radio. Set `Lora.Module` to match your chipset — commonly `sx1262`, `sx1276`, `sx1280`, or `llcc68` — along with the correct pin mappings for your board. See the [Meshtastic Portduino documentation](https://meshtastic.org/docs/hardware/devices/linux-native-hardware/) for per-board pinouts and the full list of supported modules.

::: tip Passing through additional devices
`/dev/bus/usb` covers most USB-attached radios, but depending on your hardware you may need to pass through additional device nodes — for example a specific serial adapter (`/dev/ttyUSB0`, `/dev/ttyACM0`), or, for SPI/GPIO HAT radios, `/dev/spidev*` and `/dev/gpiochip*`. List your devices before and after plugging in the radio to see which nodes appear, then add each one under the service's `devices:` list:

```bash
lsusb
ls /dev/ttyUSB* /dev/ttyACM* /dev/spidev* /dev/gpiochip* 2>/dev/null
```
:::

::: warning USB Permissions
If the container can't access the USB device, ensure your user has permissions:

```bash
# Check device is detected
lsusb

# Add your user to the dialout group (log out and back in)
sudo usermod -a -G dialout $USER
```
:::

::: tip Credit
The physical-hardware configuration above was contributed by @Saucesquatch (corvock). Thanks!
:::

### Using Docker Host Network

If you prefer host networking (no port isolation):

```yaml
services:
  meshtasticd:
    image: meshtastic/meshtasticd:latest
    command: meshtasticd -s
    volumes:
      - ./config.yaml:/etc/meshtasticd/config.yaml:ro
    network_mode: host
    restart: unless-stopped

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    network_mode: host
    environment:
      - MESHTASTIC_NODE_IP=localhost
      - MESHTASTIC_NODE_PORT=4403
    restart: unless-stopped
```

With host networking, MeshMonitor will be accessible at `http://localhost:3001`.

## Initial Configuration

After starting `meshtasticd`, you can configure it using the Meshtastic CLI:

```bash
# Connect to the virtual node
meshtastic --host localhost

# Set your node name
meshtastic --set-owner "My Virtual Node"

# Configure LoRa region
meshtastic --set lora.region US
```

## Testing the Connection

Verify MeshMonitor can connect to your `meshtasticd` instance:

1. Start both containers:
   ```bash
   docker compose up -d
   ```

2. Check meshtasticd logs:
   ```bash
   docker logs meshtasticd-sim
   ```
   You should see router and packet processing messages.

3. Check MeshMonitor logs:
   ```bash
   docker logs meshmonitor
   ```
   Look for `Connection status: connected` message.

4. Access MeshMonitor at `http://localhost:8080`

## Expected Behavior

When running with meshtasticd in simulation mode:

- MeshMonitor will connect and show the simulated node
- You'll see telemetry updates (battery, uptime, etc.)
- Some admin queries may return `NO_RESPONSE` - this is normal for simulated nodes
- The node will appear with a name like "Meshtastic c43b"

## Troubleshooting

### Port Already in Use

If you see "Address already in use" errors:

```bash
# Find what's using port 4403
lsof -i :4403

# Use a different port
docker run ... meshtasticd -s -p 4404
```

### Connection Refused

If MeshMonitor cannot connect:

1. Verify `meshtasticd` is running:
   ```bash
   docker ps | grep meshtasticd
   ```

2. Check meshtasticd logs for errors:
   ```bash
   docker logs meshtasticd-sim
   ```

3. Verify port is accessible:
   ```bash
   nc -zv localhost 4403
   ```

### NO_RESPONSE Warnings

MeshMonitor may show `NO_RESPONSE` warnings for LocalStats requests. This is expected behavior - the simulated node doesn't implement all admin features.

### Docker Networking Issues

Common mistakes:
- Using `network_mode: host` with port mappings (they're mutually exclusive)
- Using `localhost` as IP when containers are on bridge network (use service name instead)
- Mapping to wrong internal port (MeshMonitor uses 3001, not 8080)

## Production Use

### Using systemd

For native installations, create a systemd service file `/etc/systemd/system/meshtasticd.service`:

```ini
[Unit]
Description=Meshtastic Daemon
After=network.target

[Service]
Type=simple
User=meshtastic
ExecStart=/usr/bin/meshtasticd -c /etc/meshtasticd/config.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl enable meshtasticd
sudo systemctl start meshtasticd
```

### Using Docker

Run `meshtasticd` as a Docker container:

```bash
docker run -d \
  --name meshtasticd \
  --restart unless-stopped \
  -v ./config.yaml:/etc/meshtasticd/config.yaml:ro \
  -p 4403:4403 \
  meshtastic/meshtasticd:latest \
  meshtasticd -s
```

## Next Steps

- [Connect Serial/USB devices](/configuration/serial-bridge) with the Serial Bridge
- [Connect Bluetooth devices](/configuration/ble-bridge) with the BLE Bridge
- [Configure SSO](/configuration/sso) for authentication
- [Set up a reverse proxy](/configuration/reverse-proxy) for external access
- [Deploy to production](/configuration/production) with proper monitoring
