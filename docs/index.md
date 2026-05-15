---
layout: home

hero:
  name: "MeshMonitor"
  text: "One dashboard. Every mesh."
  tagline: "Self-hosted Meshtastic monitoring for multi-source networks — real-time maps, alerts, per-source permissions, and full network awareness."
  image:
    src: /images/features/dashboard-multi-source.png
    alt: MeshMonitor dashboard showing multiple Meshtastic sources
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/yeraze/meshmonitor
features:
  - icon: 🛰️
    title: Multi-Source Networks
    details: Connect to multiple Meshtastic nodes at once over TCP — including Serial or BLE nodes fronted by the Serial Bridge or BLE Bridge sidecars — plus USB-attached MeshCore companions and repeaters managed from the Sources sidebar (TCP MeshCore via env-var bootstrap; MQTT source type coming soon). Unified map, messages, telemetry, and traceroute views stay scoped per-source with a single click. Ideal for multi-site deployments, backup gateways, and combining a home node with a repeater.

  - icon: 🔐
    title: Per-Source Permissions
    details: Grant users access to specific sources, not the whole deployment. Shared dashboards, separate operators, and read-only guests all coexist. Admin-managed Users page, SSO support, and MFA round out the access model.

  - icon: 🌐
    title: Per-Source Virtual Node
    details: Each TCP source can expose its own Virtual Node endpoint on its own port. Multiple Meshtastic mobile apps connect simultaneously through MeshMonitor, with message queuing, config caching, and stability for 3-5+ concurrent clients.

  - icon: 🗺️
    title: Interactive Map View
    details: Visualize your mesh network on an interactive map with real-time node positions, signal strength indicators, and network topology. Import GeoJSON, KML, and KMZ overlays to layer zone maps or emergency boundaries. Enable a polar grid overlay for RF coverage visualization.

  - icon: 📊
    title: Analytics & Telemetry
    details: Track message statistics, node health, signal quality (SNR), and network performance over time with detailed charts and graphs. Switch between chart, gauge, and numeric display modes for telemetry widgets. Unified telemetry view with search, sort, and source filtering.

  - icon: 💬
    title: Message Management
    details: View, send, and manage messages across your mesh network. Unified cross-source messages view with per-source isolation. Multi-channel support, drag and drop channel reordering, tapbacks, replies, and full message search.

  - icon: ⚡
    title: Automation & Triggers
    details: Create powerful automations with Auto-Responders, Scheduled Messages, Auto-Traceroute, and Geofence Triggers. Define geographic zones and trigger responses when nodes enter, exit, or remain inside — perfect for arrival notifications, asset tracking, and proximity alerts. Extend further with custom Python or Bash scripts.

  - icon: 📬
    title: Store & Forward
    details: Work with Store & Forward servers on your mesh — retrieve history from S&F peers, flag S&F server nodes on the map, and keep messages flowing across offline gaps.

  - icon: 🔒
    title: Security Monitoring
    details: Automatic detection of weak encryption keys and duplicate key issues. Built-in authentication with local accounts, MFA/TOTP, SSO (OIDC), and a full audit log of admin actions.

  - icon: 🔔
    title: Push Notifications
    details: Receive real-time alerts for new messages and per-source events on iOS, Android, and desktop — even when the app is closed. Apprise integration for email, Slack, Discord, Telegram, and more. Zero configuration, works with HTTPS.

  - icon: 🖥️
    title: Remote Administration
    details: Change node connections on-the-fly without container restarts. Configure device settings, manage channels, run the Quick Node Configurator, and push OTA firmware updates through a connected gateway — all from the web interface.

  - icon: 🧩
    title: Custom Map Tile Servers
    details: Configure custom map tile servers with support for both vector (.pbf) and raster (.png) tiles. Enable offline operation, custom styling, and privacy-focused mapping. Works with TileServer GL, nginx caching proxy, and standard XYZ tile servers. Upload custom MapLibre style JSON for fully branded or offline-first map appearances.

  - icon: 🎨
    title: Customizable Themes
    details: Choose from 15 built-in themes or create your own with the visual theme editor. Includes color-blind friendly options, WCAG AAA compliant high-contrast themes, and full import/export support for sharing custom themes.

  - icon: ☀️
    title: Solar Monitoring
    details: Integrate with forecast.solar to visualize expected solar production alongside telemetry data. Run the cross-source Solar Monitoring Analysis report to auto-detect solar-powered nodes, project battery state across the forecast horizon, and surface nodes predicted at risk. Perfect for optimizing off-grid deployments.

  - icon: 💻
    title: Desktop & Mobile
    details: Native desktop app for Windows and macOS — no server, no Docker. Progressive Web App (PWA) for iOS and Android with a collapsible sidebar on small screens. System tray integration keeps your network awareness one click away.

  - icon: 🐳
    title: Flexible Deployment
    details: Deploy with Docker Compose, Kubernetes (Helm charts included), Proxmox LXC, or bare metal. SQLite, PostgreSQL, or MySQL backends. System backup, one-click auto-upgrade, and reverse-proxy-friendly configuration out of the box.
