# Tools Directory

This directory contains utility scripts and tools for MeshMonitor development.

## BLE Bridge

**The BLE Bridge has moved to its own repository:**

🔗 **https://github.com/Yeraze/meshtastic-ble-bridge**

The BLE-to-TCP bridge for connecting Bluetooth Low Energy Meshtastic devices to MeshMonitor is now maintained as a separate project.

### Using the BLE Bridge with MeshMonitor

See `docker-compose.ble.yml` in the root directory for integration instructions.

The compose file uses the pre-built image from GitHub Container Registry:
```
ghcr.io/yeraze/meshtastic-ble-bridge:latest
```

For more information, documentation, and source code, visit the BLE bridge repository.
