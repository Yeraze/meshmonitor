# Tested Hardware Configurations

This page documents the hardware configurations that are actively used during MeshMonitor development and testing. These setups are verified working with each release.

::: tip Community Contributions
Running MeshMonitor on hardware not listed here? We'd love to hear about it! Open an [issue](https://github.com/yeraze/meshmonitor/issues) or join our [Discord](https://discord.gg/JVR3VBETQE) to share your setup.
:::

## Overview

All development and testing is performed on **Linux** hosts (Ubuntu and Raspbian) running MeshMonitor via **Docker**. The Meshtastic nodes connect to MeshMonitor through various transport methods (WiFi/TCP, Serial Bridge, BLE Bridge).

## Tested Configurations

### StationG2 — WiFi (TCP)

| Component | Details |
|-----------|---------|
| **Device** | StationG2 |
| **Meshtastic Role** | `CLIENT_BASE` |
| **Connection** | WiFi (TCP on port 4403) |
| **Host OS** | Ubuntu Linux |
| **MeshMonitor** | Docker |

The StationG2 is the primary development node. It connects to MeshMonitor over the local WiFi network using the standard TCP connection on port 4403. This is the simplest and most common configuration.

```yaml
# docker-compose.yml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100  # StationG2 IP
```

---

### MuziWorks H1 (Heltec V3) — WiFi (TCP)

| Component | Details |
|-----------|---------|
| **Device** | MuziWorks H1 (Heltec V3 based) |
| **Meshtastic Role** | `CLIENT_MUTE` |
| **Connection** | WiFi (TCP on port 4403) |
| **Host OS** | Ubuntu Linux |
| **MeshMonitor** | Docker |

The MuziWorks H1 is configured in `CLIENT_MUTE` mode and connects over WiFi. This verifies MeshMonitor works with muted/passive nodes that don't actively transmit but still report telemetry and position data.

---

### MuziWorks H1 (Heltec V3) — BLE Bridge

| Component | Details |
|-----------|---------|
| **Device** | MuziWorks H1 (Heltec V3 based) |
| **Connection** | Bluetooth Low Energy via [BLE Bridge](/configuration/ble-bridge) |
| **Host OS** | Ubuntu Linux |
| **MeshMonitor** | Docker |

This configuration uses the [MeshMonitor BLE Bridge](/configuration/ble-bridge) (`meshtastic_ble_bridge`) to connect to the Heltec V3 over Bluetooth. The BLE Bridge creates a TCP proxy that MeshMonitor connects to as if it were a WiFi node.

This setup is also used for testing on **macOS** and **Windows** (Desktop App).

```yaml
# docker-compose.yml with BLE Bridge
services:
  ble-bridge:
    image: ghcr.io/yeraze/meshtastic_ble_bridge:latest
    privileged: true
    network_mode: host
    environment:
      - BLE_ADDRESS=AA:BB:CC:DD:EE:FF  # Your device's BLE address

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=localhost
```

---

### MuziWorks H1 (Heltec V3) — USB Serial Bridge

| Component | Details |
|-----------|---------|
| **Device** | MuziWorks H1 (Heltec V3 based) |
| **Connection** | USB via [Serial Bridge](/configuration/serial-bridge) |
| **Host OS** | Ubuntu Linux |
| **MeshMonitor** | Docker |

This configuration uses the [Meshtastic Serial Bridge](/configuration/serial-bridge) (`meshtastic_serial_bridge`) to expose the USB-connected device as a TCP socket. This is the same bridge used for Mac and Windows desktop testing.

```yaml
# docker-compose.yml with Serial Bridge
services:
  serial-bridge:
    image: ghcr.io/yeraze/meshtastic_serial_bridge:latest
    devices:
      - /dev/ttyUSB0:/dev/ttyUSB0
    environment:
      - SERIAL_PORT=/dev/ttyUSB0

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=serial-bridge
```

---

### Heltec V4 — Serial Bridge on Raspberry Pi

| Component | Details |
|-----------|---------|
| **Device** | Heltec V4 |
| **Connection** | USB Serial via [Serial Bridge](/configuration/serial-bridge) |
| **Host OS** | Raspbian (Raspberry Pi 3B+) |
| **MeshMonitor** | Docker |

This configuration runs MeshMonitor on a Raspberry Pi 3B+ with a Heltec V4 connected via USB. The Serial Bridge exposes the device over TCP. This verifies ARM compatibility and low-resource operation.

```yaml
# docker-compose.yml on Raspberry Pi
services:
  serial-bridge:
    image: ghcr.io/yeraze/meshtastic_serial_bridge:latest
    devices:
      - /dev/ttyUSB0:/dev/ttyUSB0
    environment:
      - SERIAL_PORT=/dev/ttyUSB0

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=serial-bridge
```

## Host Platforms

All tested configurations run on Linux:

| Platform | Architecture | Notes |
|----------|-------------|-------|
| **Ubuntu Linux** | x86_64 | Primary development platform |
| **Raspbian** | ARM (Raspberry Pi 3B+) | Verifies ARM Docker image compatibility |

The Desktop App (Tauri) is additionally tested on **macOS** and **Windows** using the BLE Bridge and Serial Bridge configurations above.

## Connection Methods Summary

| Method | Bridge Required | Latency | Setup Complexity |
|--------|----------------|---------|-----------------|
| **WiFi (TCP)** | None | Low | Easiest — just set the IP |
| **USB Serial** | [Serial Bridge](/configuration/serial-bridge) | Low | Moderate — needs USB passthrough |
| **Bluetooth (BLE)** | [BLE Bridge](/configuration/ble-bridge) | Medium | Moderate — needs BLE permissions |

## Support Development

MeshMonitor is a free, open-source project. If you find it useful, consider supporting development:

**[Support on Ko-fi](https://ko-fi.com/yeraze)**
