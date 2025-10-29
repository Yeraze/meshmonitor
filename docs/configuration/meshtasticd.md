# Using meshtasticd for Virtual Nodes

`meshtasticd` is a virtual Meshtastic node daemon that simulates a Meshtastic device in software. It's perfect for development, testing, and running virtual mesh networks without physical hardware.

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

### From Python Package

The easiest way to install `meshtasticd` is via pip:

```bash
pip install meshtastic
```

This installs both the Meshtastic Python library and the `meshtasticd` daemon.

### From Source

To install from source:

```bash
git clone https://github.com/meshtastic/python.git
cd python
pip install -e .
```

## Running meshtasticd

### Basic Usage

Start `meshtasticd` with a hardware model:

```bash
meshtasticd --hwmodel RAK4631
```

Available hardware models include:
- `RAK4631` - RAK WisBlock Core
- `TBEAM` - TTGO T-Beam
- `TLORA_V2` - TTGO LoRa32 V2
- `HELTEC_V3` - Heltec V3
- `BETAFPV_2400_TX` - BetaFPV 2.4GHz TX

### With Custom Port

By default, `meshtasticd` listens on `localhost:4403`. To specify a different port:

```bash
meshtasticd --hwmodel RAK4631 --port 4404
```

### With Configuration File

You can specify a custom configuration file:

```bash
meshtasticd --hwmodel RAK4631 --config ./meshtastic-config.yaml
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

When running both `meshtasticd` and MeshMonitor in Docker, you need to ensure they can communicate:

```yaml
version: '3.8'

services:
  meshtasticd:
    image: meshtastic/meshtasticd:latest
    command: meshtasticd --hwmodel RAK4631
    ports:
      - "4403:4403"
    networks:
      - mesh-network

  meshmonitor:
    image: meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=meshtasticd
    ports:
      - "8080:8080"
    networks:
      - mesh-network
    depends_on:
      - meshtasticd

networks:
  mesh-network:
    driver: bridge
```

### Using Docker Host Network

Alternatively, use host networking to simplify connectivity:

```yaml
services:
  meshmonitor:
    image: meshmonitor:latest
    network_mode: "host"
    environment:
      - MESHTASTIC_NODE_IP=localhost
```

## Initial Configuration

After starting `meshtasticd`, you may want to configure it using the Meshtastic CLI:

```bash
# Connect to the virtual node
meshtastic --host localhost

# Set your node name
meshtastic --set node.name "My Virtual Node"

# Configure LoRa region
meshtastic --set lora.region US

# Enable WiFi (if desired)
meshtastic --set network.wifi_enabled true
```

## Testing the Connection

Verify MeshMonitor can connect to your `meshtasticd` instance:

1. Start `meshtasticd`:
   ```bash
   meshtasticd --hwmodel RAK4631
   ```

2. In another terminal, test connectivity:
   ```bash
   meshtastic --host localhost --info
   ```

3. Start MeshMonitor and check the logs for successful connection

## Virtual Mesh Network

You can create a virtual mesh network by running multiple `meshtasticd` instances:

```bash
# Terminal 1: First node
meshtasticd --hwmodel RAK4631 --port 4403

# Terminal 2: Second node
meshtasticd --hwmodel TBEAM --port 4404

# Terminal 3: Third node
meshtasticd --hwmodel HELTEC_V3 --port 4405
```

Connect MeshMonitor to any of these nodes, and configure them to communicate with each other using MQTT or other Meshtastic networking features.

## Troubleshooting

### Port Already in Use

If you see "Address already in use" errors:

```bash
# Find what's using port 4403
lsof -i :4403

# Kill the process or use a different port
meshtasticd --hwmodel RAK4631 --port 4404
```

### Connection Refused

If MeshMonitor cannot connect:

1. Verify `meshtasticd` is running:
   ```bash
   ps aux | grep meshtasticd
   ```

2. Check if the port is open:
   ```bash
   netstat -an | grep 4403
   ```

3. Test with the Meshtastic CLI:
   ```bash
   meshtastic --host localhost --info
   ```

### Permission Denied

On Linux, you may need permissions for virtual serial ports:

```bash
sudo usermod -aG dialout $USER
# Log out and back in
```

## Production Use

For production deployments of `meshtasticd`:

### Using systemd

Create a systemd service file `/etc/systemd/system/meshtasticd.service`:

```ini
[Unit]
Description=Meshtastic Daemon
After=network.target

[Service]
Type=simple
User=meshtastic
ExecStart=/usr/local/bin/meshtasticd --hwmodel RAK4631
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
  -p 4403:4403 \
  meshtastic/meshtasticd:latest \
  meshtasticd --hwmodel RAK4631
```

## Next Steps

- [Connect Serial/USB devices](/configuration/serial-bridge) with the Serial Bridge
- [Connect Bluetooth devices](/configuration/ble-bridge) with the BLE Bridge
- [Configure SSO](/configuration/sso) for authentication
- [Set up a reverse proxy](/configuration/reverse-proxy) for external access
- [Deploy to production](/configuration/production) with proper monitoring
