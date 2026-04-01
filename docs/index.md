---
layout: home

hero:
  name: "MeshMonitor"
  text: "Your mesh. Your data."
  tagline: "Self-hosted Meshtastic monitoring with real-time maps, alerts, and full network awareness."
  image:
    src: /images/main.png
    alt: MeshMonitor interactive map view
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/yeraze/meshmonitor
features:
  - icon: 🗺️
    title: Interactive Map View
    details: Visualize your mesh network on an interactive map with real-time node positions, signal strength indicators, and network topology. Import GeoJSON, KML, and KMZ overlays to layer zone maps or emergency boundaries. Enable a polar grid overlay for RF coverage visualization.

  - icon: 📊
    title: Comprehensive Analytics
    details: Track message statistics, node health, signal quality (SNR), and network performance over time with detailed charts and graphs. Switch between chart, gauge, and numeric display modes for telemetry widgets.

  - icon: 🔄
    title: Real-time Updates
    details: Monitor your network in real-time with automatic updates. See new messages, node status changes, and network events as they happen.

  - icon: 💬
    title: Message Management
    details: View, send, and manage messages across your mesh network. Support for multiple channels and message history. Drag and drop to reorder channels to match your workflow.

  - icon: 🔐
    title: Security Monitoring
    details: Automatic detection of weak encryption keys and duplicate key issues. Built-in authentication with local accounts and SSO support for enterprise deployments.

  - icon: 🐳
    title: Easy Deployment
    details: Deploy with Docker Compose or Kubernetes (Helm charts included). Simple configuration for both development and production environments.

  - icon: 💻
    title: Desktop Application
    details: Run MeshMonitor as a native app on Windows or macOS — no server, no Docker, no dependencies. System tray integration keeps your network awareness one click away.

  - icon: 🌐
    title: Virtual Node Server
    details: Connect multiple Meshtastic mobile apps simultaneously through MeshMonitor's Virtual Node proxy. Message queuing, config caching, and connection stability for 3-5+ concurrent mobile clients.

  - icon: 🧩
    title: Custom Map Tile Servers
    details: Configure custom map tile servers with support for both vector (.pbf) and raster (.png) tiles. Enable offline operation, custom styling, and privacy-focused mapping. Works with TileServer GL, nginx caching proxy, and standard XYZ tile servers for complete independence from external services. Upload custom MapLibre style JSON for fully branded or offline-first map appearances.

  - icon: 🎨
    title: Customizable Themes
    details: Choose from 15 built-in themes or create your own with the visual theme editor. Includes color-blind friendly options, WCAG AAA compliant high-contrast themes, and full import/export support for sharing custom themes.

  - icon: 🔔
    title: Push Notifications
    details: Receive real-time alerts for new messages on iOS, Android, and desktop - even when the app is closed. Zero configuration, works with HTTPS.

  - icon: ⚙️
    title: Flexible Configuration
    details: Configure reverse proxies, HTTPS, environment variables, and more. Adapt MeshMonitor to your infrastructure needs.

  - icon: ☀️
    title: Solar Monitoring
    details: Integrate with forecast.solar to visualize expected solar production alongside telemetry data. Perfect for optimizing off-grid deployments and predicting power availability.

  - icon: ⚡
    title: Automation & Triggers
    details: Create powerful automations with Auto-Responders, Scheduled Messages, Auto-Traceroute, and Geofence Triggers. Define geographic zones and trigger responses when nodes enter, exit, or remain inside — perfect for arrival notifications, asset tracking, and proximity alerts. Extend further with custom Python or Bash scripts.

  - icon: 🖥️
    title: Remote Administration
    details: Change node connections on-the-fly without container restarts. Configure device settings, manage channels, and send admin commands directly from the web interface.
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
      - MESHTASTIC_NODE_IP=192.168.1.100  # Change to your node's IP
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

### Interactive Map
Track your entire mesh network at a glance with the interactive map and real-time node positions.

![Interactive Map](/images/main.png)

### Channel Messaging
Communicate across your mesh network with multi-channel messaging and real-time updates.

![Channel Messaging](/images/channels.png)

### Message History
Browse and search the full history of messages across all your channels.

![Message History](/images/messages.png)

### User Management
Manage user accounts, permissions, and access control for your MeshMonitor instance.

![User Management](/images/users.png)

## Community & Support

- **Discord**: [Join our Discord](https://discord.gg/JVR3VBETQE) - Chat with the community and get help
- **GitHub**: [github.com/yeraze/meshmonitor](https://github.com/yeraze/meshmonitor)
- **Issues**: Report bugs and request features on GitHub Issues
- **License**: BSD-3-Clause

---

Ready to get started? Head over to the [Getting Started](/getting-started) guide!
