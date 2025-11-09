# Settings

The Settings tab allows you to customize MeshMonitor's behavior and manage your system. Settings are stored on the server and apply to all users accessing the application.

## Node Display

### Maximum Age of Active Nodes

**Description**: Controls which nodes appear in the Node List based on their last activity.

**Range**: 1-168 hours

**Default**: 24 hours

**Effect**: Nodes that haven't been heard from in longer than this period will not appear in the Node List. This helps keep the list focused on currently active nodes in your mesh network.

**Side Effects**: Setting this too low may cause frequently-active nodes to disappear from the list temporarily. Setting it too high may clutter the list with offline nodes.

### Unknown Nodes Filter

**Description**: Allows you to filter nodes that have no identifying name information. Unknown nodes are those without both a long name and short name, typically displayed as "Node 12345678" in the interface.

**Location**: Node List filter panel (identified by ❓ icon)

**Filter Modes**:
- **Show only**: Display only unknown nodes (useful for identifying devices that need configuration)
- **Hide matching**: Hide unknown nodes from the list (default behavior, keeps the list clean)

**How it works**: A node is considered "unknown" when it has no long name AND no short name (or both are empty/whitespace). This commonly happens with:
- Newly added devices that haven't been configured yet
- Devices reset to factory defaults
- Nodes that haven't broadcast their user information

**Use Cases**:
- Identifying unconfigured nodes in your network
- Cleaning up the node list to show only properly configured devices
- Finding devices that may need attention or setup

**Effect**: When combined with other filters, this helps manage large mesh networks by focusing on nodes with meaningful identification or highlighting those that need configuration.

### Device Role Filter *(New in v2.12)*

**Description**: Filter nodes based on their assigned Meshtastic device role, allowing you to focus on specific types of nodes in your network.

**Location**: Node List filter panel and Telemetry Dashboard

**Filter Modes**:
- **Show only**: Display only nodes with selected roles
- **Hide matching**: Hide nodes with selected roles from the list

**Available Roles**:
- **CLIENT**: Standard end-user devices (most common)
- **CLIENT_MUTE**: Receives messages but doesn't route
- **ROUTER**: Dedicated routing nodes
- **ROUTER_CLIENT**: Routes traffic and used by user
- **REPEATER**: Dedicated message repeaters
- **TRACKER**: GPS tracker devices
- **SENSOR**: Environmental sensor nodes
- **TAK**: Team Awareness Kit integration
- **CLIENT_HIDDEN**: Hidden client nodes
- **LOST_AND_FOUND**: Lost and found trackers
- **TAK_TRACKER**: TAK-enabled trackers

**Use Cases**:
- View only routing infrastructure (ROUTER, REPEATER roles)
- Focus on end-user devices (CLIENT roles)
- Monitor specialized nodes (SENSOR, TRACKER roles)
- Analyze network topology by node function
- Create focused views for network management

**Effect**: Helps organize and analyze large networks by grouping nodes by their functional role in the mesh.

### Security Filter *(New in v2.12.1)*

**Description**: Filter nodes based on detected security issues, allowing you to focus on nodes with security problems or hide them from view.

**Location**: Filter Modal popup (click "Filter" button in Nodes or Messages tab sidebar)

**Filter Options**:
- **All Nodes**: Show all nodes regardless of security status (default)
- **⚠️ Flagged Only**: Display only nodes with detected security issues
- **Hide Flagged**: Hide all flagged nodes from the list

**Security Issues Detected**:
- **Low-Entropy Keys**: Nodes using known weak public encryption keys
- **Duplicate Keys**: Multiple nodes sharing the same public key

**Use Cases**:
- Security audits: View all nodes with potential security vulnerabilities
- Clean view: Hide problematic nodes to focus on trusted devices
- Network monitoring: Quickly identify new security issues as they're detected
- Compliance: Ensure all nodes meet security standards

**Visual Indicators**:
- Flagged nodes display a ⚠️ warning icon in the node list
- Messages from flagged nodes show a red warning bar with details
- Hovering over warning icons shows specific security issue details

