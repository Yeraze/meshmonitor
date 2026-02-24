# Using meshtasticd for Virtual Nodes

`meshtasticd` is a virtual Meshtastic node daemon that runs Meshtastic firmware on Linux using portduino. It's perfect for development, testing, and running virtual mesh networks without physical hardware.

## What is meshtasticd?

`meshtasticd` provides **virtual node simulation** - running a software Meshtastic node without physical hardware.

Use cases include:

- Testing MeshMonitor without physical hardware
- Running a virtual Meshtastic node on a server or Raspberry Pi
- Developing and testing mesh applications
- Creating virtual mesh networks for simulation and testing

## Physical Device Connections

**For physical Meshtastic devices, use the appropriate bridge:**

- **Serial/USB devices:** Use the [Meshtastic Serial Bridge](/configuration/serial-bridge) instead
- **Bluetooth (BLE) devices:** Use the [MeshMonitor BLE Bridge](/configuration/ble-bridge) instead

`meshtasticd` is designed for virtual node simulation, not for connecting physical hardware.

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
