# Desktop Application

MeshMonitor Desktop is a standalone application for Windows and macOS that runs MeshMonitor as a system tray application. This is ideal for users who don't have an always-on server like a Raspberry Pi or NAS.

## Overview

The desktop application:
- Runs the MeshMonitor backend as a background service
- Sits in your system tray for easy access
- Opens the web UI in your default browser
- Persists data locally on your computer
- Starts automatically when your computer boots (optional)

## Requirements

### Windows
- **Operating System**: Windows 10 or later (64-bit)
- **Meshtastic Device**: A Meshtastic node with TCP API enabled
- **Network**: Your Meshtastic node must be accessible via TCP (WiFi or Ethernet connected)

### macOS
- **Operating System**: macOS 11 (Big Sur) or later
- **Architecture**: Apple Silicon (M1/M2/M3) native; Intel Macs can run via Rosetta 2
- **Meshtastic Device**: A Meshtastic node with TCP API enabled
- **Network**: Your Meshtastic node must be accessible via TCP (WiFi or Ethernet connected)

## Installation

### Windows

1. Go to the [MeshMonitor Releases](https://github.com/Yeraze/MeshMonitor/releases) page
2. Download the latest `MeshMonitor-Desktop-x.x.x-x64-setup.exe`
3. Run the installer and follow the prompts
4. MeshMonitor will appear in your Start menu and system tray

### macOS

1. Go to the [MeshMonitor Releases](https://github.com/Yeraze/MeshMonitor/releases) page
2. Download the latest `MeshMonitor-Desktop-x.x.x-arm64.dmg`
3. Open the DMG file and drag MeshMonitor to your Applications folder
4. Launch MeshMonitor from your Applications folder
5. MeshMonitor will appear in your menu bar

::: tip Apple Silicon Native
The macOS version is compiled natively for Apple Silicon (M1/M2/M3). If you're using an Intel Mac, macOS will automatically run it through Rosetta 2.
:::

## First-Run Setup

When you first launch MeshMonitor Desktop, a setup window will appear asking for your Meshtastic node configuration:

1. **Meshtastic Node IP Address**: Enter the IP address of your Meshtastic device (e.g., `192.168.1.100`)
2. **Advanced Options** (optional):
   - **Meshtastic Port**: TCP port for Meshtastic API (default: 4403)
   - **Web UI Port**: Local port for the web interface (default: 8080)

3. Click "Start MeshMonitor" to save the configuration and launch the backend

## Using MeshMonitor Desktop

### System Tray / Menu Bar

Once running, MeshMonitor appears as an icon in your system tray (Windows) or menu bar (macOS).

**Left-click** (Windows) or **Click** (macOS) the icon to open the web UI in your default browser.

**Right-click** (Windows) or **Click** (macOS) for the menu:
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

### Settings Locations

::: tabs

@tab Windows

**Configuration file:**
```
%APPDATA%\MeshMonitor\config.json
```

**Data directory (database & logs):**
```
%LOCALAPPDATA%\MeshMonitor\
```

@tab macOS

**Configuration file:**
```
~/Library/Application Support/MeshMonitor/config.json
```

**Data directory (database & logs):**
```
~/Library/Application Support/MeshMonitor/
```

:::

### Configuration File

The configuration file (`config.json`) contains your basic settings:

```json
{
  "meshtastic_ip": "192.168.1.100",
  "meshtastic_port": 4403,
  "web_port": 8080,
  "auto_start": false,
  "session_secret": "auto-generated-secret",
  "setup_completed": true,
  "enable_virtual_node": false,
  "virtual_node_allow_admin": false
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `meshtastic_ip` | IP address of your Meshtastic node | `192.168.1.100` |
| `meshtastic_port` | TCP port for Meshtastic API | `4403` |
| `web_port` | Local port for web UI | `8080` |
| `auto_start` | Start with Windows/macOS | `false` |
| `session_secret` | Secret key for session cookies | Auto-generated |
| `setup_completed` | Whether initial setup is done | `true` after setup |
| `enable_virtual_node` | Enable virtual node server for mobile app connections | `false` |
| `virtual_node_allow_admin` | Allow admin commands via virtual node connections | `false` |

### Changing Configuration

1. Right-click (Windows) or click (macOS) the tray/menu bar icon
2. Select "Settings"
3. Update the configuration
4. Click "Save" - the backend will automatically restart

## Advanced Configuration

For advanced use cases, you can configure additional options by editing the configuration file directly or setting environment variables before launching.

### Remote Access (ALLOWED_ORIGINS)

By default, MeshMonitor Desktop only accepts connections from `localhost`. To enable access from other devices on your network:

::: warning Security Notice
Enabling remote access exposes MeshMonitor to your local network. Ensure you're on a trusted network and consider enabling authentication in MeshMonitor settings.
:::

1. Stop MeshMonitor (Quit from tray/menu bar)
2. Edit `config.json` and add an `allowed_origins` field (this requires a custom launcher script)
3. Or, create a launcher script that sets environment variables:

::: tabs

@tab Windows (PowerShell)

Create a file called `start-meshmonitor.ps1`:
```powershell
$env:ALLOWED_ORIGINS = "http://localhost:8080,http://192.168.1.50:8080"
Start-Process "C:\Program Files\MeshMonitor\MeshMonitor.exe"
```

@tab macOS (Shell)

Create a file called `start-meshmonitor.sh`:
```bash
#!/bin/bash
export ALLOWED_ORIGINS="http://localhost:8080,http://192.168.1.50:8080"
open -a MeshMonitor
```
Make it executable: `chmod +x start-meshmonitor.sh`

:::

Replace `192.168.1.50` with your computer's local IP address.

### Authentication & Cookies

MeshMonitor Desktop uses secure session cookies for authentication. The session secret is automatically generated on first run and stored in your config file.

**To reset your session secret:**
1. Stop MeshMonitor
2. Edit `config.json`
3. Delete the `session_secret` line (a new one will be generated)
4. Restart MeshMonitor

::: tip
Resetting the session secret will log out all active sessions, including browser sessions that may be open.
:::

### HTTPS / SSL

The desktop application runs HTTP only (no HTTPS). This is generally fine for local use since traffic stays on your machine. For secure remote access, consider:

1. Using the Docker deployment behind a reverse proxy with SSL
2. Setting up a local VPN to access your desktop remotely
3. Using SSH port forwarding

### Environment Variables

You can set these environment variables before launching MeshMonitor to override default behavior:

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Web server port | `8081` |
| `MESHTASTIC_NODE_IP` | Meshtastic device IP | `192.168.1.100` |
| `MESHTASTIC_TCP_PORT` | Meshtastic TCP port | `4403` |
| `ALLOWED_ORIGINS` | Comma-separated allowed origins | `http://localhost:8080` |
| `DATABASE_PATH` | Custom database location | `/path/to/meshmonitor.db` |
| `SESSION_SECRET` | Custom session secret | `your-secret-key` |
| `ENABLE_VIRTUAL_NODE` | Enable virtual node server | `true` |
| `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS` | Allow admin commands via virtual node | `true` |

### Virtual Node Server

The Virtual Node feature allows the official Meshtastic mobile apps (iOS/Android) to connect to MeshMonitor instead of directly to your Meshtastic device. This enables:

- Multiple mobile apps to view the mesh network simultaneously
- Mobile access when your Meshtastic device only supports one connection
- Access to the full message history stored in MeshMonitor

**To enable Virtual Node:**

1. Stop MeshMonitor (Quit from tray/menu bar)
2. Edit your `config.json` file
3. Set `"enable_virtual_node": true`
4. Optionally set `"virtual_node_allow_admin": true` to allow admin commands
5. Restart MeshMonitor

The virtual node server listens on port **4404** by default. In your Meshtastic mobile app, add a new TCP connection pointing to your computer's IP address and port 4404.

::: warning Security Notice
Enabling `virtual_node_allow_admin` allows mobile apps connected via the virtual node to send admin commands to your Meshtastic device. Only enable this on trusted networks.
:::

## Data Management

### Data Files

Your MeshMonitor data includes:

| File | Description |
|------|-------------|
| `meshmonitor.db` | SQLite database with all your data (nodes, messages, telemetry) |
| `logs/desktop.log` | Desktop application logs |
| `logs/server-stdout.log` | Server output logs |
| `logs/server-stderr.log` | Server error logs |

### Backup

To backup your MeshMonitor data:
1. Right-click the tray/menu bar icon and select "Open Data Folder"
2. Copy the entire `MeshMonitor` folder to your backup location

### Restore

To restore from a backup:
1. Stop MeshMonitor (Quit from tray/menu bar)
2. Replace the contents of your data folder with your backup
3. Restart MeshMonitor

### Reset to Defaults

To completely reset MeshMonitor:
1. Stop MeshMonitor
2. Delete the configuration and data folders (see paths above)
3. Restart MeshMonitor - the first-run setup will appear

## Troubleshooting

### MeshMonitor won't start

1. Check that your Meshtastic node is powered on and connected to your network
2. Verify the IP address is correct
3. Ensure TCP API is enabled on your Meshtastic device
4. Check the logs:
   - Windows: `%LOCALAPPDATA%\MeshMonitor\logs\`
   - macOS: `~/Library/Application Support/MeshMonitor/logs/`

### Can't connect to Meshtastic node

1. Verify your node's IP address hasn't changed (consider setting a static IP)
2. Ensure port 4403 (or your configured port) is not blocked by a firewall
3. Test connectivity: `ping <your-node-ip>`
4. Ensure only one application is connected to the node at a time

### Port 8080 is in use

If another application is using port 8080:
1. Open Settings from the tray/menu bar
2. Change the "Web UI Port" to a different port (e.g., 8081)
3. Save and restart

### macOS: App not appearing in menu bar

1. Check if MeshMonitor is running in Activity Monitor
2. Try quitting and relaunching the app
3. Check the logs for errors

### Windows: Firewall blocking connections

If Windows Firewall blocks MeshMonitor:
1. Open Windows Security > Firewall & network protection
2. Click "Allow an app through firewall"
3. Find MeshMonitor and ensure both Private and Public are checked

## Comparison with Docker Deployment

| Feature | Desktop | Docker/Server |
|---------|---------|---------------|
| Always-on monitoring | Requires PC running | 24/7 |
| HTTPS/SSL | No (HTTP only) | Yes |
| Remote access | Limited | Full support |
| Multi-user | Local only | Yes |
| PWA/Mobile | Local only | Yes |
| Resource usage | ~50MB RAM | ~100MB RAM |
| Auto-upgrade | Manual updates | Automatic |
| Serial/BLE support | No | Yes (with bridges) |

::: tip When to use Desktop vs Docker
**Use Desktop** if you:
- Only need local access on your computer
- Don't have a server or NAS running 24/7
- Want a simple, quick setup

**Use Docker** if you:
- Need 24/7 monitoring
- Want remote access from mobile devices
- Need HTTPS/SSL support
- Want automatic updates
:::

## Uninstalling

### Windows

1. Right-click the tray icon and select "Quit"
2. Open Windows Settings > Apps > Apps & features
3. Find "MeshMonitor Desktop" and click "Uninstall"

To also remove your data:
1. Delete `%APPDATA%\MeshMonitor\`
2. Delete `%LOCALAPPDATA%\MeshMonitor\`

### macOS

1. Click the menu bar icon and select "Quit"
2. Open Finder and go to Applications
3. Drag MeshMonitor to the Trash

To also remove your data:
1. Delete `~/Library/Application Support/MeshMonitor/`

::: tip Completely remove all traces
On macOS, you can also remove preferences:
```bash
rm -rf ~/Library/Application\ Support/MeshMonitor/
rm -rf ~/Library/Caches/org.meshmonitor.desktop/
```
:::