**Effect**: When "⚠️ Flagged Only" is selected, the node count updates to show "X/Total" format (e.g., "8/156 nodes"). This filter works alongside other filters (text search, device role, unknown nodes) and applies to both Nodes and Messages tabs.

**Learn More**: See [Security Features](/features/security) for detailed information about security monitoring, detection methods, and best practices.

## Node Details Block

**Location**: Messages page, displayed when a node is selected in the conversation list

The Node Details block provides comprehensive information about the currently selected node, displaying real-time metrics and device information in an easy-to-read format.

### Information Displayed

#### Node Identification
- **Node ID (Hex)**: Node identifier in hexadecimal format (e.g., `0x43588558`)
  - Standard Meshtastic node ID format
  - Used in URLs and API calls
  - Matches the format displayed in the Meshtastic app

- **Node ID (Decimal)**: Same identifier in decimal format (e.g., `1129874776`)
  - Useful for debugging and database queries
  - Alternative format for different use cases

#### Power Status
- **Battery Level**: Current battery percentage (0-100%)
  - Color-coded indicators:
    - 🟢 Green: >75% (good)
    - 🟡 Yellow: 25-75% (moderate)
    - 🔴 Red: <25% (low)
  - Shows voltage in parentheses (e.g., "85% (4.15V)")

#### Network Quality
- **Signal (SNR)**: Signal-to-Noise Ratio in decibels
  - Color-coded quality indicators:
    - 🟢 Green: >10 dB (excellent)
    - 🟡 Yellow: 0-10 dB (good)
    - 🔴 Red: <0 dB (poor)

- **Signal (RSSI)**: Received Signal Strength Indicator in dBm
  - Shows absolute signal strength
  - Lower (more negative) values indicate weaker signal

#### Network Performance
- **Channel Utilization**: Percentage of airtime used by all nodes
  - Helps identify network congestion
  - Values >75% may indicate overcrowded channel

- **Air Utilization TX**: This node's transmission airtime percentage
  - Shows how much this specific node is transmitting
  - Useful for identifying chatty nodes

#### Device Information
- **Hardware Model**: Device type with friendly name
  - Displays official Meshtastic hardware names (e.g., "STATION G2", "HELTEC V3")
  - Shows hardware images when available (70+ device types supported)
  - Hardware images fetched from Meshtastic web-flasher repository

- **Role**: Device role in the mesh network
  - CLIENT: End-user device (most common)
  - CLIENT_MUTE: Receives but doesn't route
  - ROUTER: Dedicated routing node
  - ROUTER_CLIENT: Routes and used by user
  - REPEATER: Dedicated repeater
  - TRACKER: GPS tracker device
  - SENSOR: Sensor node
  - And more specialized roles

- **Firmware Version**: Current Meshtastic firmware version
  - Displays version string (e.g., "2.3.2.d1e2f3a")
  - Useful for troubleshooting compatibility issues

#### Network Position
- **Hops Away**: Number of hops from your node
  - "Direct": Node is directly reachable
  - Number (e.g., "2 hops"): Requires intermediate nodes

- **Via MQTT**: Indicates if node connected via MQTT bridge
  - Shows when node is reachable through MQTT instead of radio

#### Activity
- **Last Heard**: When the node was last active
  - Relative time format (e.g., "5 minutes ago", "2 hours ago")
  - Uses your configured time/date format preferences

### Layout

The Node Details block uses a responsive grid layout:
- **Desktop**: 2-column grid for efficient space usage
- **Mobile**: Single column for better readability on small screens

### Missing Data

When information is unavailable, the block displays "N/A" for that metric. This commonly occurs when:
- Node hasn't transmitted certain telemetry data yet
- Information isn't available from the device type
- Connection was lost before all data was received

## Solar Monitoring *(New in v2.13)*

**Description**: Configure solar production monitoring to visualize expected solar power generation on telemetry graphs.

