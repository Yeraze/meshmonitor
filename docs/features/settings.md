# Settings

The Settings tab allows you to customize MeshMonitor's behavior and manage your system. Settings are stored on the server and apply to all users accessing the application.

## Node Display

### Maximum Age of Active Nodes

**Description**: Controls which nodes appear in the Node List based on their last activity.

**Range**: 1-168 hours

**Default**: 24 hours

**Effect**: Nodes that haven't been heard from in longer than this period will not appear in the Node List. This helps keep the list focused on currently active nodes in your mesh network.

**Side Effects**: Setting this too low may cause frequently-active nodes to disappear from the list temporarily. Setting it too high may clutter the list with offline nodes.

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
