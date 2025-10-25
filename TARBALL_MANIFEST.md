# MeshMonitor BLE Bridge - Tarball Package

**File:** `meshmonitor-ble-bridge.tar.gz` (17 KB)

## What This Is

A complete, self-contained package for the MeshMonitor BLE Bridge project. Extract this on any machine with Docker and Bluetooth to set up a bridge between BLE Meshtastic devices and MeshMonitor.

## Extraction

```bash
tar -xzf meshmonitor-ble-bridge.tar.gz
cd meshmonitor-ble-bridge
```

## Package Contents

### Root Level Files
```
README.md                    # Main documentation and overview
QUICK_START.md              # 5-minute setup guide
docker-compose.ble.yml      # Docker Compose overlay for MeshMonitor
```

### src/ Directory - Source Code
```
ble_tcp_bridge.py           # Main Python bridge application (347 lines)
Dockerfile                  # Container build instructions
.dockerignore              # Docker build exclusions
```

### docs/ Directory - Documentation
```
CLAUDE_BLE_BRIDGE.md       # Claude Code context - START HERE for development
BLE_TCP_BRIDGE_ANALYSIS.md # Comprehensive technical analysis (541 lines)
README_BLE_BRIDGE.md       # User guide and troubleshooting
DEPLOY_BLE_BRIDGE.md       # Production deployment instructions
```

## Quick Start (5 minutes)

```bash
# 1. Extract
tar -xzf meshmonitor-ble-bridge.tar.gz
cd meshmonitor-ble-bridge

# 2. Build
cd src
docker build -t meshmonitor-ble-bridge .

# 3. Scan for device
docker run --rm --privileged --network host \
  -v /var/run/dbus:/var/run/dbus \
  meshmonitor-ble-bridge --scan

# 4. Start bridge (replace MAC address)
docker run -d --name ble-bridge \
  --privileged --network host \
  --restart unless-stopped \
  -v /var/run/dbus:/var/run/dbus \
  -v /var/lib/bluetooth:/var/lib/bluetooth:ro \
  meshmonitor-ble-bridge AA:BB:CC:DD:EE:FF

# 5. Point MeshMonitor to <bridge-ip>:4403
```

Full instructions in `QUICK_START.md`

## For Claude Code Development

### Setup
```bash
# Extract tarball
tar -xzf meshmonitor-ble-bridge.tar.gz
cd meshmonitor-ble-bridge

# Open in Claude Code
code .  # or your preferred method
```

### Key File for Claude
`docs/CLAUDE_BLE_BRIDGE.md` contains:
- Complete architectural overview
- Protocol translation details
- Critical implementation notes
- Known issues and solutions
- Development workflow
- Testing procedures
- Troubleshooting guide

This gives Claude Code full context to:
- Debug issues
- Add features
- Optimize performance
- Update documentation
- Fix bugs

### File Organization for Development

**Start with:**
1. `docs/CLAUDE_BLE_BRIDGE.md` - Technical context
2. `src/ble_tcp_bridge.py` - Main application

**Reference:**
3. `docs/BLE_TCP_BRIDGE_ANALYSIS.md` - Protocol details
4. `docs/README_BLE_BRIDGE.md` - Usage patterns

**Build & Deploy:**
5. `src/Dockerfile` - Container configuration
6. `docker-compose.ble.yml` - Orchestration
7. `docs/DEPLOY_BLE_BRIDGE.md` - Deployment guide

## Use Cases

### 1. End User - Connect BLE Device to MeshMonitor
**Read:** `README.md` → `QUICK_START.md` → `docs/README_BLE_BRIDGE.md`

### 2. System Administrator - Production Deployment
**Read:** `README.md` → `docs/DEPLOY_BLE_BRIDGE.md`

### 3. Developer - Add Features/Fix Bugs
**Read:** `docs/CLAUDE_BLE_BRIDGE.md` → `src/ble_tcp_bridge.py`

### 4. Technical Analysis - Understanding the System
**Read:** `docs/BLE_TCP_BRIDGE_ANALYSIS.md`

## Key Technical Details (TL;DR)

**What it does:**
- Connects to Meshtastic device via BLE
- Translates BLE ↔ TCP protocols
- Exposes TCP server on port 4403
- Allows MeshMonitor to use BLE-only devices

**Requirements:**
- Docker
- Bluetooth adapter
- Linux (preferred), macOS, or Windows

**Architecture:**
```
MeshMonitor ←[TCP 4403]→ BLE Bridge ←[BLE]→ Meshtastic Device
```

**Protocol Translation:**
- BLE: Raw protobufs on GATT characteristics
- TCP: Framed `[0x94][0xC3][LENGTH][PROTOBUF]`

## File Sizes
```
Total package:              17 KB (compressed)
Source code:                ~12 KB
Documentation:              ~80 KB (uncompressed)
Docker image (built):       224 MB
```

## Claude Code Prompt Suggestion

When starting a Claude Code session with this package:

```
I'm working on the MeshMonitor BLE Bridge. I've extracted the tarball.
Please read docs/CLAUDE_BLE_BRIDGE.md for complete technical context.

Current task: [describe what you want to work on]
```

Claude will have full context including:
- Architecture and design decisions
- Protocol specifications
- Known issues and solutions
- Development workflow
- Testing procedures

## Support

For issues or questions:
- Check `docs/README_BLE_BRIDGE.md` troubleshooting section
- Review `docs/CLAUDE_BLE_BRIDGE.md` for technical details
- MeshMonitor repo: https://github.com/Yeraze/meshmonitor
- Meshtastic docs: https://meshtastic.org

## License

BSD-3-Clause (same as MeshMonitor)

## Version Info

**Created:** 2025-10-21
**Python:** 3.11+
**Docker:** Any recent version
**Meshtastic Library:** 2.3.12
**Bleak Library:** 0.21.1