**Integration**: Uses the [forecast.solar](https://forecast.solar) API to fetch solar production estimates based on your panel configuration and location.

**Configuration Parameters**:

### Latitude
- **Range**: -90 to 90 degrees
- **Description**: Geographic latitude of your solar installation
- **Examples**:
  - 37.7749 (San Francisco, CA)
  - 51.5074 (London, UK)
  - -33.8688 (Sydney, Australia)

### Longitude
- **Range**: -180 to 180 degrees
- **Description**: Geographic longitude of your solar installation
- **Examples**:
  - -122.4194 (San Francisco, CA)
  - -0.1278 (London, UK)
  - 151.2093 (Sydney, Australia)

### Declination (Tilt)
- **Range**: 0-90 degrees
- **Description**: The angle your solar panels are tilted from horizontal
- **Values**:
  - 0° = Horizontal (flat mounting)
  - 20-40° = Typical roof mount (varies by latitude)
  - 90° = Vertical (wall mounting)
- **Tip**: Use a protractor or angle finder to measure your panel tilt

### Azimuth (Compass Direction)
- **Range**: 0-360 degrees
- **Description**: Compass direction your solar panels face
- **Values**:
  - 0° = North
  - 90° = East
  - 180° = South (optimal in Northern Hemisphere)
  - 270° = West
- **Tip**: Use a compass app on your phone to determine panel orientation

**Effect**: When configured, MeshMonitor will automatically fetch solar production estimates every hour and display them as translucent yellow overlays on telemetry graphs.

**Visual Indicator**: Solar estimates appear as a yellow background on:
- Node Details telemetry graphs
- Telemetry Dashboard charts
- Any time-series telemetry visualization

**Side Effects**:
- Hourly API requests to forecast.solar (free tier)
- Additional database storage for solar estimates
- Minimal performance impact on graph rendering

**When to use**:
- Off-grid or solar-powered Meshtastic deployments
- Battery optimization and planning
- Correlating node performance with available solar power
- Predicting when nodes may go offline due to insufficient power

**Learn More**: See [Solar Monitoring](/features/solar-monitoring) for detailed documentation, API endpoints, and troubleshooting.

## Display Preferences

### Preferred Node List Sorting

**Field Options**: Long Name, Short Name, ID, Last Heard, SNR, Battery, Hardware Model, Hops

**Direction Options**: Ascending (A-Z, 0-9, oldest-newest) or Descending (Z-A, 9-0, newest-oldest)

**Default**: Long Name (Ascending)

**Effect**: Sets the default sorting for the Node List on the main page. Users can still manually sort the list, but it will return to this default on page reload.

### Time Format

**Options**: 12-hour (e.g., 3:45 PM) or 24-hour (e.g., 15:45)

**Default**: 24-hour

**Effect**: Changes how times are displayed throughout the application in messages, telemetry, and other time-based information.

### Date Format

**Options**: MM/DD/YYYY (e.g., 12/31/2024) or DD/MM/YYYY (e.g., 31/12/2024)

**Default**: MM/DD/YYYY

**Effect**: Changes how dates are displayed throughout the application.

### Temperature Unit

**Options**: Celsius (°C) or Fahrenheit (°F)

**Default**: Celsius

**Effect**: Changes how temperature readings from environmental sensors are displayed in telemetry graphs and node details.

**Side Effects**: Only affects display - the actual telemetry data stored in the database remains unchanged.

### Distance Unit

**Options**: Kilometers (km) or Miles (mi)

**Default**: Kilometers

**Effect**: Changes how distances are displayed when viewing node locations and calculating ranges between nodes.

**Side Effects**: Only affects display - the actual position data remains unchanged.

### Color Theme

**Description**: Customize the visual appearance of MeshMonitor with 15 carefully crafted themes including accessibility-focused options.

**Categories**:
- **Catppuccin** (4 themes): Latte, Frappé, Macchiato, Mocha
- **Popular Themes** (6 themes): Nord, Dracula, Solarized Dark/Light, Gruvbox Dark/Light
- **High Contrast** (2 themes): WCAG AAA compliant themes for users with low vision
- **Color Blind Friendly** (3 themes): Optimized for protanopia, deuteranopia, and tritanopia

**Default**: Catppuccin Mocha (Dark)

**Effect**: Changes the color scheme for all UI elements including:
- Sidebar and navigation
- Message containers and chat
- Telemetry graphs and charts
- Node information displays
- Settings and configuration panels
- Modals and popups

**Accessibility Features**:
- **WCAG AAA Compliance**: High Contrast themes meet the highest accessibility standards
- **Color Blind Support**: Specialized themes for different types of color blindness
- **Persistent Choice**: Your theme selection is saved and applies across all pages
- **Instant Switching**: Themes update immediately without page reload

**Learn More**: Browse all themes with color previews and detailed descriptions in the [Theme Gallery](/THEME_GALLERY).

### Telemetry Visualization Hours

**Description**: Controls how much historical telemetry data is shown in graphs.

**Range**: 1-168 hours

**Default**: 24 hours

**Effect**: Adjusts the time window for telemetry graphs showing battery levels, voltage, temperature, and other sensor data.

**Side Effects**: Larger values may result in slower graph rendering if you have many nodes with frequent telemetry updates.

## Settings Management

### Save Settings

Saves all changes made in the Settings tab. **Changes are not applied until you click this button.**

**Side Effects**: Settings are stored on the server and will affect all browsers accessing this MeshMonitor instance.

### Reset to Defaults

Restores all settings to their default values:
- Max Node Age: 24 hours
- Temperature Unit: Celsius
- Distance Unit: Kilometers
- Telemetry Hours: 24
- Preferred Sort: Long Name (Ascending)
- Time Format: 24-hour
- Date Format: MM/DD/YYYY

**Side Effects**: This affects all browsers accessing this MeshMonitor instance and cannot be undone.

## Danger Zone

These actions are **irreversible** and can result in data loss. Use with extreme caution.

### Erase Node List

**Description**: Removes all nodes and traceroute history from the database.

**Effect**: Clears the entire node database and triggers a node refresh to repopulate the list from the connected Meshtastic device.

**Side Effects**:
- All node information will be permanently deleted
- All traceroute history will be permanently deleted
- The page will automatically refresh after purging
- New nodes will be discovered as they broadcast on the mesh

**When to use**: When you want to start fresh, have moved to a different mesh network, or need to clean up corrupted node data.

### Purge Telemetry

**Description**: Removes all historical telemetry data from the database.

**Effect**: Deletes battery, voltage, temperature, humidity, pressure, and other environmental sensor readings.

**Side Effects**:
- All telemetry graphs will show no historical data
- Current node states (latest battery, voltage, etc.) are preserved
- New telemetry will continue to be collected normally
- The page will automatically refresh after purging

**When to use**: When your database has grown too large or you want to start fresh telemetry collection.

### Purge Messages

**Description**: Removes all messages from the database.

**Effect**: Deletes all channel messages and direct message conversations.

**Side Effects**:
- All message history is permanently lost
- Message search will return no results
- New messages will continue to be received normally
- The page will automatically refresh after purging

**When to use**: When you need to clear sensitive message history or reduce database size.

### Restart Container / Shutdown MeshMonitor

**Description**: Restarts the MeshMonitor container (Docker) or shuts down the application (bare metal).

**Effect**:
- **Docker**: The container restarts automatically and will be unavailable for approximately 10-30 seconds
- **Bare Metal**: MeshMonitor shuts down and must be manually restarted

**Side Effects**:
- All active connections will be disconnected
- The web interface will be temporarily unavailable
- Running background tasks (traceroutes, announcements) will be interrupted
- After restart (Docker only), the page should reload automatically

**When to use**: When applying configuration changes that require a restart, troubleshooting connection issues, or performing maintenance.

## Related Documentation

- [HTTP vs HTTPS Configuration](/configuration/http-vs-https) - Learn about the `COOKIE_SECURE` setting for authentication
- [Production Deployment](/configuration/production) - Best practices for production environments
- [Reverse Proxy](/configuration/reverse-proxy) - Configure NGINX, Traefik, or Caddy
