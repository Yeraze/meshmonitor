---
layout: home

hero:
  name: "MeshMonitor"
  text: "One dashboard. Every mesh."
  tagline: "Self-hosted multi-protocol mesh monitoring for Meshtastic, MeshCore, and MQTT — real-time maps, alerts, per-source permissions, and full network awareness."
  image:
    src: /images/features/dashboard-multi-source.png
    alt: MeshMonitor dashboard showing Meshtastic, MeshCore, and MQTT sources side by side
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/yeraze/meshmonitor
features:
  - icon: 🛰️
    title: Multi-Protocol, Multi-Source
    details: Connect Meshtastic (TCP, Serial, BLE), MeshCore, and MQTT brokers all at once — mix and match in one dashboard. Per-source maps, messages, telemetry, and traceroutes. No restart to add or remove a source.

  - icon: 📡
    title: MeshCore Support
    details: First-class MeshCore companions and repeaters living alongside your Meshtastic nodes. Per-source permissions, a multi-pane page with channels, DMs, and telemetry, and contacts plotted on the unified map.

  - icon: 🌉
    title: Embedded MQTT Broker & Bridge
    details: Host an MQTT broker inside MeshMonitor, run standalone client bridges to upstreams, or combine the two. Filter what crosses the boundary by topic, channel, portnum, or geographic bounding box — your local mesh stays clean without firmware changes.

  - icon: 🔐
    title: Per-Source Permissions
    details: Grant users access to specific sources, not the whole deployment. Local accounts, SSO (OIDC), MFA, and a full admin audit log.

  - icon: 🌐
    title: Per-Source Virtual Node
    details: Each TCP source exposes its own Virtual Node endpoint. Run multiple Meshtastic mobile apps through MeshMonitor with message queuing and config caching.

  - icon: 🗺️
    title: Interactive Map
    details: Real-time node positions, signal-strength indicators, and topology overlays. GeoJSON / KML / KMZ imports for zones, plus an optional polar grid for RF coverage.

  - icon: 📊
    title: Analytics & Telemetry
    details: Charts, gauges, and numeric widgets across every source. Unified telemetry views with search, sort, and per-source filtering.

  - icon: 💬
    title: Messages
    details: Unified cross-source view with per-source filters. Multi-channel, drag-and-drop reorder, tapbacks, replies, full-text search.

  - icon: ⚡
    title: Automation & Triggers
    details: Auto-Responders, Scheduled Messages, Auto-Traceroute, and Geofence Triggers. Extend with custom Python or Bash scripts.

  - icon: 📬
    title: Store & Forward
    details: Retrieve history from S&F peers, flag S&F servers on the map, and keep messages flowing across offline gaps.

  - icon: 🔒
    title: Security Monitoring
    details: Automatic detection of weak or duplicate encryption keys across your nodes. Full admin audit log of every privileged action.

  - icon: 🔔
    title: Push Notifications
    details: Real-time alerts on iOS, Android, and desktop — even when the app is closed. Apprise for email, Slack, Discord, Telegram, and more.

  - icon: 🖥️
    title: Remote Administration
    details: Configure devices, manage channels, and push OTA firmware updates through a connected gateway — all from the web UI, no SSH or CLI.

  - icon: 🧩
    title: Custom Map Tiles
    details: Bring your own vector or raster tiles (TileServer GL, nginx, XYZ). Upload custom MapLibre styles for branded or offline-first maps.

  - icon: 🎨
    title: Customizable Themes
    details: 15 built-in themes plus a visual editor. Color-blind friendly and WCAG AAA high-contrast variants. Import / export to share.

  - icon: ☀️
    title: Solar Monitoring
    details: forecast.solar projections alongside telemetry. Auto-detect solar nodes and surface ones predicted at risk for off-grid deployments.

  - icon: 💻
    title: Desktop & Mobile
    details: Native desktop app for Windows and macOS. Progressive Web App for iOS and Android with a collapsible sidebar and system-tray integration.

  - icon: 🐳
    title: Flexible Deployment
    details: Docker Compose, Kubernetes (Helm), Proxmox LXC, or bare metal. SQLite, PostgreSQL, or MySQL. Reverse-proxy-friendly with one-click auto-upgrade.
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

## What can MeshMonitor monitor?

MeshMonitor speaks three off-grid mesh ecosystems and treats them as peers in one deployment:

- **[Meshtastic](https://meshtastic.org/)** — an open-source, off-grid, decentralized mesh network built on affordable, low-power devices. Connect over TCP, Serial (via the [Serial Bridge](/configuration/serial-bridge)), or BLE (via the [BLE Bridge](/configuration/ble-bridge)).
- **[MeshCore](/features/meshcore)** — companions and repeaters connected over USB or TCP, alongside or instead of Meshtastic.
- **MQTT** — connect to an external MQTT broker as a read-only source, or run the [embedded broker](/features/mqtt-broker) with bidirectional bridges to public upstreams.

Pick one, mix all three — MeshMonitor's unified views, per-source permissions, and the same automation, telemetry, and map features apply to every source you add.

## Key Features

### Network Visualization
View every connected mesh — Meshtastic, MeshCore, MQTT — on a single interactive map, with nodes colored by signal strength and connectivity status. Track node positions, signal quality, and network topology in real-time.

### Message History
Access complete message history across every source and channel. Search, filter, and export messages for analysis or record-keeping.

### Node Management
Monitor individual node health, battery levels, environmental telemetry, and connection status. View detailed statistics for each node in your network, regardless of source protocol.

### Channel Configuration
Manage multiple channels, view channel settings, and monitor message flow across different communication channels — Meshtastic channels, MeshCore channels, and MQTT topics alike.

### Security Monitoring
Automatically detect and flag nodes with security vulnerabilities. MeshMonitor identifies low-entropy (weak) encryption keys and duplicate keys shared across multiple Meshtastic nodes. Visual warnings and filtering options help you maintain a secure mesh.

## Deployment Options

MeshMonitor supports multiple deployment scenarios:

- **Docker Compose**: Quick local deployment for testing and development
- **Kubernetes**: Production-ready deployment with Helm charts
- **Bare Metal**: Direct installation with Node.js for custom environments

## Screenshots

### Multi-Source Dashboard
Every source your deployment touches shows up in the sidebar with its own health, map pin colour, and unified or source-scoped views. Meshtastic (TCP, plus Serial/BLE via the bridge sidecars), MeshCore (USB or TCP), MQTT brokers, and the embedded MQTT bridge are all first-class — mix and match without a restart.

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
