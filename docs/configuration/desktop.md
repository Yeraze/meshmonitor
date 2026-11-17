# Desktop Application

MeshMonitor Desktop is a standalone application for Windows and macOS that runs MeshMonitor as a system tray application. This is ideal for users who don't have an always-on server like a Raspberry Pi or NAS.

## Overview

The desktop application:
- Runs the MeshMonitor backend as a background service
- Sits in your system tray for easy access
- Opens the web UI in your default browser
- Persists data locally on your computer

## Requirements

### Windows
- **Operating System**: Windows 10 or later (64-bit)
- **Radio**: A Meshtastic node on your network (WiFi or Ethernet, TCP API on) or a MeshCore node. You add it after launch.

### macOS
- **Operating System**: macOS 11 (Big Sur) or later
- **Architecture**: Apple Silicon (M1/M2/M3) and Intel (x64) builds available
- **Radio**: A Meshtastic node on your network (WiFi or Ethernet, TCP API on) or a MeshCore node. You add it after launch.

## Installation

### Windows

1. Go to the [MeshMonitor Releases](https://github.com/Yeraze/MeshMonitor/releases) page
2. Download the latest `MeshMonitor-Desktop-x.x.x-x64-setup.exe`
3. Run the installer and follow the prompts
4. MeshMonitor will appear in your Start menu and system tray

### macOS

1. Go to the [MeshMonitor Releases](https://github.com/Yeraze/MeshMonitor/releases) page
2. Download the appropriate DMG for your Mac:
   - **Apple Silicon** (M1/M2/M3/M4): `MeshMonitor-Desktop-x.x.x-arm64.dmg`
   - **Intel**: `MeshMonitor-Desktop-x.x.x-x64.dmg`
3. Open the DMG file and drag MeshMonitor to your Applications folder
4. Launch MeshMonitor from your Applications folder
5. MeshMonitor will appear in your menu bar

::: tip Choose the Right Build
Download the DMG matching your Mac's processor. To check: Apple menu > About This Mac. If "Chip" says Apple M1/M2/M3/M4, use the arm64 build. If "Processor" says Intel, use the x64 build.
:::

## First-Run Setup

On first launch, a setup window opens. It does not ask for a node: MeshMonitor starts with no sources.

1. Optionally open **Advanced Options**:
   - **Web UI Port**: Local port for the web interface (default: 8080)
   - **Allowed Origins (CORS)**: Extra URLs that may open the web UI, such as `http://192.168.1.50:8080`. Localhost is always allowed.
   - **Autostart on Login**: Saved, but not wired up yet. MeshMonitor does not launch at login.
2. Click **Start MeshMonitor** to save and launch the backend.
3. In the web UI, open the **Sources** sidebar on the dashboard, click **+**, and add your Meshtastic or MeshCore node.

## Using MeshMonitor Desktop

### System Tray / Menu Bar

Once running, MeshMonitor appears as an icon in your system tray (Windows) or menu bar (macOS).

**Left-click** (Windows) or **Click** (macOS) the icon to open the web UI in your default browser.

**Right-click** (Windows) or **Click** (macOS) for the menu:
- **Open MeshMonitor**: Opens the web UI in your browser
- **Settings...**: Opens the settings window
- **View Logs**: Opens the logs folder
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
%APPDATA%\MeshMonitor\
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
  "meshtastic_ip": "",
  "meshtastic_port": 4403,
  "web_port": 8080,
  "auto_start": false,
  "session_secret": "auto-generated-secret",
  "setup_completed": true,
  "allowed_origins": "http://192.168.1.50:8080"
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `web_port` | Local port for web UI | `8080` |
| `allowed_origins` | Extra comma-separated origins; localhost is always added | none |
| `auto_start` | Saved from the settings window, but not used yet | `false` |
| `session_secret` | Secret key for session cookies | Auto-generated |
| `setup_completed` | Whether initial setup is done | `true` after setup |
| `meshtastic_ip` | Legacy. If set, MeshMonitor creates a Meshtastic TCP source from it at startup. Add sources in the web UI instead. | empty |
| `meshtastic_port` | Legacy. Port for `meshtastic_ip` | `4403` |

### Changing Configuration

1. Right-click (Windows) or click (macOS) the tray/menu bar icon
2. Select **Settings...**
3. Change the settings under **Advanced Options**
4. Click **Start MeshMonitor**. The backend restarts with the new settings.

## Advanced Configuration

### Remote Access (Allowed Origins)

By default, the web UI loads only from `localhost`. To open it from other devices on your network:

::: warning Security Notice
Remote access exposes MeshMonitor to your local network. Use it only on a trusted network, and change the default admin password.
:::

1. Open **Settings...** from the tray/menu bar icon
2. Open **Advanced Options**
3. In **Allowed Origins (CORS)**, enter the URL other devices will use, such as `http://192.168.1.50:8080`. Separate several URLs with commas.
4. Click **Start MeshMonitor**

Replace `192.168.1.50` with your computer's local IP address. Your firewall must also allow the web UI port.

### Authentication & Cookies

MeshMonitor Desktop uses secure session cookies for authentication. The session secret is automatically generated on first run and stored in your config file.

**To reset your session secret:**
1. Stop MeshMonitor
2. Edit `config.json`
3. Replace the `session_secret` value with a new random string, such as the output of `openssl rand -hex 32`. Don't delete the line: a `config.json` without it fails to load, and the app falls back to defaults for every setting.
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

The desktop app sets these variables itself when it starts the backend, so a value you set in your shell has no effect:

| Variable | Set from |
|----------|----------|
| `NODE_ENV` | Always `production` |
| `PORT` | **Web UI Port** setting |
| `ALLOWED_ORIGINS` | `http://localhost:<port>` plus the **Allowed Origins** setting |
| `DATABASE_PATH`, `DATA_DIR` | The data directory above |
| `SESSION_SECRET` | `session_secret` in `config.json` |

When the legacy `meshtastic_ip` is set, the app also sets `MESHTASTIC_NODE_IP` and `MESHTASTIC_TCP_PORT` from it.

Other [environment variables](/configuration/index), such as `TZ` or `LOG_LEVEL`, pass through from the environment MeshMonitor is launched from.

> **4.0 note:** Virtual Node is now configured per source through the Dashboard UI. `ENABLE_VIRTUAL_NODE` / `VIRTUAL_NODE_PORT` only seed the Default source on first boot (see [Headless installs](/configuration/virtual-node#headless-installs-first-boot-env-vars)); `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS` has been removed.

### Virtual Node Server

The Virtual Node feature allows the official Meshtastic mobile apps (iOS/Android) to connect to MeshMonitor instead of directly to your Meshtastic device. This enables:

- Multiple mobile apps to view the mesh network simultaneously
- Mobile access when your Meshtastic device only supports one connection
- Access to the full message history stored in MeshMonitor

**To enable Virtual Node:**

1. Open the MeshMonitor web UI
2. On the **Dashboard**, open **Edit Source** for the source you want to expose
3. In the **Virtual Node** section, turn on **Enable Virtual Node** and pick a **Virtual Node Port**
4. Optionally turn on **Allow admin commands**
5. Save the source

Each source has its own Virtual Node and its own port. In your Meshtastic mobile app, add a new TCP connection pointing to your computer's IP address and the port you picked.

The desktop settings window no longer has Virtual Node checkboxes, and `config.json` no longer has `enable_virtual_node` or `virtual_node_allow_admin`. Both did nothing since 4.0. An old `config.json` that still holds them loads as before; the two fields are dropped the next time the desktop app saves its settings.

::: warning Security Notice
**Allow admin commands** lets mobile apps connected through the Virtual Node send admin commands to your Meshtastic device. Only turn it on for trusted networks.
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

1. Check that the **Web UI Port** is free (see [Port 8080 is in use](#port-8080-is-in-use))
2. Check the logs:
   - Windows: `%APPDATA%\MeshMonitor\logs\`
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
| Updates | Install the new release | Pull the new image (or use [Watchtower](/configuration/updating#unattended-updates-with-watchtower)) |
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
- Want unattended updates
:::

## Uninstalling

### Windows

1. Right-click the tray icon and select "Quit"
2. Open Windows Settings > Apps > Apps & features
3. Find "MeshMonitor Desktop" and click "Uninstall"

To also remove your data:
1. Delete `%APPDATA%\MeshMonitor\`

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
