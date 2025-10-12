# Device Configuration

The Configuration tab in MeshMonitor allows you to remotely configure your connected Meshtastic device. Changes are sent directly to the device and typically require a reboot to take effect.

::: warning
Configuration changes directly modify your Meshtastic device settings. Always ensure you understand the impact of changes before applying them, as incorrect settings may affect device functionality or network connectivity.
:::

## Node Identity

### Long Name

**Description**: The full display name for your node, shown in node lists and messages.

**Maximum Length**: 39 characters

**Effect**: Changes how your node appears to other users on the mesh network.

**Side Effects**:
- Broadcasts the new name to all mesh users
- May take several minutes to propagate throughout the network
- Requires device reboot to take effect

**Best Practices**:
- Use descriptive names that help identify location or purpose
- Avoid special characters that may not display correctly
- Keep it concise for better display on small screens

### Short Name

**Description**: A 4-character abbreviated name for your node.

**Maximum Length**: 4 characters

**Effect**: Used in compact displays and when bandwidth is limited.

**Side Effects**:
- Broadcasts the new short name to all mesh users
- Some interfaces use short name exclusively
- Requires device reboot to take effect

**Best Practices**:
- Use easily recognizable abbreviations
- Typically derived from long name (e.g., "Base Station 1" → "BS01")
- Avoid ambiguous abbreviations

### Related Meshtastic Documentation

