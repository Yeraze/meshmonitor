# Desktop Application

MeshMonitor Desktop is a standalone Windows application that runs MeshMonitor as a system tray application. This is ideal for users who don't have an always-on server like a Raspberry Pi or NAS.

## Overview

The desktop application:
- Runs the MeshMonitor backend as a background service
- Sits in your system tray for easy access
- Opens the web UI in your default browser
- Persists data locally on your computer
- Starts automatically when Windows boots (optional)

## Requirements

- **Operating System**: Windows 10 or later (64-bit)
- **Meshtastic Device**: A Meshtastic node with TCP API enabled
- **Network**: Your Meshtastic node must be accessible via TCP (WiFi or Ethernet connected)

## Installation

### Download

1. Go to the [MeshMonitor Releases](https://github.com/Yeraze/MeshMonitor/releases) page
2. Download the latest `MeshMonitor-Desktop-x.x.x-x64.msi` or `MeshMonitor-Desktop-x.x.x-x64-setup.exe`
3. Run the installer and follow the prompts

### First-Run Setup

When you first launch MeshMonitor Desktop, a setup window will appear asking for your Meshtastic node configuration:

1. **Meshtastic Node IP Address**: Enter the IP address of your Meshtastic device (e.g., `192.168.1.100`)
2. **Advanced Options** (optional):
   - **Meshtastic Port**: TCP port for Meshtastic API (default: 4403)
   - **Web UI Port**: Local port for the web interface (default: 8080)

3. Click "Start MeshMonitor" to save the configuration and launch the backend

## Using MeshMonitor Desktop

### System Tray

Once running, MeshMonitor appears as an icon in your system tray (bottom-right of your taskbar).

**Left-click** the tray icon to open the web UI in your default browser.

**Right-click** for the menu:
- **Open MeshMonitor**: Opens the web UI in your browser
- **Settings**: Opens the configuration window
- **Open Data Folder**: Opens the folder containing your database and logs
- **Quit**: Stops MeshMonitor and exits the application

### Web UI

The web UI is identical to the server version. Access it at:
```
http://localhost:8080
```

If you changed the port during setup, use that port instead.

## Configuration

### Settings Location

Configuration is stored in:
```
%APPDATA%\MeshMonitor\config.json
```

### Data Location

Your database and logs are stored in:
```
%LOCALAPPDATA%\MeshMonitor\
```

This includes:
- `meshmonitor.db` - SQLite database with all your data
- `logs/` - Application logs

### Changing Configuration

1. Right-click the tray icon
2. Select "Settings"
3. Update the configuration
4. Click "Save" - the backend will automatically restart

## Troubleshooting

### MeshMonitor won't start

1. Check that your Meshtastic node is powered on and connected to your network
2. Verify the IP address is correct
3. Ensure TCP API is enabled on your Meshtastic device
4. Check the logs in `%LOCALAPPDATA%\MeshMonitor\logs\`

### Can't connect to Meshtastic node

1. Verify your node's IP address hasn't changed (consider setting a static IP)
2. Ensure port 4403 (or your configured port) is not blocked by a firewall
3. Test connectivity: `ping <your-node-ip>`

### Port 8080 is in use

If another application is using port 8080:
1. Open Settings from the tray menu
2. Change the "Web UI Port" to a different port (e.g., 8081)
3. Save and restart

### Data backup

To backup your MeshMonitor data:
1. Right-click the tray icon and select "Open Data Folder"
2. Copy the entire `MeshMonitor` folder to your backup location

To restore:
1. Stop MeshMonitor (Quit from tray)
2. Replace the contents of `%LOCALAPPDATA%\MeshMonitor\` with your backup
3. Restart MeshMonitor

## Comparison with Server Deployment

| Feature | Desktop | Docker/Server |
|---------|---------|---------------|
| Always-on monitoring | Requires PC running | 24/7 |
| HTTPS/SSL | No | Yes |
| Remote access | No | Yes |
| Multi-user | Local only | Yes |
| PWA/Mobile | No | Yes |
| Resource usage | Light (~50MB RAM) | Light (~100MB) |
| Data location | Local PC | Configurable |

## Uninstalling

1. Right-click the tray icon and select "Quit"
2. Open Windows Settings > Apps > Apps & features
3. Find "MeshMonitor Desktop" and click "Uninstall"

To also remove your data:
1. Delete `%APPDATA%\MeshMonitor\`
2. Delete `%LOCALAPPDATA%\MeshMonitor\`
