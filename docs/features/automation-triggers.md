# Timer and Geofence Triggers

Timer Triggers send a message or run a script on a cron schedule. Geofence Triggers act when a node enters, leaves or stays inside an area. Both are [built-in automations](/features/automation) set up per source in the **Automation** view.

::: tip Prefer the Automation Engine
The [Automation Engine](/features/automation-engine) does both, across every source, with conditions and notifications:

- **On a schedule** trigger: live cron, start and end times, and a time zone. See [Schedule trigger](/features/automation-engine-reference#schedule-trigger-live-cron). The **Timed Announcement** template sets one up for you.
- **A node enters/leaves a region** trigger: draw a circle or polygon, or anchor a circle to a waypoint, and send Apprise notifications. See [Geofence trigger](/features/automation-engine-reference#geofence-trigger).

There is no converter for existing timers or geofences; rebuild them in the Engine by hand.
:::

## Timer Triggers (Timed Events) {#timer-triggers}

::: tip Use the Automation Engine instead
An Engine **On a schedule** trigger takes a 5-field cron expression (every 5 minutes at most) and can add conditions, notifications and scripts. See [Schedule trigger](/features/automation-engine-reference#schedule-trigger-live-cron).
:::

Schedule scripts to run automatically at specified times using cron expressions. This feature allows you to automate recurring tasks like sending daily status updates, weather reports, or network statistics to your mesh network.

### How It Works

Timer Triggers run on a schedule defined by cron expressions. A timer either sends a fixed **Text Message** or runs a **Script** from `/data/scripts/` and sends its output. The output goes to the channel you pick, or nowhere when the channel is set to **None (no mesh output)** for a script that handles its own output.

### Configuration

**Adding a Timer**:
1. Open the source's **Automation** tab
2. Scroll to the "Timer Triggers" section
3. Fill out the timer configuration:
   - **Name**: A descriptive name for your timer (e.g., "Daily Weather Report")
   - **Schedule**: A cron expression defining when to run
   - **Type**: Text Message or Script
   - **Message** or **Script**: The text to send, or a script from `/data/scripts/`
   - **Channel**: The channel to send the output to
4. Click "Add Timer"
5. Click "Save" to persist your changes

**Timer Properties**:

Each timer has:
- **Name**: Human-readable identifier for the timer
- **Cron Expression**: Standard 5-field cron format (minute hour day month weekday)
- **Script**: Path to the script in `/data/scripts/`
- **Channels**: One or more channels (0-7) that get the output. Meshtastic sends to each selected channel through the source's outgoing queue, spaced by the normal send gap. A MeshCore timer sends to at most **4 channels**, each a separate flood **10 seconds apart**; MeshMonitor skips extra channels and logs a warning. Pick at least one channel, or **None** for a script that handles its own output.
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

Timer scripts follow the same rules as Auto Responder scripts: they live in `/data/scripts/`, use a `.js`, `.mjs`, `.py` or `.sh` extension, print JSON with a `response` or `responses` field, and finish within 30 seconds. The optional **Arguments** field takes tokens such as `{IP}` and `{NODECOUNT}`.

### Script Arguments (Timer Triggers)

The timer token list, environment variables and an example are in [Writing automation scripts: Timer Triggers](/developers/auto-responder-scripting#timer-trigger-scripts).

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

### Managing Timers

**Enable/Disable**: Click the "Enable" or "Disable" button on any timer to toggle its active state without removing it.

**Edit Timer**: Click "Edit" to modify any timer property, then "Save" to apply changes.

**Remove Timer**: Click "Remove" and confirm to delete a timer.

**Save Changes**: After adding, editing, or removing timers, click the "Save" button in the header to persist changes.

### Side Effects

- **Network Traffic**: Each timer execution sends messages to the mesh network
- **Airtime Usage**: Timer outputs consume LoRa airtime
- **Script Execution**: Scripts run in the container with 30-second timeout
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

## Geofence Triggers {#geofence-triggers}

::: tip Use the Automation Engine instead
The Engine's **A node enters/leaves a region** trigger draws circle or polygon fences on the same map editor, or anchors one to a waypoint, and can send Apprise notifications. See [Geofence trigger](/features/automation-engine-reference#geofence-trigger).
:::

Trigger automated actions when nodes enter, exit, or remain inside defined geographic areas. This powerful feature enables location-based automation such as arrival notifications, area monitoring, or proximity alerts.

### How It Works

Geofence Triggers monitor node positions and compare them against defined geographic boundaries. When a node's position matches a trigger condition (entering, exiting, or remaining inside a zone), MeshMonitor automatically executes the configured response.

### Quick Start {#geofence-quick-start}

A trigger holds its own region; there is no separate list of geofences.

1. Open the source's **Automation** view and scroll to **Geofence Triggers**.
2. Name the trigger.
3. Pick **Circle** or **Polygon**. For a circle, click the map to place the centre, then set the radius. For a polygon, click to add each corner and double-click to finish.
4. Choose the event: **Entry**, **Exit**, or **While Inside**. For **While Inside**, set the interval in minutes (1 to 1440).
5. Choose which nodes it applies to: **All Nodes** or **Selected Nodes**.
6. Pick the action type: **Text Message** (with tokens such as `{LONG_NAME}` and `{GEOFENCE_NAME}`) or **Script**.
7. Pick the channel: a channel, **Direct Message**, or (scripts only) **None (no mesh output)**.
8. Optional: set **Cooldown (minutes)** per node so a node on the fence line does not fire over and over. `0` means no cooldown.
9. Click **Add Geofence Trigger**, then **Save**.

| Scenario | Setup |
| --- | --- |
| "Kid got home" | Selected-node Entry trigger on the home fence → direct message, or an Engine rule → notification |
| Asset tracking | All-nodes Entry and Exit triggers on the warehouse fence → channel message |
| Event perimeter | While Inside trigger (5 min) on the event fence → channel message |
| Safety zone | Engine rule: node leaves the coverage region → Apprise to on-call |

### Configuration

**Adding a Geofence Trigger**:

1. Open the source's **Automation** tab
2. Scroll to the "Geofence Triggers" section
3. Fill out the trigger configuration:
   - **Name**: A descriptive name for the trigger (e.g., "Base Camp Entry Alert")
   - **Shape**: Circle or polygon defining the geographic boundary
   - **Event**: When to trigger (entry, exit, or while inside)
   - **Node Filter**: Which nodes to monitor (all or selected)
   - **Response Type**: Text message or script
   - **Channel**: Where to send the response (channel or direct message)
4. Click "Add Geofence Trigger"
5. Click "Save" to persist your changes

### Geofence Shapes

**Circle**: Define a circular area by clicking on the map to set the center point and dragging to set the radius.

- Displays radius in kilometers
- Good for simple proximity monitoring
- Easy to visualize and adjust

**Polygon**: Define a custom-shaped area by clicking multiple points on the map to create vertices.

- Supports complex boundary shapes
- Useful for irregular areas like property boundaries
- Click points to add vertices, close the polygon to complete

The interactive map editor shows your current nodes with position data, making it easy to draw zones around specific locations.

### Trigger Events

**Entry**: Fires when a node enters the geofence zone.
- Triggers once when position changes from outside to inside
- Useful for arrival notifications

**Exit**: Fires when a node leaves the geofence zone.
- Triggers once when position changes from inside to outside
- Useful for departure alerts

**While Inside**: Fires periodically while a node remains inside the zone.
- Configurable interval (in minutes)
- Useful for ongoing presence monitoring
- Example: Send status update every 5 minutes while node is in area

### Node Filtering

**All Nodes**: Monitor all nodes with position data.
- Any node entering/exiting the zone triggers the action

**Selected Nodes**: Monitor only specific nodes.
- Choose which nodes to track from the node selector
- Filter by node name or ID
- Useful for monitoring specific assets or people

### Response Types

**Text Message**: Send a customizable message with dynamic tokens.

Available tokens:
- `{GEOFENCE_NAME}` - Name of the geofence trigger
- `{EVENT}` - Event type (entry/exit/while_inside)
- `{LONG_NAME}` - Node's long name
- `{SHORT_NAME}` - Node's short name
- `{NODE_ID}` - Node's ID (e.g., !a1b2c3d4)
- `{NODE_LAT}` - Node's latitude
- `{NODE_LON}` - Node's longitude
- `{DISTANCE_TO_CENTER}` - Distance to geofence center in kilometers
- `{VERSION}` - MeshMonitor version
- `{NODECOUNT}` - Total active nodes

**Example Messages**:
```
{LONG_NAME} entered {GEOFENCE_NAME}
```
```
Alert: {SHORT_NAME} has left the monitored area
```
```
{LONG_NAME} is {DISTANCE_TO_CENTER}km from base camp
```

**Script Response**: run your own script from `/data/scripts/`. It gets the geofence and node details as environment variables, has the same 30-second limit as Auto Responder scripts, and takes optional **Arguments** with tokens such as `{NODE_ID}`. A common use is `remote-admin.py --dest {NODE_ID} --reboot` to reboot a node when it enters a fence.

### Script Arguments (Geofence Triggers)

The geofence token list, environment variables and example configurations are in [Writing automation scripts: Geofence Triggers](/developers/auto-responder-scripting#geofence-trigger-scripts).

### Output Channel

**Direct Message**: Send the response directly to the triggering node.
- Private notification to the node owner
- Good for personal alerts

**Channel**: Send the response to a specific channel.
- Public notification visible to channel members
- Good for team/group awareness

### Managing Triggers

**Enable/Disable**: Toggle individual triggers without removing them.
- Disabled triggers show reduced opacity
- Quick way to temporarily pause monitoring

**Edit**: Modify any trigger property.
- Click "Edit" to load trigger into the form
- Make changes and click "Save Changes"
- Click "Cancel" to discard changes

**Remove**: Delete a trigger permanently.
- Confirmation dialog prevents accidental deletion

**Status Display**: Each trigger shows:
- Shape type and size (e.g., "Circle (2.5 km)")
- Event type
- Response preview
- Node filter status
- Last run time and result (if applicable)

### Side Effects

- **Position Monitoring**: Requires nodes to broadcast position data
- **Processing Overhead**: Each position update is checked against all active triggers
- **Network Traffic**: Text responses consume airtime on the mesh
- **Script Execution**: Scripts run in the container with timeout limits

### Use Cases

**Arrival/Departure Notifications**:
- Alert when family members arrive home
- Notify team when assets reach destination
- Track vehicle entry/exit from facilities

**Area Monitoring**:
- Monitor restricted areas for unauthorized access
- Track node presence in work zones
- Event perimeter monitoring

**Proximity Alerts**:
- Warn when nodes approach hazardous areas
- Notify when nodes leave safe zones
- Distance-based status updates

**Asset Tracking**:
- Confirm delivery arrivals
- Monitor equipment location
- Track personnel in field operations

### Best Practices

**Zone Design**:
- Use appropriate buffer zones to avoid edge-case triggers
- Consider GPS accuracy when sizing zones
- Test triggers with actual node movement

**Performance**:
- Limit number of active triggers for better performance
- Use node filtering when monitoring specific assets
- Choose appropriate "while inside" intervals

**Notifications**:
- Keep messages concise for radio efficiency
- Include relevant context (node name, location)
- Consider privacy when using public channels

### Troubleshooting

**Trigger Not Firing**:
- Verify node has recent position data
- Check that node filter includes the target node
- Ensure trigger is enabled
- Verify geofence zone covers the expected area

**False Triggers**:
- GPS accuracy may cause edge-case triggers
- Increase zone size to add buffer
- Consider using "while inside" instead of entry/exit for stationary monitoring

**Messages Not Sending**:
- Check response text is under 200 characters
- Verify channel selection is correct
- Check for script errors in container logs
