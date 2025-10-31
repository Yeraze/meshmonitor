---
layout: home

hero:
  name: "MeshMonitor"
  text: "Monitor Your Meshtastic Network"
  tagline: "A powerful web application for monitoring Meshtastic nodes over IP with real-time updates, interactive maps, and comprehensive network analytics."
  image:
    src: /images/main.png
    alt: MeshMonitor Dashboard
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
    details: Visualize your mesh network on an interactive map with real-time node positions, signal strength indicators, and network topology.

  - icon: 📊
    title: Comprehensive Analytics
    details: Track message statistics, node health, signal quality (SNR), and network performance over time with detailed charts and graphs.

  - icon: 🔄
    title: Real-time Updates
    details: Monitor your network in real-time with automatic updates. See new messages, node status changes, and network events as they happen.

  - icon: 💬
    title: Message Management
    details: View, send, and manage messages across your mesh network. Support for multiple channels and message history.

  - icon: 🔐
    title: Security Monitoring
    details: Automatic detection of weak encryption keys and duplicate key issues. Built-in authentication with local accounts and SSO support for enterprise deployments.

  - icon: 🐳
    title: Easy Deployment
    details: Deploy with Docker Compose or Kubernetes (Helm charts included). Simple configuration for both development and production environments.

  - icon: 🌐
    title: Multi-Node Support (Coming Soon!)
    details: Monitor multiple Meshtastic nodes simultaneously, whether using physical devices or meshtasticd virtual nodes.

  - icon: 📱
    title: Responsive Design
    details: Works seamlessly on desktop, tablet, and mobile devices. Monitor your network from anywhere.

  - icon: 🔔
    title: Push Notifications
    details: Receive real-time alerts for new messages on iOS, Android, and desktop - even when the app is closed. Zero configuration, works with HTTPS.

  - icon: 🔧
    title: Flexible Configuration
    details: Configure reverse proxies, HTTPS, environment variables, and more. Adapt MeshMonitor to your infrastructure needs.
---

## Quick Start

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

### Main Dashboard
Track your entire mesh network at a glance with the interactive map and real-time statistics.

![Main Dashboard](/images/main.png)

### Messages View
View and manage all messages across your mesh network with powerful filtering and search capabilities.

![Messages](/images/messages.png)

### Channel Management
Configure and monitor multiple communication channels in your mesh network.

![Channels](/images/channels.png)

### User Management
Manage users, permissions, and authentication with a comprehensive admin interface.

![User Management](/images/users.png)

## Community & Support

- **GitHub**: [github.com/yeraze/meshmonitor](https://github.com/yeraze/meshmonitor)
- **Issues**: Report bugs and request features on GitHub Issues
- **License**: BSD-3-Clause

---

Ready to get started? Head over to the [Getting Started](/getting-started) guide!
