---
id: news-2026-01-28-node-connection-ui
title: 'New Feature: In-App Node Connection Configuration'
date: '2026-01-28T17:00:00Z'
category: feature
priority: normal
minVersion: 3.4.0
---
MeshMonitor v3.4.0 adds the ability to **change your Meshtastic node's IP address directly from the UI** - no container restart required.

## How It Works

Click on the **node name in the header** to open the Node Info modal. Administrators will see a new section to modify the connection IP address and port.

## Key Benefits

- **No Restart Required**: Change connections on the fly without restarting MeshMonitor
- **Quick Troubleshooting**: Temporarily connect to different nodes for testing
- **Network Flexibility**: Adapt to DHCP changes or network reconfigurations instantly
- **Mobile-Friendly**: Manage connections without needing terminal access

## Important Notes

- Changes persist until container restart
- For permanent changes, update your `MESHTASTIC_IP` environment variable
- Admin privileges required to modify connection settings
- All authenticated users can view current connection info

[Read more about Node Connection Configuration](https://meshmonitor.org/features/settings#node-connection)
