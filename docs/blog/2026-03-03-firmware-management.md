---
id: news-2026-03-03-firmware-management
title: MeshMonitor v3.8.0 - Gateway Firmware Management
date: '2026-03-03T18:00:00Z'
category: feature
priority: important
minVersion: 3.8.0
---
MeshMonitor v3.8.0 introduces **Gateway OTA Firmware Updates**, allowing administrators to check for, download, and flash Meshtastic firmware updates directly from the MeshMonitor UI.

## Gateway Firmware Management (Experimental)

This feature is still relatively experimental. Admins can now manage firmware on the directly-connected gateway node through a guided step-by-step wizard in System Settings — no SSH or CLI access required.

### Key Features

- **Release Channels** — Choose from Stable, Alpha, or a custom firmware URL
- **Version Browser** — Browse recent releases with rollback support
- **Automatic Config Backup** — Device configuration is backed up before every flash
- **Step-by-Step Wizard** — Preflight checks, backup, download, extract, flash, and verify — each step with confirmation
- **Live Progress** — Real-time streaming of flash output via WebSocket
- **Background Polling** — Configurable interval (default 6 hours) checks for new releases automatically
- **Hardware Matching** — Automatically selects the correct firmware binary for your device

### Important Notes

- **Docker only** — OTA firmware updates require a Docker deployment (not available in the Tauri desktop app)
- **Wi-Fi devices only** — Your gateway node must be connected via Wi-Fi/IP (not serial or BLE)
- **Admin access required** — Only administrators can access firmware management

[Read more about Firmware OTA Updates](https://meshmonitor.org/firmware-ota-prerequisites)

## Other Improvements

- **Bell and position broadcast buttons** — New quick-action buttons in Channels and Messages tabs ([#2113](https://github.com/Yeraze/meshmonitor/pull/2117), [#2114](https://github.com/Yeraze/meshmonitor/pull/2117))
- **Favorite lock protection** — Manual favorites are now protected from being overridden by auto-favorite ([#2115](https://github.com/Yeraze/meshmonitor/pull/2115))
- **Per-node geofence cooldowns** — Geofence triggers now support per-node cooldown periods ([#2105](https://github.com/Yeraze/meshmonitor/pull/2105))
- **NodeNum reboot fix** — Correctly handles node number changes on device reboot ([#2106](https://github.com/Yeraze/meshmonitor/pull/2106))
- **Message status documentation** — Improved tooltip and FAQ documentation for message delivery status icons ([#2118](https://github.com/Yeraze/meshmonitor/issues/2118))
- **Dependency updates** — Updated mysql2, maplibre-gl, pg, and other dependencies
