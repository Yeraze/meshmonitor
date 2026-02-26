# MeshMonitor

[![CI](https://github.com/Yeraze/meshmonitor/actions/workflows/ci.yml/badge.svg)](https://github.com/Yeraze/meshmonitor/actions/workflows/ci.yml)
[![PR Tests](https://github.com/Yeraze/meshmonitor/actions/workflows/pr-tests.yml/badge.svg)](https://github.com/Yeraze/meshmonitor/actions/workflows/pr-tests.yml)
[![Docker Image](https://ghcr-badge.egpl.dev/yeraze/meshmonitor/latest_tag?color=%235b4566&ignore=latest,main,dev&label=version&trim=)](https://github.com/Yeraze/meshmonitor/pkgs/container/meshmonitor)
[![Docker Pulls](https://ghcr-badge.egpl.dev/yeraze/meshmonitor/size?color=%235b4566&tag=latest&label=image%20size&trim=)](https://github.com/Yeraze/meshmonitor/pkgs/container/meshmonitor)
[![License](https://img.shields.io/github/license/Yeraze/meshmonitor)](https://github.com/Yeraze/meshmonitor/blob/main/LICENSE)
[![Translation Status](https://hosted.weblate.org/widgets/meshmonitor/-/svg-badge.svg)](https://hosted.weblate.org/engage/meshmonitor/)

A comprehensive web application for monitoring Meshtastic mesh networks over IP. Built with React, TypeScript, and Node.js, featuring a beautiful Catppuccin Mocha dark theme and multi-database support (SQLite, PostgreSQL, MySQL).

![MeshMonitor Interface](docs/images/main.png)

![MeshMonitor Interface](docs/images/channels.png)

## Documentation

For complete documentation, visit **[meshmonitor.org](https://meshmonitor.org/)**

- **[Getting Started Guide](https://meshmonitor.org/getting-started.html)** - Installation and quick start
- **[FAQ](https://meshmonitor.org/faq.html)** - Frequently asked questions and troubleshooting
- **[Configuration](https://meshmonitor.org/configuration/)** - Detailed configuration options
- **[Development](https://meshmonitor.org/development/)** - Contributing and development setup

## Quick Start

Get MeshMonitor running in **60 seconds**:

```bash
# 1. Create docker-compose.yml
cat > docker-compose.yml << 'EOF'
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100  # Change to your node's IP
    restart: unless-stopped

volumes:
  meshmonitor-data:
EOF

# 2. Start MeshMonitor
docker compose up -d

# 3. Open http://localhost:8080
```

**Default login:** `admin` / `changeme` (change after first login!)

For detailed installation instructions, configuration options, and deployment scenarios, see the **[Getting Started Guide](https://meshmonitor.org/getting-started.html)**.

## Deployment Options

MeshMonitor supports multiple deployment methods:

- **🐳 Docker** (Recommended) - Pre-built multi-architecture images with auto-upgrade support
  - [Docker Compose Guide](docs/deployment/DEPLOYMENT_GUIDE.md)
  - Platforms: amd64, arm64, armv7

- **☸️ Kubernetes** - Helm charts for production clusters
  - [Helm Chart](helm/meshmonitor/)
  - GitOps-ready with ArgoCD/Flux support

- **📦 Proxmox LXC** - Lightweight containers for Proxmox VE
  - [Proxmox LXC Guide](docs/deployment/PROXMOX_LXC_GUIDE.md)
  - Pre-built templates available
  - Community-supported alternative

- **🔧 Manual** - Direct Node.js deployment
  - [Manual Installation Guide](docs/deployment/DEPLOYMENT_GUIDE.md#manual-nodejs-deployment)
  - For development or custom setups

- **🖥️ Desktop Apps** - Native applications for Windows and macOS
  - Download from [GitHub Releases](https://github.com/Yeraze/meshmonitor/releases)
  - Runs as a system tray application
  - Windows (.exe) and macOS (.dmg) installers available

## Key Features

- **Real-time Mesh Monitoring** - Live node discovery, telemetry, and message tracking
- **Modern UI** - Catppuccin theme with message reactions and threading
- **Interactive Maps** - Node positions and network topology visualization
- **Multi-Database Support** - SQLite (default), PostgreSQL, and MySQL via Drizzle ORM
- **Notifications** - Web Push and Apprise integration for 100+ services
- **Authentication** - Local and OIDC/SSO support with RBAC
- **Security Monitoring** - Encryption key analysis and vulnerability detection
- **Device Configuration** - Full node configuration UI
- **Virtual Node Server** - Remote TCP access for Meshtastic Python clients
- **REST API** - v1 API with Bearer token authentication for external integrations
- **MeshCore Support** - Optional monitoring for MeshCore mesh networks
- **Docker Ready** - Pre-built multi-architecture images
- **One-click Self-Upgrade** - Automatic upgrades from the UI with backup and rollback
- **System Backup & Restore** - Complete disaster recovery with automated backups

For a complete feature list and technical details, visit **[meshmonitor.org](https://meshmonitor.org/)**.

## Development

### Prerequisites

- Node.js 20+
- Docker (recommended) or local Node.js environment
- A Meshtastic device with WiFi/Ethernet connectivity

### Local Development

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/Yeraze/meshmonitor.git
cd meshmonitor

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Meshtastic node's IP address

# Start development servers
npm run dev:full
```

This starts both the React dev server (port 5173) and the Express API server (port 3001).

### Available Scripts

**Development:**
- `npm run dev` - Start React development server
- `npm run dev:server` - Start Express API server
- `npm run dev:full` - Start both development servers
- `npm run build` - Build React app for production
- `npm run build:server` - Build Express server for production

**Testing & Quality:**
- `npm run test` - Run tests in watch mode
- `npm run test:run` - Run all tests once
- `npm run test:coverage` - Generate coverage report
- `npm run lint` - Run ESLint
- `npm run typecheck` - Run TypeScript compiler checks

## Technology Stack

**Frontend:**
- React 19 with TypeScript
- Vite 7 (build tool)
- CSS3 with Catppuccin theme
- Translation support crowdsourced by [Weblate](https://hosted.weblate.org/projects/meshmonitor/)

**Backend:**
- Node.js with Express 5
- TypeScript
- Drizzle ORM with SQLite, PostgreSQL, and MySQL drivers

**DevOps:**
- Docker with multi-stage builds
- Docker Compose for orchestration
- GitHub Container Registry for images

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

- Development setup
- Testing requirements
- Code style guidelines
- Pull request process
- CI/CD workflows

Quick start:
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes and add tests
4. Run tests locally (`npm run test:run`)
5. Commit with conventional commits (`feat: add amazing feature`)
6. Push and create a Pull Request

## License

This project is licensed under the BSD-3-Clause License - see the [LICENSE](LICENSE) file for details.

## Community & Support

- **Discord**: [Join our Discord](https://discord.gg/JVR3VBETQE) - Chat with the community and get help
- **GitHub Issues**: Report bugs and request features
- **Documentation**: [meshmonitor.org](https://meshmonitor.org/)

## Acknowledgments

- [Meshtastic](https://meshtastic.org/) - Open source mesh networking
- [Catppuccin](https://catppuccin.com/) - Soothing pastel theme
- [React](https://react.dev/) - Frontend framework
- [Drizzle ORM](https://orm.drizzle.team/) - TypeScript ORM
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - SQLite driver

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeraze/meshmonitor&type=date&legend=top-left)](https://www.star-history.com/#Yeraze/meshmonitor&type=date&legend=top-left)

---

**MeshMonitor** - Monitor your mesh, beautifully. 🌐✨

_This application is brought to you with help from [Claude Code](https://claude.ai/code)._