---

## Quick Start

::: tip Need a Custom Configuration?
Use our **[Interactive Configurator](/configurator)** to generate a customized `docker-compose.yml` for your specific setup (TCP, BLE, Serial, reverse proxy, etc.).
:::

Get MeshMonitor running in under 60 seconds with Docker Compose:

```bash
cat > docker-compose.yml << 'EOF'
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100  # Seeds the first source on first boot; add more from Dashboard → Sources
      - ALLOWED_ORIGINS=http://localhost:8080  # Required for CORS
    restart: unless-stopped

volumes:
  meshmonitor-data:
EOF

docker compose up -d
```

Access at `http://localhost:8080` and login with username `admin` and password `changeme`.

**That's it!** No SESSION_SECRET or complex configuration needed for basic usage. MeshMonitor works over HTTP out of the box.

For production deployments, Kubernetes, reverse proxies, and advanced configurations, see the [Production Deployment Guide](/configuration/production).

## What is Meshtastic?

[Meshtastic](https://meshtastic.org/) is an open-source, off-grid, decentralized mesh network built on affordable, low-power devices. MeshMonitor provides a web-based interface to monitor and manage your Meshtastic network.

## Key Features

### Network Visualization
View your entire mesh network on an interactive map, with nodes colored by their signal strength and connectivity status. Track node positions, signal quality, and network topology in real-time.

### Message History
Access complete message history across all channels. Search, filter, and export messages for analysis or record-keeping.

### Node Management
Monitor individual node health, battery levels, environmental telemetry, and connection status. View detailed statistics for each node in your network.

### Channel Configuration
Manage multiple channels, view channel settings, and monitor message flow across different communication channels in your mesh.

### Security Monitoring
Automatically detect and flag nodes with security vulnerabilities. MeshMonitor identifies low-entropy (weak) encryption keys and duplicate keys shared across multiple nodes. Visual warnings and filtering options help you maintain a secure mesh network.

## Deployment Options

MeshMonitor supports multiple deployment scenarios:

- **Docker Compose**: Quick local deployment for testing and development
- **Kubernetes**: Production-ready deployment with Helm charts
- **Bare Metal**: Direct installation with Node.js for custom environments

## Screenshots

### Multi-Source Dashboard
Every source your deployment touches shows up in the sidebar with its own health, map pin colour, and unified or source-scoped views. Meshtastic TCP (with Serial/BLE via the bridge sidecars) and USB-attached MeshCore are first-class today; TCP MeshCore is supported via the legacy env-var bootstrap path, and MQTT is coming soon.

![Multi-Source Dashboard](/images/features/dashboard-multi-source.png)

### Sources Management
Add, edit, restart, or delete any upstream connection from the dashboard. No env-var edits, no container restarts.

![Source options menu](/images/features/sources-options-menu.png)

### Edit Source with Virtual Node
Each TCP source gets its own Virtual Node endpoint, its own auto-responder, its own scheduler — all in one Edit Source dialog.

![Edit Source dialog](/images/features/edit-source-dialog.png)

### Per-Source Permissions
Grant a user admin rights on one source, read-only on another, and hide a third. Per-channel controls sit right alongside the source scope dropdown.

![Per-source permissions](/images/features/per-source-permissions.png)

### Global Settings
Theme, language, map defaults, push keys, backup schedule — the things that apply to the whole deployment — live on one screen.

![Global Settings](/images/features/global-settings.png)

### Unified Messages
Read and search messages across every source from a single view, with an optional per-source filter.

![Unified Messages](/images/features/unified-messages.png)

### Unified Telemetry
Telemetry charts, gauges, and tables aggregated across every connected source.

![Unified Telemetry](/images/features/unified-telemetry.png)

### Interactive Map
Track your entire mesh network at a glance with the interactive map and real-time node positions.

![Interactive Map](/images/main.png)

### Mobile
Collapsible sidebar and responsive layout for iOS and Android PWAs.

![Mobile sidebar](/images/features/mobile-sidebar-expanded.png)

## Community & Support

- **Discord**: [Join our Discord](https://discord.gg/JVR3VBETQE) - Chat with the community and get help
- **GitHub**: [github.com/yeraze/meshmonitor](https://github.com/yeraze/meshmonitor)
- **Issues**: Report bugs and request features on GitHub Issues
- **License**: BSD-3-Clause

---

Ready to get started? Head over to the [Getting Started](/getting-started) guide!
