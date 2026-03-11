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
| **Public Instance** | [meshmonitor.yeraze.com](https://meshmonitor.yeraze.com) |
| **Authentication** | OIDC via Authentik |
| **Reverse Proxy** | Nginx Proxy Manager |

The StationG2 is the primary **production** node and hosts the public MeshMonitor instance at [meshmonitor.yeraze.com](https://meshmonitor.yeraze.com). It connects over the local WiFi network using the standard TCP connection on port 4403. The instance is configured with OIDC single sign-on through [Authentik](https://goauthentik.io/) and sits behind [Nginx Proxy Manager](https://nginxproxymanager.com/) for SSL termination and reverse proxying.

---

### MuziWorks H1 (Heltec V3) — WiFi (TCP)

| Component | Details |
|-----------|---------|
| **Device** | MuziWorks H1 (Heltec V3 based) |
| **Meshtastic Role** | `CLIENT_MUTE` |
| **Connection** | WiFi (TCP on port 4403) |
| **Host OS** | Ubuntu Linux |
| **MeshMonitor** | Docker |

The MuziWorks H1 is the primary **development** node, configured in `CLIENT_MUTE` mode and connected over WiFi. This verifies MeshMonitor works with muted/passive nodes that don't actively transmit but still report telemetry and position data.

---

### MuziWorks H1 (Heltec V3) — BLE & Serial Bridge Testing

| Component | Details |
|-----------|---------|
| **Device** | MuziWorks H1 (Heltec V3 based) |
| **Connections** | USB via [Serial Bridge](/configuration/serial-bridge), BLE via [BLE Bridge](/configuration/ble-bridge) |
| **Host OS** | Ubuntu Linux |
| **MeshMonitor** | Docker |

This node is used to test both bridge connection methods, switching between them as needed:

- **USB Serial Bridge** — Uses the [Meshtastic Serial Bridge](/configuration/serial-bridge) (`meshtastic_serial_bridge`) to expose the USB-connected device as a TCP socket.
- **BLE Bridge** — Uses the [MeshMonitor BLE Bridge](/configuration/ble-bridge) (`meshtastic_ble_bridge`) to connect over Bluetooth Low Energy. The BLE Bridge creates a TCP proxy that MeshMonitor connects to as if it were a WiFi node.

This setup is also used for testing the Desktop App on **macOS** and **Windows**.

---

### Heltec V4 — Serial Bridge on Raspberry Pi

| Component | Details |
|-----------|---------|
| **Device** | Heltec V4 |
| **Connection** | USB Serial via [Serial Bridge](/configuration/serial-bridge) |
| **Host OS** | Raspbian (Raspberry Pi 3B+) |
| **MeshMonitor** | Docker |

This configuration runs MeshMonitor on a Raspberry Pi 3B+ with a Heltec V4 connected via USB. The Serial Bridge exposes the device over TCP. This verifies ARM compatibility and low-resource operation.

This setup is also used to test advanced telemetry features, including **PaxCounter** data collection and communication with a nearby solar-powered Heltec V4 in `CLIENT_BASE` mode equipped with a **BME280 sensor** for weather data (temperature, humidity, barometric pressure).

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

## Pre-Release System Tests

Before every release, MeshMonitor runs a comprehensive system test suite against the development node. These tests build a fresh Docker image from the current code and run end-to-end verification across multiple deployment scenarios.

### Test Suite Overview

| Test | What It Verifies |
|------|-----------------|
| **Configuration Import** | Device configuration import and reboot cycle, channel roles, PSKs, and LoRa settings |
| **Quick Start** | Zero-config deployment — no `SESSION_SECRET` or `COOKIE_SECURE` required, HTTP access, auto-generated admin user, session cookies, node connection, and message exchange |
| **Security** | Node IP and MQTT config hidden from anonymous users, visible to authenticated users, protected endpoints require authentication |
| **V1 API** | REST API with Bearer token authentication, CSRF bypass for API tokens, session-based requests still require CSRF |
| **Reverse Proxy** | Production deployment with `COOKIE_SECURE=true`, HTTPS-ready config, trust proxy, CORS, node connection, and message exchange |
| **Reverse Proxy + OIDC** | OIDC authentication flow with mock provider, session creation, hybrid mode (OIDC + local auth) |
| **Virtual Node CLI** | Virtual Node Server on TCP 4404, Meshtastic Python client connection, node data sync, message send/receive on gauntlet channel |
| **Backup & Restore** | System backup creation, restore into new container via `RESTORE_FROM_BACKUP`, data integrity verification (nodes, messages, settings), audit log confirmation |
| **Database Migration** | SQLite to PostgreSQL migration, SQLite to MySQL migration, data integrity and row count verification |
| **DB Backing Consistency** | All three database backends (SQLite, PostgreSQL, MySQL) tested against the same device, node counts within tolerance, favorite counts identical across backends |

### How It Works

1. A fresh Docker image is built from the current source (no cache)
2. Test containers are spun up with isolated volumes for each scenario
3. The **Configuration Import** test runs first to set the device to a known state — all subsequent tests depend on this
4. Each test deploys MeshMonitor in a different configuration and verifies functionality via API calls
5. A markdown report (`test-results.md`) is generated with pass/fail status for each suite
6. All test containers and volumes are cleaned up automatically

The full test suite source is available in the [`tests/`](https://github.com/yeraze/meshmonitor/tree/main/tests) directory.

## Request Hardware Testing

Want to see a specific device officially tested and supported? You can request it by donating on Ko-fi — include the hardware you'd like tested in the donation description, and we'll do our best to add it to our test lineup.

**[Request Hardware Testing on Ko-fi](https://ko-fi.com/yeraze)**

## Support Development

MeshMonitor is a free, open-source project. If you find it useful, consider supporting development:

**[Support on Ko-fi](https://ko-fi.com/yeraze)**
