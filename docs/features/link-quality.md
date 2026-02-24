# Link Quality & Smart Hops

MeshMonitor provides two complementary graphs for understanding the health and routing behavior of your mesh network connections: **Link Quality** and **Smart Hops**. Both are available in the Messages tab telemetry view and can be pinned to the Dashboard.

## Link Quality

Link Quality is a real-time score from **0 to 10** that represents the reliability of communication with a node. It updates dynamically as messages are sent and received, giving you an at-a-glance view of connection health.

### Quality Scale

| Score | Rating | Description |
|-------|--------|-------------|
| 9-10 | Excellent | Optimal, consistent connection |
| 7-8 | Good | Reliable connection |
| 4-6 | Moderate | Adequate but may have intermittent issues |
| 1-3 | Poor | Unstable, frequent drops or high latency |
| 0 | Dead | Link is not functional |

### How It's Calculated

Link Quality starts with a base score derived from the hop count of the first message received from a node, then adjusts in real-time based on ongoing events:

- **Stable or improved routing** (+1): Message arrives with the same or fewer hops than before
- **Degraded routing** (-1): Message arrives with 2+ more hops than before
- **Failed traceroute** (-2): A traceroute request to the node times out
- **PKI/encryption error** (-5): Cryptographic validation failures indicate a serious link problem

The score is always clamped between 0 and 10.

### Chart Details

The Link Quality chart displays:

- A **blue line** showing quality over time
- A **colored fill area** underneath using a green-to-yellow-to-red gradient
- **Reference lines** at quality 3 (poor threshold) and 7 (good threshold)
- An **interactive tooltip** showing the exact timestamp, quality score, and descriptive label

The chart title shows the node name and current quality score (e.g., "NodeName - Link Quality (8/10)").

## Smart Hops

Smart Hops provides a historical view of how many hops your messages actually take to reach a node. Unlike the simple "hops away" count from NodeInfo (which is a single snapshot), Smart Hops analyzes routing patterns over time using a **rolling 24-hour window**.

### What It Shows

The chart displays three lines:

- **Min Hops** (green): The fewest hops seen in the rolling window
- **Avg Hops** (blue): The average hop count across all messages
- **Max Hops** (red): The most hops seen in the rolling window

### Why It Matters

Smart Hops reveals trends that a single hop count cannot:

- **Is routing degrading?** If min/max/avg are all climbing, the network path is getting worse
- **Is the path stable?** A narrow gap between min and max means consistent routing
- **Are there intermittent issues?** A wide spread between min and max suggests the network is finding different paths for each message, which may indicate an unstable relay node

### Chart Details

- Data points are generated at **15-minute intervals**, each representing statistics from the preceding 24-hour window
- **Gaps in data** (breaks longer than 1 hour) are shown as visual disconnections rather than interpolated lines, so you can see when no messages were exchanged
- A **legend** at the bottom identifies the three lines
- An **interactive tooltip** shows exact hop counts at each time point

## Viewing the Graphs

### Messages Tab

1. Navigate to the **Messages** tab
2. Select a node from the conversation list
3. Scroll down past the message history to the **Telemetry** section
4. Link Quality and Smart Hops graphs appear alongside other telemetry data (battery, voltage, etc.)

### Dashboard

Both graphs can be pinned to the Dashboard for at-a-glance monitoring:

1. In the Messages tab telemetry view, click the **star icon** on either graph
2. The graph will appear as a draggable widget on your **Dashboard**
3. Dashboard widgets include a drag handle for reordering and a remove button
4. All dashboard charts respect the global time range selector

## Settings

### Telemetry Visualization Hours

Controls how much historical data is displayed in the graphs.

- **Location**: Settings tab
- **Default**: 24 hours
- **Range**: 1 to 168 hours (7 days)

### Node Hops Calculation

Controls how the hop count is calculated for the node list display (separate from Smart Hops):

- **NodeInfo**: Uses the `hopsAway` field from the most recent NodeInfo packet
- **Traceroute**: Uses the route length from the most recent traceroute
- **Messages**: Uses the hop count from the most recent message

::: tip
Smart Hops always uses actual message hop counts regardless of this setting. The Node Hops Calculation setting only affects the hop count shown in the node list.
:::

## Data Sources

Both features use the `messageHops` telemetry type, which is calculated from each incoming mesh message as `hopStart - hopLimit`. This represents the actual number of relay hops the message traversed to reach your node.

Link Quality additionally factors in traceroute results and encryption error events to provide a more complete reliability picture.
