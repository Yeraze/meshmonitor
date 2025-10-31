# Automation Features

MeshMonitor includes several automation features that can help you manage your mesh network more efficiently. These features run in the background and can be configured through the Info tab.

## Auto Acknowledge

Automatically responds to messages matching a specific pattern with a customizable confirmation message.

### How It Works

When enabled, MeshMonitor monitors all incoming messages for patterns matching the configured regular expression. When a match is found, it automatically replies with your custom message template.

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

**Custom Message Template**: Craft your auto-acknowledge response using dynamic tokens:

- **`{HOPS}`**: Number of hops from the original message (e.g., "3")
- **`{DATE}`**: Date when the message was received (e.g., "1/15/2025")
- **`{TIME}`**: Time when the message was received (e.g., "2:30:00 PM")
- **`{SENDER}`**: Long name of the sender (e.g., "Alice's Node")
- **`{MESSAGE}`**: The original message text

**Default Template**:
```
🤖 Copy, {HOPS} hops on {DATE} at {TIME}
```

**Example Custom Templates**:
```
✅ Received from {SENDER} on {DATE} at {TIME}
```
```
📡 Signal test: {HOPS} hop(s) | Date: {DATE} | Time: {TIME}
```
```
👋 Hey {SENDER}! Got your message: "{MESSAGE}"
```

**Token Insertion**: Click on any token button to insert it at your cursor position, making it easy to build complex templates.

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

**Node Filter** *(New in v2.12)*: Limit traceroutes to specific nodes instead of all nodes

- **Enable Filter**: Toggle to restrict traceroutes to selected nodes only
- **Node Selection**: Choose specific nodes from your network to trace
- **Search**: Filter available nodes by name or ID for easy selection
- **Benefits**:
  - Reduces network congestion in large networks
  - Focus on critical or problem nodes
  - Save battery on mobile nodes by excluding them
  - Customize monitoring for specific network segments
- **Recommendation**: Enable filtering in networks with 20+ nodes to reduce overhead

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

## Auto Welcome

Automatically sends a personalized welcome message to new nodes when they join your mesh network.

### How It Works

When enabled, MeshMonitor monitors for nodes that appear for the first time in the mesh network. When a new node is detected, it automatically sends a direct message to welcome them with your custom template.

### Configuration

**Enable/Disable**: Toggle the checkbox next to "Auto Welcome"

**Welcome Channel**: Select which channel to monitor for new nodes

- **Primary**: Monitor only the primary channel (most common)
- **All Channels**: Monitor all channels for new nodes
- Choose the channel where you expect new users to appear

**Custom Welcome Message**: Craft your welcome message using dynamic tokens:

- **`{SENDER}`**: Long name of the new node joining (e.g., "Alice's Node")
- **`{NODEID}`**: Hex ID of the new node (e.g., "!a2b3c4d5")
- **`{DATE}`**: Date when the node was first seen (e.g., "1/15/2025")
- **`{TIME}`**: Time when the node was first seen (e.g., "2:30:00 PM")
- **`{VERSION}`**: Your MeshMonitor version (e.g., "v2.11.3")

**Default Template**:
```
👋 Welcome {SENDER}! Thanks for joining the mesh.
```

**Example Custom Templates**:
```
🎉 Hey {SENDER}! Welcome to our mesh network on {DATE} at {TIME}
```
```
👋 Welcome aboard {SENDER} ({NODEID})! Check meshmonitor.org for network stats.
```
```
🌐 New node detected: {SENDER}. MeshMonitor {VERSION} is watching!
```

**Token Insertion**: Click on any token button to insert it at your cursor position for easy template creation.

### Side Effects

- **Network Traffic**: Each welcome message consumes airtime and generates mesh traffic
- **Privacy**: Welcome messages are sent as direct messages to the new node
- **Spam Protection**: Built-in 24-hour cooldown prevents re-welcoming the same node
- **First Join Only**: Only triggers when a node is seen for the very first time

### Use Cases

- Welcoming new members to your community mesh
- Providing network information or guidelines to newcomers
- Announcing the presence of MeshMonitor monitoring
- Building a friendly mesh community atmosphere

### Best Practices

- Keep messages concise and friendly
- Include useful information (network rules, contact info, website)
- Test your template with the token preview before enabling
- Consider what information would be helpful to a new user

### Related Meshtastic Documentation

Auto Welcome uses Meshtastic's direct messaging. For more information:
- [Meshtastic Messaging Documentation](https://meshtastic.org/docs/overview/mesh-algo#messaging)
- [Meshtastic Channels Documentation](https://meshtastic.org/docs/configuration/radio/channels)

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

**Scheduled Sends**: Use cron expressions for precise scheduling

- **Enable/Disable**: Toggle the "Use Scheduled Sends" checkbox
- **Cron Expression**: When enabled, replaces the interval-based scheduling with precise time-based scheduling
- **Default Expression**: `0 */6 * * *` (every 6 hours at the top of the hour)
- **Validation**: Live validation with visual feedback (green checkmark for valid expressions, red error for invalid)
- **Cron Helper**: Click the link to [crontab.guru](https://crontab.guru/) for assistance building cron expressions
- **Format**: Standard 5-field cron format (minute hour day month weekday)
- **Examples**:
  - `0 */6 * * *` - Every 6 hours at minute 0 (12:00 AM, 6:00 AM, 12:00 PM, 6:00 PM)
  - `0 9 * * *` - Every day at 9:00 AM
  - `0 12 * * 1` - Every Monday at noon
  - `30 8,20 * * *` - 8:30 AM and 8:30 PM daily
  - `0 0 1 * *` - First day of every month at midnight
- **UI Behavior**: When scheduled sends is enabled, the "Send every X hours" setting is hidden
- **Immediate Apply**: Changes to the cron schedule take effect immediately without requiring a container restart

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
- **Immediate Apply**: Changes to announce settings (interval, cron schedule, enabled/disabled) take effect immediately without requiring a container restart
- **Channel Impact**: Announcement messages appear in the selected channel for all users

### Use Cases

- Notifying mesh users of MeshMonitor availability
- Sharing network statistics periodically
- Announcing system features and capabilities
- Providing automated status updates

### Best Practices

- Keep messages concise to minimize airtime usage
- Use intervals of 6-12 hours to avoid spam, or use cron expressions for precise scheduling
- Use cron expressions for precise timing (e.g., daily at 9 AM instead of every 6 hours)
- Consider time zones when scheduling (container timezone applies to cron expressions)
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