- [Meshtastic Device Configuration](https://meshtastic.org/docs/configuration/radio/device/)

## Device Configuration

### Device Role

Defines how your node behaves on the mesh network and affects power consumption, relay behavior, and visibility.

#### CLIENT (Default)

**Description**: General-purpose mode for devices with app connections or standalone messaging.

**Behavior**:
- Rebroadcasts packets when no other node has done so
- Normal power consumption
- Full mesh network participation

**Use Cases**:
- Personal handheld devices
- Desktop monitoring stations
- General mesh participation

**Side Effects**: Standard airtime usage and power consumption

#### CLIENT_MUTE

**Description**: Device that participates but does not forward packets from other devices.

**Behavior**:
- Receives and sends own messages
- Does NOT relay packets for others
- Reduced network load contribution

**Use Cases**:
- Reducing network congestion
- Low-power deployments
- Personal use without helping the mesh

**Side Effects**: Reduces overall mesh connectivity; not recommended for community networks

#### ROUTER ⚠️

**Description**: Infrastructure node that always rebroadcasts packets to extend network coverage.

**Behavior**:
- Always relays all packets (no intelligent delay)
- Visible in network topology
- Significantly increased power consumption

**Use Cases**:
- Fixed infrastructure installations
- Strategic coverage extension points
- Powered installations only

**Side Effects**:
- **Very high airtime usage**
- **Significant battery drain** (not suitable for battery power)
- May cause network congestion if overused

::: danger
MeshMonitor will warn you before setting ROUTER mode. Only use this for powered, fixed infrastructure nodes in strategic locations.
:::

#### TRACKER

**Description**: Optimized for broadcasting GPS position with priority handling.

**Behavior**:
- GPS packets are prioritized
- Reduced relay activity
- Optimized for frequent position updates

**Use Cases**:
- Vehicle tracking
- Asset tracking
- Mobile position reporting

**Side Effects**: Position broadcasts consume airtime; best for moving assets

#### SENSOR

**Description**: Optimized for broadcasting telemetry data with priority handling.

**Behavior**:
- Telemetry packets are prioritized
- Reduced relay activity
- Efficient power usage for sensors

**Use Cases**:
- Environmental monitoring stations
- Weather sensors
- Remote sensor deployments

**Side Effects**: Telemetry broadcasts consume airtime

#### TAK

**Description**: Optimized for ATAK (Android Team Awareness Kit) system communication.

**Behavior**:
- Reduces routine broadcasts
- Optimized for tactical communications
- Requires Meshtastic ATAK Plugin

**Use Cases**:
- Integration with ATAK systems
- Tactical operations
- Coordinated activities

**Side Effects**: Requires ATAK plugin for full functionality

#### CLIENT_HIDDEN

**Description**: Minimalist broadcasting for stealth or extreme power savings.

**Behavior**:
- Only broadcasts when absolutely necessary
- Minimal network presence
- Maximum power conservation

**Use Cases**:
- Stealth deployments
- Ultra-low-power requirements
- Hidden installations

**Side Effects**: Reduced network visibility; may appear offline to other users

#### LOST_AND_FOUND

**Description**: Broadcasts location messages to assist with device recovery.

**Behavior**:
- Regular location broadcasts to default channel
- Optimized for device recovery
- Increased GPS activity

**Use Cases**:
- Lost or stolen device recovery
- Temporary deployment tracking

**Side Effects**: Frequent position broadcasts; high power usage

#### TAK_TRACKER

**Description**: Standalone Position Location Information (PLI) for ATAK systems.

**Behavior**:
- Automatic TAK PLI broadcasts
- Reduced routine broadcasts
- Optimized for tactical tracking

**Use Cases**:
- Tactical position tracking with ATAK
- Team location awareness
- Coordinated operations

**Side Effects**: Requires ATAK integration

#### ROUTER_LATE

**Description**: Infrastructure node that rebroadcasts only after all other modes attempt relay.

**Behavior**:
- Waits for other nodes to relay first
- Provides backup coverage
- Visible in network topology

**Use Cases**:
- Covering dead spots in local clusters
- Backup coverage for specific areas
- Ensuring local reliability without overloading broader mesh

**Side Effects**: Increased airtime usage (but less than ROUTER); best for powered installations

#### CLIENT_BASE

**Description**: Personal base station that prioritizes favorited nodes.

**Behavior**:
- Always rebroadcasts packets from/to favorited nodes
- Handles other packets like CLIENT
- Helps extend range for specific nodes

**Use Cases**:
- Strong attic/roof installations
- Distribution node for weaker indoor devices
- Personal network enhancement

**Side Effects**: Increased relay activity for favorited nodes

### Node Info Broadcast Interval

**Description**: How often the device broadcasts its node information to the mesh.

**Range**: 3600-4294967295 seconds (1 hour - ~136 years)

**Default**: 10800 seconds (3 hours)

**Minimum**: 3600 seconds (1 hour)

**Effect**: Controls how frequently other nodes receive updated information about your device (name, position, battery status, etc.).

**Side Effects**:
- **Shorter intervals**: More network traffic, more up-to-date information, higher power usage
- **Longer intervals**: Less network traffic, potentially stale information, lower power usage
- Affects how quickly name changes and position updates propagate

**Best Practices**:
- Use default (3 hours) for most deployments
- Increase for static installations (6-12 hours)
- Decrease only for highly mobile nodes needing frequent updates

### Related Meshtastic Documentation

- [Meshtastic Device Roles](https://meshtastic.org/docs/configuration/radio/device/#roles)
- [Meshtastic Device Configuration](https://meshtastic.org/docs/configuration/radio/device/)

## LoRa Radio Configuration

### Use Preset

**Description**: Enable or disable using predefined modem configurations.

**Recommendation**: Keep enabled unless you have specific requirements for custom settings.

**Effect**: When enabled, modem parameters (bandwidth, spreading factor, coding rate) are set automatically based on the selected preset.

**Side Effects**: Disabling requires manual configuration of advanced LoRa parameters

### Modem Preset

Predefined radio settings that balance range, speed, and reliability. All nodes on a mesh must use compatible settings to communicate.

#### LONG_FAST (Default)

- **Range**: Maximum
- **Speed**: Fast
- **Bandwidth**: 250kHz
- **Spreading Factor**: 11
- **Coding Rate**: 4/8
- **Best For**: Most deployments, good balance

#### LONG_SLOW

- **Range**: Maximum
- **Speed**: Slowest
- **Bandwidth**: 250kHz
- **Spreading Factor**: 12
- **Coding Rate**: 4/8
- **Best For**: Extreme range, low traffic networks

#### LONG_MODERATE

- **Range**: Maximum
- **Speed**: Moderately Fast
- **Bandwidth**: 250kHz
- **Spreading Factor**: 11
- **Coding Rate**: 4/6
- **Best For**: Good range with better throughput than LONG_SLOW

#### MEDIUM_SLOW

- **Range**: Medium
- **Speed**: Slow
- **Bandwidth**: 250kHz
- **Spreading Factor**: 11
- **Coding Rate**: 4/8
- **Best For**: Moderate range deployments

#### MEDIUM_FAST

- **Range**: Medium
- **Speed**: Fast
- **Bandwidth**: 250kHz
- **Spreading Factor**: 10
- **Coding Rate**: 4/7
- **Best For**: Urban deployments with moderate coverage needs

#### SHORT_SLOW

- **Range**: Short
- **Speed**: Slow
- **Bandwidth**: 250kHz
- **Spreading Factor**: 9
- **Coding Rate**: 4/8
- **Best For**: Dense local networks

#### SHORT_FAST

- **Range**: Short
- **Speed**: Fast
- **Bandwidth**: 250kHz
- **Spreading Factor**: 7
- **Coding Rate**: 4/5
- **Best For**: High-density local networks, fastest messaging

#### SHORT_TURBO

- **Range**: Very Short
- **Speed**: Fastest
- **Bandwidth**: 500kHz (widest)
- **Spreading Factor**: 7
- **Coding Rate**: 4/5
- **Best For**: Close-range, high-speed applications

**Side Effects**:
- All mesh participants must use compatible settings
- Changing presets may disconnect you from the network
- Slower presets = longer airtime = more power usage
- Faster presets = shorter range

### Region

**Description**: Sets the frequency band and regulatory settings for your location.

**Important**: Select the correct region for your location to comply with local regulations.

**Options**:
- **UNSET**: Region not configured
- **US**: United States (915MHz)
- **EU_433**: European Union (433MHz)
- **EU_868**: European Union (868MHz)
- **CN**: China
- **JP**: Japan
- **ANZ**: Australia/New Zealand
- **KR**: Korea
- **TW**: Taiwan
- **RU**: Russia
- **IN**: India
- **NZ_865**: New Zealand (865MHz)
- **TH**: Thailand
- **LORA_24**: WLAN Band (2.4GHz)
- **UA_433**: Ukraine (433MHz)
- **UA_868**: Ukraine (868MHz)

**Side Effects**:
- Incorrect region may violate local regulations
- May prevent communication with local mesh networks
- Affects maximum power output and duty cycle limits

::: warning Legal Compliance
Always select the correct region for your location. Using incorrect frequency bands may be illegal and could result in fines or equipment confiscation.
:::

### Hop Limit

**Description**: Maximum number of times a message can be relayed through the mesh.

**Range**: 0-7

**Default**: 3

**Effect**: Limits how far messages can propagate through the network. Each relay counts as one hop.

**Side Effects**:
- **Lower values (0-2)**: Reduced network range, less congestion, lower power usage
- **Higher values (5-7)**: Extended range, increased network load, more battery drain across all nodes
- Value of 7 allows messages to traverse large networks but may cause congestion

**Best Practices**:
- Use default (3) for most deployments
- Increase (4-5) only for very large geographic coverage
- Decrease (1-2) for dense local networks to reduce congestion

### Related Meshtastic Documentation

- [Meshtastic LoRa Configuration](https://meshtastic.org/docs/configuration/radio/lora/)
- [Modem Presets Explained](https://meshtastic.org/docs/overview/radio-settings/#preset)
- [Region Settings](https://meshtastic.org/docs/configuration/radio/lora/#region)

## Position Configuration

### Position Broadcast Interval

**Description**: How often to broadcast GPS position updates.

**Range**: 1-4294967295 seconds

**Default**: 900 seconds (15 minutes)

**Effect**: Controls frequency of position broadcasts to the mesh network.

**Side Effects**:
- Shorter intervals: More network traffic, more current position data, higher power/battery usage
- Longer intervals: Less network traffic, potentially stale position data, lower power usage

**Best Practices**:
- Mobile nodes: 300-900 seconds (5-15 minutes)
- Fixed nodes: 3600+ seconds (1+ hours)
- Disable entirely (very large value) for nodes that don't need position sharing

### Smart Position

**Description**: Intelligently adjusts position broadcast frequency based on movement.

**Effect**: When enabled, broadcasts more frequently when moving, less frequently when stationary.

**Side Effects**:
- Reduces unnecessary broadcasts for stationary nodes
- May delay position updates slightly
- Saves battery on mobile deployments

**Best Practices**: Enable for mobile nodes, optional for fixed installations

### Fixed Position

**Description**: Override GPS with a manually specified location.

**Effect**: Device reports the configured coordinates instead of GPS data.

**Use Cases**:
- Nodes without GPS hardware
- Indoor installations where GPS doesn't work
- Correcting inaccurate GPS readings
- Privacy (hiding exact GPS location)

**Configuration**: When enabled, enter:
- **Latitude**: Decimal degrees (-90 to 90)
- **Longitude**: Decimal degrees (-180 to 180)
- **Altitude**: Meters above sea level

**Side Effects**:
- Position never updates even if device moves
- GPS hardware is not used (saves power)

### Related Meshtastic Documentation

- [Meshtastic Position Configuration](https://meshtastic.org/docs/configuration/radio/position/)

## MQTT Configuration

### Enable MQTT

**Description**: Connect your Meshtastic device to an MQTT broker for internet connectivity.

**Effect**: Allows messages to bridge between your local mesh and other mesh networks via the internet.

**Use Cases**:
- Connecting multiple mesh networks
- Internet gateway functionality
- Remote monitoring and control
- Integration with home automation systems

### MQTT Address

**Description**: Hostname or IP address of the MQTT broker.

**Format**: `hostname:port` or `ip:port`

**Example**: `mqtt.example.com:1883`

### MQTT Username & Password

**Description**: Credentials for authenticating with the MQTT broker.

**Effect**: Required if your MQTT broker uses authentication.

**Security**: Credentials are stored on the device

### MQTT Encryption

**Description**: Enable TLS/SSL encryption for MQTT connections.

**Recommendation**: Always enable for public/internet MQTT brokers.

**Effect**: Encrypts MQTT traffic between device and broker.

**Side Effects**: Slightly higher power usage due to encryption overhead

### MQTT JSON

**Description**: Enable JSON encoding for MQTT messages.

**Effect**: Messages are sent in JSON format instead of protobuf.

**Use Cases**:
- Integration with systems that expect JSON
- Easier debugging and monitoring
- Home automation systems

**Side Effects**: Larger message size compared to protobuf

### MQTT Root Topic

**Description**: Base topic for MQTT messages.

**Default**: `msh/`

**Effect**: Customizes the MQTT topic hierarchy.

**Use Cases**: Running multiple independent mesh networks on same MQTT broker

### Related Meshtastic Documentation

- [Meshtastic MQTT Configuration](https://meshtastic.org/docs/configuration/module/mqtt/)
- [MQTT Module Documentation](https://meshtastic.org/docs/configuration/module/mqtt/)

## Neighbor Info

### Enable Neighbor Info Module

**Description**: Automatically collect and broadcast information about neighboring nodes.

**Effect**: Shares data about directly connected nodes (0-hop neighbors) with the network.

**Use Cases**:
- Network topology analysis
- Understanding node connectivity
- Optimizing node placement

### Neighbor Info Interval

**Description**: How often to send neighbor information updates.

**Range**: 1-4294967295 seconds

**Default**: 14400 seconds (4 hours)

**Effect**: Controls frequency of neighbor information broadcasts.

**Side Effects**:
- Shorter intervals: More network traffic, more current data
- Longer intervals: Less network traffic, potentially stale data

### Related Meshtastic Documentation

- [Meshtastic Neighbor Info Module](https://meshtastic.org/docs/configuration/module/neighbor-info/)

## Applying Changes

All configuration changes require clicking the "Save" button in each section. Most changes also require a device reboot to take effect. MeshMonitor will notify you when a reboot is required.

## Troubleshooting

### Configuration Not Saving

- Ensure you have a stable connection to the Meshtastic device
- Check that the device is powered and responsive
- Verify you have appropriate permissions

### Device Disconnected After Changes

- Some configuration changes (especially LoRa settings) may temporarily disconnect the device
- Wait 30-60 seconds for the device to reboot and reconnect
- If device doesn't reconnect, verify the configuration is compatible with your mesh network

### Can't Communicate After Region Change

- Ensure region matches other nodes in your mesh
- Verify the frequency is legal in your location
- Check that modem preset is compatible

## Related Documentation

- [Settings](/features/settings) - Learn about MeshMonitor settings
- [Automation](/features/automation) - Configure automation features
- [Meshtastic Official Documentation](https://meshtastic.org/docs/)
