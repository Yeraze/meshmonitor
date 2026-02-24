# MeshMonitor Desktop

A lightweight Windows desktop application that runs MeshMonitor as a system tray service.

## Overview

MeshMonitor Desktop is built with [Tauri](https://tauri.app/), a Rust-based framework for building lightweight desktop applications. It bundles the MeshMonitor backend server and Node.js runtime, allowing users to run MeshMonitor without Docker or a dedicated server.

## Architecture

```
┌─────────────────────────────────────────────┐
│           Tauri Desktop App (~8MB)          │
│  ┌───────────────────────────────────────┐  │
│  │         System Tray Icon              │  │
│  │  - Open MeshMonitor                   │  │
│  │  - Settings (node IP, port)           │  │
│  │  - Open Data Folder                   │  │
│  │  - Quit                               │  │
│  └───────────────────────────────────────┘  │
│                    │                        │
│                    ▼                        │
│  ┌───────────────────────────────────────┐  │
│  │    Node.js Backend (sidecar)          │  │
│  │    dist/server/server.js + node       │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
                    │
                    ▼ localhost:8080
          ┌─────────────────┐
          │  User's Browser │
          └─────────────────┘
```

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (1.70+)
- [Node.js](https://nodejs.org/) (20+)
- Windows 10/11 (for full testing)

### Setup

1. Build the main project first:
```bash
# From project root
npm ci
npm run build
```

2. Install desktop dependencies:
```bash
cd desktop
npm install
```

3. Run in development mode:
```bash
npm run tauri:dev
```

4. Build release:
```bash
npm run tauri:build
```

### Project Structure

```
desktop/
├── src-tauri/
│   ├── Cargo.toml          # Rust dependencies
│   ├── tauri.conf.json     # Tauri configuration
│   ├── capabilities/       # Permission definitions
│   │   └── default.json
│   ├── icons/              # App icons
│   └── src/
│       ├── main.rs         # Entry point
│       ├── lib.rs          # Library exports
│       ├── config.rs       # Settings management
│       └── tray.rs         # System tray setup
├── src/
│   └── index.html          # Settings UI
├── package.json            # npm scripts
└── README.md               # This file
```

### Configuration

Settings are stored in platform-appropriate locations:

| Platform | Config Path |
|----------|-------------|
| Windows | `%APPDATA%\MeshMonitor\config.json` |
| macOS | `~/Library/Application Support/MeshMonitor/config.json` |
| Linux | `~/.config/meshmonitor/config.json` |

### Environment Variables

The desktop app passes these environment variables to the backend:

| Variable | Source |
|----------|--------|
| `MESHTASTIC_NODE_IP` | User configuration |
| `MESHTASTIC_TCP_PORT` | User configuration (default: 4403) |
| `PORT` | User configuration (default: 8080) |
| `DATABASE_PATH` | Platform data directory |
| `SESSION_SECRET` | Auto-generated on first run |
| `NODE_ENV` | `production` |

## Building for Release

The release workflow automatically:
1. Builds the MeshMonitor server and frontend
2. Downloads Node.js for Windows x64
3. Bundles everything into a Tauri app
4. Creates MSI and NSIS installers
5. Uploads to GitHub Releases with checksums

## License

BSD-3-Clause - see [LICENSE](../LICENSE) for details.
