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

- **`{HOPS}`** or **`{NUMBER_HOPS}`**: Number of hops from the original message (e.g., "3" for multi-hop or "0" for direct)
- **`{RABBIT_HOPS}`**: Visual hop indicator (🎯 for direct/0 hops, 🐇 emojis for multi-hop, e.g., "🐇🐇🐇" for 3 hops)
- **`{DATE}`**: Date when the message was received (e.g., "1/15/2025")
- **`{TIME}`**: Time when the message was received (e.g., "2:30:00 PM")
- **`{LONG_NAME}`**: Long name of the sender (e.g., "Alice's Node")
- **`{SHORT_NAME}`**: Short name of the sender (e.g., "ALI")
- **`{NODE_ID}`**: Sender's node ID (e.g., "!a1b2c3d4")
- **`{SNR}`**: Signal-to-Noise Ratio in dB (e.g., "7.5")
- **`{RSSI}`**: Received Signal Strength Indicator in dBm (e.g., "-95")
- **`{VERSION}`**: MeshMonitor version
- **`{DURATION}`**: System uptime
- **`{FEATURES}`**: Enabled automation features
- **`{NODECOUNT}`**: Number of active nodes
- **`{DIRECTCOUNT}`**: Number of direct nodes (0 hops)

**Default Template (Multi-hop)**:
```
🤖 Copy, {NUMBER_HOPS} hops at {TIME}
```

**Default Template (Direct Connection)**:
```
🤖 Copy, direct connection! SNR: {SNR}dB RSSI: {RSSI}dBm at {TIME}
```

**Separate Templates for Direct vs. Multi-hop**: You can configure different acknowledgment messages for direct connections (0 hops) versus multi-hop messages. This allows you to include signal quality metrics like SNR and RSSI for direct connections while showing hop count for relayed messages.

**Example Custom Templates**:
```
✅ Received from {LONG_NAME} on {DATE} at {TIME}
```
```
📡 Signal test: {HOPS} hop(s) | Date: {DATE} | Time: {TIME}
```
```
👋 Hey {LONG_NAME}! Got your message: "{MESSAGE}"
```

**Token Insertion**: Click on any token button to insert it at your cursor position, making it easy to build complex templates.

### Skip Incomplete Nodes {#skip-incomplete-nodes-ack}

**Description**: When enabled, Auto Acknowledge will not respond to messages from incomplete nodes.

**Default**: Disabled

**What are incomplete nodes?**: Nodes missing proper `longName`, `shortName`, or `hwModel`. On secure channels (custom PSK), this typically means we haven't received their encrypted NODEINFO packet - they may have just overheard traffic but aren't verified channel members.

**When to enable**:
- Using secure/encrypted channels with custom PSK
- Want to only acknowledge messages from verified nodes
- Prevent responding to nodes that may be eavesdropping

