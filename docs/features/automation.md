# Automation Features

MeshMonitor includes several automation features that can help you manage your mesh network more efficiently. These features run in the background and can be configured through the Info tab.

## Auto Acknowledge

Automatically responds to messages matching a specific pattern with a confirmation message.

### How It Works

When enabled, Mesh Monitor monitors all incoming messages for patterns matching the configured regular expression. When a match is found, it automatically replies with:

```
🤖 Copy, N hops at T
```

Where:
- **N** is the number of hops in the originating message
- **T** is the date/time the message was received

### Configuration

**Enable/Disable**: Toggle the checkbox next to "Auto Acknowledge"

**Message Pattern (Regular Expression)**: Defines which messages trigger auto-acknowledgment

- **Default**: `^(test|ping)`
- **Case Insensitive**: Patterns match regardless of capitalization
- **Maximum Length**: 100 characters
- **Examples**:
  - `^ping` - Matches messages starting with "ping"
  - `test` - Matches messages containing "test" anywhere
  - `^(hello|hi|hey)` - Matches messages starting with hello, hi, or hey

**Pattern Testing**: The interface includes a live testing area where you can enter sample messages to see if they match your pattern. Matching messages are highlighted in green, non-matching in red.

### Side Effects

- Generates additional mesh traffic for each matched message
- May contribute to network congestion if pattern matches too frequently
- Replies are sent immediately upon receiving a matching message
- Uses airtime on the mesh network for responses

### Use Cases

- Testing mesh range and reliability
- Monitoring network responsiveness
- Automated acknowledgment of status checks
- Quick ping/pong style network testing

### Related Meshtastic Documentation

This feature leverages Meshtastic's messaging capabilities. For more information about Meshtastic messaging, see:
- [Meshtastic Messaging Documentation](https://meshtastic.org/docs/overview/mesh-algo#messaging)

## Auto Traceroute

Automatically sends traceroute requests to all active nodes at a configured interval to maintain up-to-date network topology information.

### How It Works

When enabled, MeshMonitor periodically sends traceroute requests to all nodes in the active node list. Traceroutes reveal the path messages take through the mesh network, showing which nodes relay traffic between the source and destination.

### Configuration

**Enable/Disable**: Toggle the checkbox next to "Auto Traceroute"

**Traceroute Interval**: How often to send traceroute requests to nodes

- **Range**: 1-60 minutes
- **Default**: 3 minutes
- **Recommendation**: Use longer intervals (10-15 minutes) for larger networks or slower mesh presets

### Side Effects

- **Network Congestion**: Each traceroute request generates multiple packets. In large networks with many nodes, this can significantly increase mesh traffic
- **Airtime Usage**: Consumes airtime on the LoRa radio, which may affect message delivery performance
- **Battery Impact**: Causes nodes to relay more packets, increasing power consumption
- **Requires Restart**: Changes to this setting require a container restart to take effect

### Use Cases

- Maintaining current network topology maps
- Monitoring how routes change over time
- Identifying reliable vs. unreliable routes
- Debugging mesh connectivity issues
- Analyzing network health and performance

### Best Practices

- Use longer intervals (10-15 minutes) for stable networks
- Use shorter intervals (3-5 minutes) only when actively troubleshooting
- Disable during periods of high network activity
- Consider disabling on battery-powered devices to conserve power

### Related Meshtastic Documentation

Traceroute uses Meshtastic's routing protocol. For more information:
- [Meshtastic Routing Documentation](https://meshtastic.org/docs/overview/mesh-algo#routing)
- [Traceroute Request Documentation](https://meshtastic.org/docs/configuration/module/traceroute)

## Auto Announce

Automatically broadcasts periodic announcement messages to a selected channel.

### How It Works

When enabled, MeshMonitor sends a scheduled message to the configured channel at the specified interval. The message can include dynamic tokens that are replaced with current system information.

### Configuration

**Enable/Disable**: Toggle the checkbox next to "Auto Announce"

**Announcement Interval**: How often to broadcast the announcement

- **Range**: 3-24 hours
- **Default**: 6 hours
- **Recommendation**: Use longer intervals (6-12 hours) to avoid annoying mesh users

**Announce on Start**: When enabled, automatically sends an announcement when the container starts

- Includes 1-hour spam protection to prevent network flooding during container restarts
- Useful for notifying the network that MeshMonitor is back online after maintenance

**Broadcast Channel**: Select which channel to send announcements on

- Choose from any available channel on your device
- Typically use the Primary channel or a dedicated announcements channel
- Avoid using channels meant for private or sensitive communications

**Announcement Message**: The text to broadcast. Supports dynamic tokens:

- **`{VERSION}`**: Current MeshMonitor version (e.g., "v2.2.2")
- **`{DURATION}`**: System uptime (e.g., "2 days, 5 hours")
- **`{FEATURES}`**: Enabled automation features as emojis (e.g., "🗺️ 🤖")
  - 🗺️ = Auto Traceroute enabled
  - 🤖 = Auto Acknowledge enabled
  - 📢 = Auto Announce enabled
- **`{NODECOUNT}`**: Number of active nodes (e.g., "42 nodes")
- **`{DIRECTCOUNT}`**: Number of direct nodes at 0 hops

**Default Message**:
```
MeshMonitor {VERSION} online for {DURATION} {FEATURES}
```

### Side Effects

- **Network Traffic**: Each announcement consumes airtime and generates mesh traffic
- **User Annoyance**: Too-frequent announcements may be seen as spam by mesh users
- **Requires Restart**: Changes to this setting require a container restart to take effect
- **Channel Impact**: Announcement messages appear in the selected channel for all users

### Use Cases

- Notifying mesh users of MeshMonitor availability
- Sharing network statistics periodically
- Announcing system features and capabilities
- Providing automated status updates

### Best Practices

- Keep messages concise to minimize airtime usage
- Use intervals of 6-12 hours to avoid spam
- Include useful information using tokens
- Test messages with "Send Now" before enabling automatic scheduling
- Be considerate of other mesh users

### Send Now Button

The "Send Now" button allows you to manually trigger an announcement immediately without waiting for the next scheduled interval. This is useful for:
- Testing your message format
- Announcing system maintenance or updates
- Verifying channel configuration

### Related Meshtastic Documentation

Auto Announce uses Meshtastic's channel messaging. For more information:
- [Meshtastic Channels Documentation](https://meshtastic.org/docs/configuration/radio/channels)
- [Meshtastic Messaging Documentation](https://meshtastic.org/docs/overview/mesh-algo#messaging)

## Configuration Storage

All automation settings are stored on the MeshMonitor server and persist across container restarts and browser sessions. Changes made by any user with appropriate permissions will affect all users accessing the system.

## Permissions

Modifying automation settings requires appropriate user permissions. Regular users may view automation status but cannot change settings without admin privileges.

## Related Documentation

- [Settings](/features/settings) - Learn about general MeshMonitor settings
- [Device Configuration](/features/device) - Configure your Meshtastic device
- [Production Deployment](/configuration/production) - Best practices for production environments