**Related**: See [Hide Incomplete Nodes](/features/settings#hide-incomplete-nodes) for UI filtering.

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

## Remote Admin Scanner {#remote-admin-scanner}

Automatically discovers which nodes in your mesh network have remote administration capabilities enabled. This helps you identify nodes that can be managed remotely through MeshMonitor's Admin Commands feature.

### How It Works

When enabled, MeshMonitor periodically scans active nodes to determine if they have remote admin access enabled. The scanner:

1. Identifies nodes with public keys (required for secure admin communication)
2. Sends a device metadata request to each node
3. Waits for a response (nodes without admin access will not respond)
4. Records the result for each node

Scan results are displayed in the Node Details panel and can be used to quickly identify which nodes support remote administration.

### Configuration

**Enable/Disable**: Toggle the checkbox next to "Remote Admin Scanner"

**Scan Interval**: How often to check nodes for admin capability

- **Range**: 1-60 minutes
- **Default**: 5 minutes
- **Recommendation**: Use longer intervals (10-15 minutes) for larger networks to reduce mesh traffic

**Result Expiration**: How long scan results remain valid before a node needs to be re-scanned

- **Range**: 24-168 hours (1-7 days)
- **Default**: 168 hours (7 days)
- **Purpose**: Prevents re-scanning nodes that were recently checked

### Stats Panel

The scanner displays real-time statistics:

- **Nodes with Admin**: Number of nodes confirmed to have remote admin enabled
- **Nodes Checked**: Total nodes that have been scanned
- **Eligible Nodes**: Nodes with public keys (candidates for scanning)

### Scan Log

When enabled, a scan log shows recent scan activity:

- **Timestamp**: When the node was last checked
- **Node**: The node name and ID
- **Status**: ✓ (green) for admin available, ✗ (red) for no admin
- **Firmware**: Device firmware version (if admin is available)

### Node Details Integration

Scan results appear in the Node Details panel for each node:

- **Available**: Remote admin is enabled with the date it was verified
- **Unavailable**: Remote admin is not enabled with the date it was checked
- **Unknown**: Node has never been scanned

### Side Effects

- **Network Traffic**: Each scan generates admin protocol packets
- **Response Time**: Scans wait up to 45 seconds for node responses
- **Battery Impact**: Scanning causes nodes to process admin requests
- **Airtime Usage**: Uses encrypted admin channel airtime

### Use Cases

- **Network Discovery**: Identify all remotely manageable nodes in your mesh
- **Security Auditing**: Find nodes with admin access that may need securing
- **Fleet Management**: Quickly see which nodes can be configured remotely
- **Troubleshooting**: Verify if a node's admin access is working

### Best Practices

- **Interval Selection**: Use longer intervals for stable networks
- **Expiration Period**: Shorter expiration for networks with frequent changes
- **Off-Peak Scanning**: Consider disabling during high network activity
- **Review Results**: Periodically check for unexpected admin-enabled nodes

### Troubleshooting

**No Nodes Being Scanned**:
- Verify nodes have public keys (required for admin communication)
- Check that nodes are "active" (heard within the configured maxNodeAgeHours)
- Ensure the scanner is enabled and saved

**All Scans Failing**:
- Remote admin may not be enabled on target nodes
- Nodes may be too far away or unreachable
- Check mesh connectivity to target nodes

**Scan Log Not Showing**:
- Ensure the scanner checkbox is enabled
- Refresh the browser page
- Check that scans have had time to complete (45+ seconds per node)

### Related Documentation

- [Admin Commands](/features/admin-commands) - Use remote admin to configure nodes
- [Security](/features/security) - Learn about node security and encryption

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

**Maximum Hops Filter**: Limit welcome messages to nodes within a specific hop range

- **Range**: 0-7 hops
- **Default**: 7 (all nodes)
- **Purpose**: Prevents welcoming distant nodes that may not be regular network participants
- **Use Cases**:
  - Set to 0-1 for welcoming only direct neighbors
  - Set to 2-3 for local network participants
  - Set to 7 to welcome all nodes regardless of distance
- **Benefits**:
  - Reduces unnecessary mesh traffic for distant nodes
  - Focuses welcomes on local/active participants
  - Helps manage network congestion in large meshes

**Custom Welcome Message**: Craft your welcome message using dynamic tokens:

- **`{LONG_NAME}`**: Long name of the new node joining (e.g., "Alice's Node")
- **`{NODEID}`**: Hex ID of the new node (e.g., "!a2b3c4d5")
- **`{DATE}`**: Date when the node was first seen (e.g., "1/15/2025")
- **`{TIME}`**: Time when the node was first seen (e.g., "2:30:00 PM")
- **`{VERSION}`**: Your MeshMonitor version (e.g., "v2.11.3")

**Default Template**:
```
👋 Welcome {LONG_NAME}! Thanks for joining the mesh.
```

**Example Custom Templates**:
```
🎉 Hey {LONG_NAME}! Welcome to our mesh network on {DATE} at {TIME}
```
```
👋 Welcome aboard {LONG_NAME} ({NODEID})! Check meshmonitor.org for network stats.
```
```
🌐 New node detected: {LONG_NAME}. MeshMonitor {VERSION} is watching!
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

## Auto Responder

Automatically responds to messages matching custom trigger patterns with either text or HTTP requests. This powerful feature enables creating bot-like functionality such as weather information, node status, or custom commands.

### How It Works

When enabled, MeshMonitor monitors all incoming messages for patterns matching your configured triggers. When a message matches, it either sends a text response with extracted parameters or makes an HTTP request to an external service with the extracted data.

### Configuration

**Enable/Disable**: Toggle the checkbox next to "Auto Responder"

**Triggers**: Create custom trigger patterns that match specific message formats

Each trigger consists of:
- **Trigger Pattern**: The message pattern to match (e.g., "weather {location}")
- **Response Type**: Either "text" (send a message) or "http" (make an HTTP request)
- **Response**: The action to take when triggered

### Trigger Patterns

Trigger patterns can include parameters using curly braces `{parameter}` that extract information from messages:

**Basic Examples**:
- `weather {location}` - Matches "weather miami" or "weather new york"
- `w {city},{state}` - Matches "w parkland,fl" or "w austin,tx"
- `status {nodeid}` - Matches "status !a1b2c3d4"
- `hello` - Simple pattern with no parameters

**Pattern Matching**:
- Case insensitive by default
- Parameters match any non-whitespace characters by default
- Parameters support commas and special characters (e.g., "parkland,fl")
- Patterns are matched against the entire message

#### Multiple Patterns Per Trigger

You can specify multiple patterns for a single trigger by separating them with commas. This allows one trigger to match different message formats:

**Examples**:
- `ask, ask {message}` - Matches both "ask" (shows help) and "ask {message}" (processes the message)
- `help, help {command}` - Matches "help" (general help) and "help weather" (command-specific help)
- `temp, temp {value:\d+}` - Matches "temp" (current temp) and "temp 72" (set temp to 72)

**Usage**: Enter patterns separated by commas in the trigger field: `ask, ask {message}`

#### Regex Pattern Examples

You can specify custom regex patterns for parameters using `{paramName:regex}` syntax for more precise matching:

**Numeric Patterns**:
- `w {zip:\d{5}}` - Matches only 5-digit zip codes (e.g., "w 33076")
- `temp {value:\d+}` - Matches only numeric values (e.g., "temp 72", but not "temp hot")
- `set {num:-?\d+}` - Matches positive or negative integers (e.g., "set 42" or "set -42")

**Decimal Patterns**:
- `coords {lat:-?\d+\.?\d*},{lon:-?\d+\.?\d*}` - Matches decimal coordinates (e.g., "coords 40.7128,-74.0060")

**Multi-word Patterns**:
- `weather {location:[\w\s]+}` - Matches locations with spaces (e.g., "weather new york")
- `alert {message:.+}` - Matches everything including punctuation (e.g., "alert Hello, world!")

**Common Regex Patterns**:
- `\d+` - One or more digits
- `\d{5}` - Exactly 5 digits
- `[\w\s]+` - Word characters and spaces
- `.+` - Any character (including spaces and punctuation)
- `-?\d+\.?\d*` - Optional negative sign, digits, optional decimal point and digits

**Note**: Remember to escape special regex characters if they appear in your pattern: `\ . + * ? ^ $ { } [ ] ( ) |`

### Response Types

**Text Response**: Sends a message back to the sender

- Supports multiline text (automatically uses textarea for editing)
- Can include extracted parameters using `{parameter}` syntax
- **Multiline Support**: Enable to automatically split long responses into multiple messages
- Example trigger: `hello {name}`
- Example response: `Hi {name}! Welcome to the mesh.`

**HTTP Response**: Makes an HTTP GET request to an external service

- URL can include extracted parameters using `{parameter}` syntax
- **Multiline Support**: Enable to automatically split long responses into multiple messages
- Useful for triggering webhooks, APIs, or external automation
- Example trigger: `alert {message}`
- Example response: `https://api.example.com/alert?msg={message}`

**Script Response**: Executes a custom script for advanced logic

- Scripts must be placed in `/data/scripts/` directory
- Supports Node.js (`.js`, `.mjs`), Python (`.py`), and Shell (`.sh`) scripts
- Scripts receive message data and parameters via environment variables
- Can output single or multiple responses (see Script Response Details below)
- 10-second execution timeout
- Example trigger: `weather {location}`
- Example response: `/data/scripts/weather.py`

### Multiline Support

For **Text** and **HTTP** response types, you can enable multiline support to automatically split long responses into multiple messages. This feature is useful when responses exceed the 200-character limit.

**How It Works**:

When multiline is enabled, responses are intelligently split using the following priority:

1. **Line Breaks** (if using >50% of available space)
   - Splits on `\n` characters
   - Best for pre-formatted multi-paragraph responses

2. **Sentence Endings** (if using >50% of space)
   - Splits after `. `, `! `, or `? `
   - Keeps complete sentences together

3. **Punctuation** (if using >50% of space)
   - Splits after `, `, `; `, `: `, or ` - `
   - Preserves clause boundaries

4. **Spaces** (if using >30% of space)
   - Splits at word boundaries
   - Avoids cutting words in half

5. **Hyphens** (if using >30% of space)
   - Splits at hyphenated words
   - Last resort before character splitting

6. **Character Split** (if no better option)
   - Splits at exactly 200 characters
   - Only used when absolutely necessary

**Message Queue Behavior**:

Each split message is:
- Queued individually
- Sent with 30-second intervals between messages
- Retried up to 3 times on failure
- Tracked for ACK delivery confirmation

**Example**:

```
Trigger: help
Response Type: text
Multiline: ✓ Enabled
Response:
Welcome to our mesh bot! Available commands:
- weather {location}: Get weather info
- status {nodeid}: Check node status
- ping: Test connectivity
For more info visit meshmonitor.org
```

This would be split into approximately 3 messages, each sent 30 seconds apart.

**When to Use Multiline**:
- Help text with multiple commands
- Long informational responses
- Multi-paragraph announcements
- Formatted lists or instructions

**When NOT to Use Multiline**:
- Simple acknowledgments
- Short status updates
- Time-sensitive responses
- Single-line messages

### Parameter Extraction

Parameters are automatically extracted from the incoming message and can be used in responses:

**Example 1 - Weather Bot**:
```
Trigger: weather {location}
Response Type: http
Response: https://api.weather.com/lookup?q={location}
```

When someone sends "weather miami", MeshMonitor makes a request to:
`https://api.weather.com/lookup?q=miami`

**Example 2 - Greeting Bot**:
```
Trigger: hello {name}
Response Type: text
Response: Hey {name}! Thanks for saying hello. Welcome to our mesh network!
```

When someone sends "hello Alice", MeshMonitor replies:
`Hey Alice! Thanks for saying hello. Welcome to our mesh network!`

**Example 3 - Multi-Parameter**:
```
Trigger: w {city},{state}
Response Type: text
Response: Looking up weather for {city}, {state}...
```

When someone sends "w parkland,fl", MeshMonitor replies:
`Looking up weather for parkland, fl...`

### Script Response Details

Scripts provide the most powerful and flexible response type, allowing you to execute custom logic, call external APIs, query databases, or perform complex calculations.

**Setting Up Scripts**:

1. **Create Your Script**: Write a script in Node.js, Python, or Shell
2. **Copy to Container**: Place the script in `/data/scripts/` directory
3. **Make Executable**: Ensure the script has execute permissions
4. **Configure Trigger**: Set response type to "Script" and enter the full path

**Script Requirements**:

Scripts must:
- Be located in `/data/scripts/` directory
- Have a supported extension: `.js`, `.mjs`, `.py`, or `.sh`
- Output valid JSON to stdout with a `response` field
- Complete execution within 10 seconds (timeout)
- Handle errors gracefully

**Environment Variables**:

All scripts receive these environment variables:
- `MESSAGE`: Full message text received
- `FROM_NODE`: Sender's node number
- `PACKET_ID`: Message packet ID
- `TRIGGER`: The trigger pattern that matched
- `PARAM_*`: Extracted parameters (e.g., `PARAM_location`, `PARAM_name`)

**JSON Output Format**:

Scripts can return single or multiple responses:

**Single Response:**
```json
{
  "response": "Your response text (max 200 chars)"
}
```

**Multiple Responses:**
```json
{
  "responses": [
    "First message (max 200 chars)",
    "Second message (max 200 chars)",
    "Third message (max 200 chars)"
  ]
}
```

When using multiple responses, each message is queued individually and sent with:
- 30-second rate limiting between messages
- Up to 3 retry attempts per message
- Automatic ACK tracking for delivery confirmation

**Example 1 - Node.js Weather Script**:
```javascript
#!/usr/bin/env node

const location = process.env.PARAM_location || 'Unknown';

// In production, call a real weather API
const response = {
  response: `Weather for ${location}: Sunny, 72°F`
};

console.log(JSON.stringify(response));
```

Trigger Configuration:
```
Trigger: weather {location}
Response Type: script
Response: /data/scripts/weather.js
```

**Example 2 - Python Script with API Call**:
```python
#!/usr/bin/env python3
import os
import json
import urllib.request

location = os.environ.get('PARAM_location', 'Unknown')

try:
    # Call weather API
    url = f"https://wttr.in/{location}?format=3"
    with urllib.request.urlopen(url, timeout=5) as response:
        weather_data = response.read().decode('utf-8').strip()

    output = {"response": weather_data}
except Exception as e:
    output = {"response": f"Weather lookup failed for {location}"}

print(json.dumps(output))
```

**Example 3 - Shell Script**:
```bash
#!/bin/sh

NAME="${PARAM_name:-stranger}"

cat <<EOF
{
  "response": "Hello ${NAME}! From node ${FROM_NODE}"
}
EOF
```

**Copying Scripts to Container**:
```bash
# Copy a single script
docker cp weather.py meshmonitor:/data/scripts/

# Copy multiple scripts
docker cp scripts/ meshmonitor:/data/

# Make scripts executable
docker exec meshmonitor chmod +x /data/scripts/*.py
```

**Debugging Scripts**:

View execution logs:
```bash
docker logs -f meshmonitor
```

Scripts can write debug info to stderr (visible in logs):
```javascript
console.error('Debug info:', variable);  // Node.js
```
```python
print(f'Debug: {variable}', file=sys.stderr)  # Python
```
```bash
echo "Debug: $VARIABLE" >&2  # Shell
```

**Script Security**:
- Scripts are sandboxed to `/data/scripts/` directory
- Path traversal attempts (`..`) are blocked
- Scripts run with container user permissions (not root)
- 10-second execution timeout prevents runaway scripts
- Output limited to 1MB to prevent memory issues

**Performance Tips**:
- Keep scripts fast (< 1 second preferred)
- Cache external API results when possible
- Use async I/O for network requests
- Test scripts locally before deployment
- Monitor container logs for errors

**Example Scripts**:

The MeshMonitor repository includes example scripts in `examples/auto-responder-scripts/`:
- `hello.js` - Simple Node.js greeting script with parameter extraction
- `weather.py` - Python weather lookup template with API call
- `PirateWeather.py` - Complete Pirate Weather API integration with Nominatim geocoding support
- `info.sh` - Shell script showing system info
- `lorem.js/py/sh` - Multi-response examples that send 3 Lorem Ipsum messages

The `lorem` examples demonstrate the **multiple responses** feature where a script returns an array of messages that are queued and sent individually with rate limiting.

See the [examples/auto-responder-scripts/README.md](https://github.com/MeshAddicts/meshmonitor/tree/main/examples/auto-responder-scripts) for detailed documentation.

### Managing Triggers

**Adding Triggers**:
1. Enter your trigger pattern (e.g., "weather {location}")
2. Select response type (text, http, or script)
3. Enter your response (text message, URL, or script path)
4. Click "Add Trigger"

**Editing Triggers**:
1. Click the "Edit" button next to any trigger
2. Modify the pattern, type, or response
3. Click "Save" to apply changes or "Cancel" to discard
4. Edited triggers show a blue border while in edit mode

**Removing Triggers**:
- Click the "Remove" button next to any trigger

**Multiline Text Support**:
- Text responses automatically use a multiline textarea
- Supports 3+ lines with vertical resizing
- Useful for longer responses or formatted text

### Skip Incomplete Nodes {#skip-incomplete-nodes-responder}

**Description**: When enabled, Auto Responder will not process or respond to messages from incomplete nodes.

**Default**: Disabled

**What are incomplete nodes?**: Nodes missing proper `longName`, `shortName`, or `hwModel`. On secure channels (custom PSK), this typically means we haven't received their encrypted NODEINFO packet - they may have just overheard traffic but aren't verified channel members.

**When to enable**:
- Using secure/encrypted channels with custom PSK
- Want bot functionality to only serve verified nodes
- Prevent external HTTP requests or script execution from unverified sources

**Related**: See [Hide Incomplete Nodes](/features/settings#hide-incomplete-nodes) for UI filtering, or [Skip Incomplete Nodes for Auto Acknowledge](#skip-incomplete-nodes-ack).

### Side Effects

- **Network Traffic**: Each triggered response generates mesh traffic
- **Response Time**: Text responses are sent immediately; HTTP requests depend on external service response time
- **Privacy**: Be cautious with HTTP requests - parameters from messages are sent to external services
- **Rate Limiting**: Consider implementing external rate limiting for HTTP webhooks
- **Airtime Usage**: Text responses consume airtime on the LoRa radio

### Use Cases

**Information Bots**:
- Weather lookup: `weather {location}` → HTTP request to weather API
- Node status: `status {nodeid}` → Text response with node information
- Help command: `help` → Text response with available commands

**Automation Triggers**:
- Alert forwarding: `alert {message}` → HTTP webhook to notification service
- Data logging: `log {sensor},{value}` → HTTP POST to logging service
- Integration: `trigger {action}` → HTTP request to home automation

**Interactive Commands**:
- Greetings: `hello {name}` → Personalized welcome message
- Pings: `ping` → "pong!" response
- Info requests: `info {topic}` → Detailed information response

### Best Practices

**Pattern Design**:
- Use descriptive parameter names (e.g., `{location}` not `{x}`)
- Keep patterns simple and memorable
- Document your available commands somewhere accessible
- Avoid overlapping patterns that might cause confusion

**Text Responses**:
- Keep responses concise to minimize airtime usage
- Include parameter values to confirm what was matched
- Use multiline text for structured information
- Consider adding emojis for visual clarity

**HTTP Requests**:
- Validate external services are reliable and fast
- Use HTTPS for secure external communications
- Implement error handling on the receiving service
- Consider rate limiting to prevent abuse
- Test URLs before deploying to production

**Security Considerations**:
- Don't expose sensitive URLs or API keys in triggers
- Be aware that parameters come from untrusted user input
- Sanitize parameters on the receiving end for HTTP requests
- Consider what information you're sharing with external services

**Network Impact**:
- Limit number of triggers to avoid complexity
- Monitor for patterns that might match too frequently
- Consider disabling during high network activity periods
- Test thoroughly before enabling on production networks

### Example Configurations

**Simple Ping Bot**:
```
Trigger: ping
Response Type: text
Response: pong!
```

**Weather Lookup**:
```
Trigger: weather {city}
Response Type: http
Response: https://wttr.in/{city}?format=3
```

**Multi-Parameter Weather**:
```
Trigger: w {city},{state}
Response Type: http
Response: https://api.weather.example.com/v1/current?city={city}&state={state}
```

**Help Command**:
```
Trigger: help
Response Type: text
Response: Available commands:
- weather {location}
- w {city},{state}
- status {nodeid}
- ping
```

**Node Status**:
```
Trigger: status {nodeid}
Response Type: text
Response: Looking up status for node {nodeid}...
```

### Troubleshooting

**Triggers Not Matching**:
- Check that patterns are spelled correctly
- Remember matching is case insensitive
- Verify parameters use `{paramName}` format
- Test with simple patterns first

**Parameters Not Extracting**:
- Ensure parameter names match between trigger and response
- Parameters must be surrounded by `{` and `}`
- Parameters cannot contain spaces
- Check for typos in parameter names

**HTTP Requests Failing**:
- Verify the URL is correct and accessible
- Check that parameters are properly URL-encoded
- Test the URL manually in a browser first
- Check external service logs for errors

### Related Meshtastic Documentation

Auto Responder uses Meshtastic's messaging system. For more information:
- [Meshtastic Messaging Documentation](https://meshtastic.org/docs/overview/mesh-algo#messaging)
- [Meshtastic Text Messages](https://meshtastic.org/docs/configuration/module/canned-message)

## Timer Triggers (Timed Events) {#timer-triggers}

Schedule scripts to run automatically at specified times using cron expressions. This feature allows you to automate recurring tasks like sending daily status updates, weather reports, or network statistics to your mesh network.

### How It Works

Timer Triggers execute scripts from `/data/scripts/` on a schedule defined by cron expressions. When a timer fires, the associated script runs and its output is sent to a specified channel on your mesh network.

### Configuration

**Adding a Timer**:
1. Navigate to the Automation settings (Info tab)
2. Scroll to the "Timed Events" section
3. Fill out the timer configuration:
   - **Name**: A descriptive name for your timer (e.g., "Daily Weather Report")
   - **Schedule**: A cron expression defining when to run
   - **Script**: Select a script from `/data/scripts/`
   - **Channel**: The channel to send script output to
4. Click "Add Timer"
5. Click "Save" to persist your changes

**Timer Properties**:

Each timer has:
- **Name**: Human-readable identifier for the timer
- **Cron Expression**: Standard 5-field cron format (minute hour day month weekday)
- **Script**: Path to the script in `/data/scripts/`
- **Channel**: Channel index (0-7) where output is sent
- **Enabled**: Toggle to enable/disable individual timers
- **Last Run**: Timestamp of last execution (shown in timer list)
- **Last Result**: Success or error status of last execution

### Cron Expression Format

Timer schedules use standard 5-field cron syntax:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6) (Sunday=0)
│ │ │ │ │
* * * * *
```

**Common Examples**:
- `0 */6 * * *` - Every 6 hours at minute 0
- `0 9 * * *` - Every day at 9:00 AM
- `30 8,20 * * *` - 8:30 AM and 8:30 PM daily
- `0 12 * * 1` - Every Monday at noon
- `0 0 1 * *` - First day of every month at midnight
- `*/15 * * * *` - Every 15 minutes

**Cron Helper**: Use [crontab.guru](https://crontab.guru/) to build and validate cron expressions.

### Script Requirements

Timer trigger scripts follow the same requirements as Auto Responder scripts:

- Located in `/data/scripts/` directory
- Supported extensions: `.js`, `.mjs`, `.py`, `.sh`
- Must output valid JSON to stdout with a `response` or `responses` field
- 10-second execution timeout
- Execute with container user permissions

**JSON Output Format**:

**Single Response:**
```json
{
  "response": "Your message text (max 200 chars)"
}
```

**Multiple Responses:**
```json
{
  "responses": [
    "First message",
    "Second message",
    "Third message"
  ]
}
```

### Example Timer Configurations

**Daily Weather Report**:
```
Name: Daily Weather
Schedule: 0 8 * * *
Script: weather.py
Channel: 0 (Primary)
```

Sends weather information to the primary channel every morning at 8 AM.

**Hourly Network Status**:
```
Name: Network Stats
Schedule: 0 * * * *
Script: network-stats.js
Channel: 2 (LongFast)
```

Reports network statistics every hour on the hour.

**Weekly Summary**:
```
Name: Weekly Summary
Schedule: 0 18 * * 0
Script: weekly-report.py
Channel: 0 (Primary)
```

Sends a weekly summary every Sunday at 6 PM.

### Example Scripts

**Simple Status Script (status.js)**:
```javascript
#!/usr/bin/env node

const now = new Date();
const response = {
  response: `Network status check: ${now.toLocaleString()}`
};

console.log(JSON.stringify(response));
```

**Weather Script (daily-weather.py)**:
```python
#!/usr/bin/env python3
import json
import urllib.request

try:
    url = "https://wttr.in/YourCity?format=3"
    with urllib.request.urlopen(url, timeout=5) as response:
        weather = response.read().decode('utf-8').strip()
    output = {"response": weather}
except Exception as e:
    output = {"response": "Weather unavailable"}

print(json.dumps(output))
```

### Managing Timers

**Enable/Disable**: Click the "Enable" or "Disable" button on any timer to toggle its active state without removing it.

**Edit Timer**: Click "Edit" to modify any timer property, then "Save" to apply changes.

**Remove Timer**: Click "Remove" and confirm to delete a timer.

**Save Changes**: After adding, editing, or removing timers, click the "Save" button in the header to persist changes.

### Side Effects

- **Network Traffic**: Each timer execution sends messages to the mesh network
- **Airtime Usage**: Timer outputs consume LoRa airtime
- **Script Execution**: Scripts run in the container with 10-second timeout
- **Queue Processing**: Multi-response scripts queue messages with 30-second intervals

### Use Cases

- **Scheduled Announcements**: Daily mesh status updates or community messages
- **Weather Reports**: Automatic weather information at specified times
- **Network Statistics**: Periodic reports on node counts, connectivity, etc.
- **Maintenance Reminders**: Weekly or monthly maintenance notifications
- **Data Collection**: Scheduled sensor readings or API queries
- **Heartbeat Messages**: Regular "alive" messages to verify system operation

### Best Practices

- **Timing**: Spread timers across different times to avoid congestion
- **Frequency**: Use appropriate intervals - hourly or daily for most use cases
- **Script Testing**: Test scripts manually via Auto Responder before scheduling
- **Timezone**: Cron expressions use the container's timezone (set via TZ environment variable)
- **Logging**: Check container logs (`docker logs meshmonitor`) to monitor timer execution
- **Channel Selection**: Choose appropriate channels for scheduled content

### Troubleshooting

**Timer Not Running**:
- Verify the timer is enabled (green "ENABLED" badge)
- Check the cron expression with [crontab.guru](https://crontab.guru/)
- Ensure changes were saved (click "Save" in header)
- Check container logs for errors

**Script Errors**:
- Verify script exists in `/data/scripts/`
- Ensure script has execute permissions (`chmod +x`)
- Check script outputs valid JSON format
- Review container logs for execution errors

**Messages Not Appearing**:
- Verify the selected channel is correct
- Check that the script returns a `response` field
- Ensure response text is under 200 characters

## Configuration Storage

All automation settings are stored on the MeshMonitor server and persist across container restarts and browser sessions. Changes made by any user with appropriate permissions will affect all users accessing the system.

## Permissions

Modifying automation settings requires appropriate user permissions. Regular users may view automation status but cannot change settings without admin privileges.

## Related Documentation

- [Settings](/features/settings) - Learn about general MeshMonitor settings
- [Device Configuration](/features/device) - Configure your Meshtastic device
- [Production Deployment](/configuration/production) - Best practices for production environments
