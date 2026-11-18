# Mesh Upkeep Automations

These [built-in automations](/features/automation) look after the mesh: they trace routes, poll remote nodes, ping, sync clocks, repair keys, and keep the node list tidy. Set them up per source in the **Automation** view (MeshCore: **Automations**).

Most have no full [Automation Engine](/features/automation-engine) equivalent, so use them as they are. The Engine can do parts of the job:

| Built-in | In the Automation Engine |
|---|---|
| [Auto Favorite](#auto-favorite), [Ignored Nodes](#ignored-nodes), [Auto Delete by Distance](#auto-delete-by-distance) | Partial: the **Manage the node** action favorites, ignores or deletes the node that fired the rule, and the **Distance from a point** condition can test how far away it is. The Engine does not sweep all nodes on a schedule. |
| [Auto Traceroute](#auto-traceroute), [Auto Remote LocalStats](#auto-remote-localstats) | Partial: the **Request data from a node** action asks one node for a traceroute or telemetry. The built-ins pick targets and pace requests for you. |
| [Auto Time Sync](#auto-time-sync) | Partial (MeshCore): the **A MeshCore node’s clock is out of sync** trigger alerts you, but does not set the clock. |
| [Auto Ping](#auto-ping), [Auto Heap Management](#auto-heap-management), [Remote Admin Scanner](#remote-admin-scanner), [Auto Key Management](#auto-key-management) | None. |

On Meshtastic sources, Auto Traceroute, Auto Remote LocalStats, Auto Ping, Remote Admin Scanner, Auto Time Sync and Auto Key Management pause while the [airtime cutoff](/features/automation#airtime-cutoff) is active. Automation Engine rules hold back their sends on that source too ([details](/features/automation-engine-reference#airtime-cutoff)).

## Auto Favorite {#auto-favorite}

Automatically favorite nodes that are actively communicating with your mesh, ensuring important nodes are always pinned to the top of your node list without manual intervention.

### How It Works

When enabled, MeshMonitor monitors incoming NodeInfo packets and automatically favorites nodes that meet eligibility criteria based on your local node's role. A periodic sweep runs every 60 minutes to unfavorite stale nodes that haven't been heard from within the configured staleness window.

### Manual vs Auto Favorites

MeshMonitor distinguishes between **manual** and **auto-managed** favorites using a lock mechanism:

| Action | Favorite | Locked | Meaning |
|--------|----------|--------|---------|
| Manual favorite (click star) | Yes | Yes | Protected from automation |
| Manual unfavorite (click star) | No | Yes | Won't be re-auto-favorited |
| Auto-favorite (automation) | Yes | No | Can be swept when stale |
| Auto-sweep unfavorite | No | No | Available for re-auto-favorite |

**Key behavior:**
- Automation **never** changes manually locked favorites
- The lock icon (🔒/🔓) appears as a small subscript on the favorite star
- Click the lock to promote an auto-favorite to manual (locked), or release a manual favorite to automation (unlocked)

### Configuration

Open the source's **Automation** tab and find the **Auto Favorite** section.

| Setting | Description | Default |
|---------|-------------|---------|
| Enable Auto Favorite | Toggle the feature on/off | Off |
| Stale Hours | Hours since last heard before a node is considered stale and unfavorited (1 to 720) | 72 |
| Exclude likely aircraft | Never auto-favorite a node flagged by [likely-aircraft detection](/features/settings#likely-aircraft-detection); remove one that was already auto-favorited before it got flagged | On |

### Eligibility Rules

Auto-favorite only runs at all when your **local node's role** is `Router`, `Router_Late`, or `Client_Base`. On any other local role (`Client`, `Client_Mute`, etc.) the feature stays inactive.

When active, it only auto-favorites a **target node** that is a **0-hop neighbor** (`hopsAway = 0`) whose own role is a **relay role**:

| Target Node Role | Auto-Favorited? |
|------------------|-----------------|
| Router | Yes (relay role) |
| Router_Late | Yes (relay role) |
| Client_Base | Yes (relay role) |
| Client | **Never** (does not relay) |
| Client_Mute | **Never** (does not relay) |

`Client` and `Client_Mute` nodes never relay traffic, so they are **never** auto-favorited regardless of your local node's role (issue #3774).

Targets must also:
- Be exactly 0 hops away (`hopsAway = 0`) — direct RF neighbors only
- Not have been heard via MQTT
- Not already be favorited
- Not have `favoriteLocked = true` (manually managed)

> **Tip:** On a `Client_Base` local node, nearby `Client` / `Client_Mute` devices are intentionally skipped by auto-favorite. If you want those pinned, favorite them **manually** by clicking the star.

### Excluding Likely Aircraft

The **Exclude likely aircraft** switch, on by default, keeps [likely-aircraft detection](/features/settings#likely-aircraft-detection) and Auto Favorite from fighting each other:

- A node currently flagged as a likely aircraft is never auto-favorited, even if it otherwise meets the eligibility rules above.
- The exclusion only does anything while **both** the switch and likely-aircraft detection are on for this source. If detection is off, the switch is shown disabled with a link back to **Settings → Node Display** to turn it on.
- A node that was auto-favorited *before* it got flagged (for example, heard once at altitude before its NodeInfo arrived) is removed once it has been seen flagged at **two consecutive hourly sweeps at least 45 minutes apart**. One flagged sweep alone is not enough — this protects against a single bad GPS altitude reading. The 45-minute gap also keeps a quick restart or reconnect from being mistaken for a second sweep.
- Manual (locked) favorites and a user's own favorites are never touched by this exclusion, exactly like the rest of Auto Favorite's sweep.

### Permissions

- Viewing auto-favorite status requires `settings:read` permission
- Modifying auto-favorite settings requires `settings:write` permission
- Toggling favorite lock requires `nodes:write` permission

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Manually favorited node was unfavorited | Check if the lock icon shows unlocked — click it to lock |
| Node keeps getting re-favorited after manual unfavorite | Should not happen — manual unfavorite sets lock. Check if another user unlocked it |
| Auto-favorite not triggering | Verify feature is enabled and node meets eligibility criteria for your role |

---

## Auto Traceroute {#auto-traceroute}

Automatically sends traceroute requests to all active nodes at a configured interval to maintain up-to-date network topology information.

### How It Works

When enabled, MeshMonitor periodically sends traceroute requests to all nodes in the active node list. Traceroutes reveal the path messages take through the mesh network, showing which nodes relay traffic between the source and destination.

Each request goes out at your node's own **hop limit** (**Device Configuration → LoRa → Hop Limit**), the same reach as the node's text messages. A node further out than that cannot be traced; raise the device hop limit if you need to reach it, bearing in mind that it widens every message the node sends.

### Configuration

**Enable/Disable**: Toggle the checkbox next to "Auto Traceroute". Auto Traceroute is **off by default** on every source. It sends nothing until you turn it on and save.

**Traceroute Interval**: How often to send a traceroute. Each run traces one node.

- **Range**: 3-60 minutes
- **Default**: off. When you turn it on, the box starts at 15 minutes.
- **Recommendation**: 15-30 minutes suits most meshes. Use 30-60 minutes on large meshes or slow presets. Go below 10 minutes only on a small, quiet mesh.

**Saves and restarts keep the interval.** MeshMonitor stores the time of each source's last auto traceroute. Saving the Auto Traceroute section, a reconnect to the node, or a MeshMonitor restart never sends a traceroute sooner than one interval after the last one:

- A save that keeps the same interval (for example, a filter change) leaves the schedule alone.
- A save with a new interval counts from the last traceroute: shorten 10 minutes to 5, and the next one goes out 5 minutes after the last.
- On the first start, or when the last traceroute is more than one interval old, the first run waits a random delay of up to 5 minutes (or the interval, if shorter), so several instances don't all send at once.

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
- **No Restart Needed**: Changes take effect when you save, and keep the interval as described above

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

## Auto Remote LocalStats {#auto-remote-localstats}

<a id="auto-localstats"></a>

::: tip New in 4.10
:::

Periodically requests `local_stats` telemetry — **noise floor, channel/air utilization, uptime, and packet counts** — from *remote* nodes, so you can graph the health of infrastructure you don't physically own. Replies persist through the normal telemetry pipeline and appear on the same charts as your own device metrics.

### How It Works

A round-robin scheduler polls **one least-recently-polled target per tick**, so the load is spread out over time rather than fired in a burst. Each request is sent as a **unicast on the target's channel** (using the shared channel PSK), not as a PKI direct message. This is deliberate:

- A unicast bypasses the firmware's multi-hop-broadcast role gate, so `REPEATER` and `CLIENT` nodes will answer (a broadcast request would be ignored by exactly the infrastructure nodes you most want to monitor).
- Channel routing uses the shared PSK, which avoids the stale-key fragility of a PKI DM when keys don't line up.

`hop_limit` is sized to each target's observed distance, the explicit `local_stats` telemetry variant is requested (the firmware echoes the requested variant), and the scheduler is **passive-mode aware** — it stops transmitting when MeshMonitor is in passive mode.

### Configuration

Navigate to **Automation → Auto Remote LocalStats**.

**Enable/Disable**: Toggle the checkbox next to "Auto Remote LocalStats"

**Interval**: How often the scheduler ticks (applied live, no restart needed).

**Saves and restarts keep the interval.** MeshMonitor stores the time of each source's last request. Saving this section, a reconnect to the node, or a MeshMonitor restart never sends a request sooner than one interval after the last one:

- A save that keeps the same interval (for example, a filter change) leaves the schedule alone.
- A save with a new interval counts from the last request: shorten 30 minutes to 10, and the next one goes out 10 minutes after the last.
- On the first start, or when the last request is more than one interval old, the first run waits a random delay of up to 5 minutes, so several instances don't all send at once.

**Target filters** — targets are the **union** of every enabled filter, so a node matching any one is polled:

- **Node list** — an explicit set of nodes.
- **Role** — e.g. all `REPEATER`/`ROUTER` nodes.
- **Favorites** — every node flagged as a favorite.
- **Name regex** — match nodes by a regular expression over their name.

Built-in guards keep it polite to the mesh: per-tick **jitter**, a **schedule window**, an **airtime gate**, and a **minimum-interval rate limit** per target.

The airtime gate is the source-wide [Cutoff Airtime Utilization Threshold](/features/automation#airtime-cutoff). Set the threshold and where it reads Channel Utilization there.

### Side Effects

- **Airtime Usage**: each request and reply consumes LoRa airtime; the airtime gate and round-robin pacing keep this bounded.
- **Network Congestion**: remote nodes relay the request and their reply across the mesh — prefer longer intervals on large networks.
- **Battery Impact**: polled nodes transmit a reply, increasing their power use.

### Use Cases

- Watching channel utilization on a key repeater two hops away.
- Graphing noise floor across your infrastructure to spot rising interference.
- Tracking uptime/packet counts of nodes you don't have physical access to.

### Best Practices

- Start with **role** or **favorites** filters rather than polling every node.
- Use longer intervals on dense meshes; the per-target rate limit prevents hammering any one node.
- Pair with [Noise Floor telemetry](/features/telemetry-widgets) to chart remote interference over time.

## Auto Ping {#auto-ping}

Allows mesh users to trigger automated ping sessions via direct message commands. This is useful for testing link quality, measuring round-trip times, and verifying connectivity to the MeshMonitor node over time.

### How It Works

When enabled, mesh users can send a direct message to the MeshMonitor node with the command `ping N` (where N is the number of pings). MeshMonitor then sends N pings back to the requesting node at the configured interval, tracking ACK/NAK/timeout results for each ping. After all pings complete (or the user cancels), MeshMonitor sends a summary DM with the results.

Pings use Meshtastic's `NODEINFO_APP` request with `wantResponse: true`, which is the standard Meshtastic ping mechanism — the target must respond with an ACK and NodeInfo, giving round-trip confirmation.

### DM Commands

| Command | Description |
|---------|-------------|
| `ping N` | Start N pings to the MeshMonitor node (N is capped at the configured maximum) |
| `ping stop` | Cancel an active ping session |

**Examples**:
- Send `ping 5` as a DM to start 5 pings at the configured interval
- Send `ping stop` to cancel an active session before it completes

### Configuration

Open the source's **Automation** tab and find the **Auto Ping** section.

**Enable/Disable**: Toggle the checkbox next to "Auto Ping"

| Setting | Description | Default | Range |
|---------|-------------|---------|-------|
| **Enable** | Turn auto-ping on or off | Off | — |
| **Ping Interval** | Time between each ping in a session (seconds) | 30 | 10–300 |
| **Max Pings Per Session** | Maximum number of pings a user can request in a single session | 20 | 1–100 |
| **Ping Timeout** | How long to wait for a response before marking a ping as timed out (seconds) | 60 | 10–300 |

### Active Sessions

The Auto Ping settings panel displays a live table of active ping sessions, showing:

- **Requested By**: The node that initiated the ping session
- **Progress**: How many pings have completed out of the total (e.g., 3/5)
- **Successful**: Number of pings that received an ACK
- **Failed**: Number of pings that received a NAK or timed out
- **Elapsed**: Time since the session started
- **Stop**: Button to force-stop a session from the UI

Sessions update in real-time via WebSocket events. Admins can force-stop any active session from the UI.

### Session Lifecycle

1. A mesh user sends `ping 5` as a DM to MeshMonitor
2. MeshMonitor confirms: "Starting 5 pings every 30s..."
3. After one full interval, the first ping is sent
4. Each ping waits for an ACK, NAK, or timeout before the next interval
5. After all pings complete, MeshMonitor sends a summary DM: "Auto-ping complete: 4/5 successful (80%)"
6. If the user sends `ping stop` during a session, the session is cancelled and a partial summary is sent

### Side Effects

- **Network Traffic**: Each ping generates a NODEINFO request and expects a response, using mesh airtime
- **One Session Per User**: Each node can only have one active ping session at a time
- **DM Only**: Auto-ping commands are only processed when received as direct messages
- **Command Priority**: Auto-ping commands are processed before Auto Responder triggers, so `ping` patterns in Auto Responder won't conflict

### Use Cases

- **Link Quality Testing**: Measure packet delivery rates between a remote node and MeshMonitor over time
- **Latency Measurement**: Track round-trip times across multiple pings to assess network performance
- **Connectivity Verification**: Confirm that a node can reliably reach MeshMonitor through the mesh
- **Troubleshooting**: Diagnose intermittent connectivity issues with repeated ping tests

### Best Practices

- **Interval Selection**: Use the default 30-second interval for most cases; shorter intervals increase airtime usage
- **Ping Count**: Start with 5–10 pings for quick tests; use higher counts (20+) for sustained reliability testing
- **Timeout**: The default 60-second timeout is generous enough for multi-hop networks; reduce it for direct connections
- **Max Pings**: Set the maximum to a reasonable value (20–50) to prevent excessive network usage from long sessions

### MeshCore Companion Sources {#auto-ping-meshcore}

A MeshCore **Companion** source has its own Auto Ping section on the MeshCore page's **Automations** view. It is built for coverage and route tests: carry a mobile companion around, DM `ping N` to a base companion that MeshMonitor manages, and the base pings you back while you move.

**Companion sources only.** The section does not show on a Repeater source, and a Repeater ignores `ping`. The feature was requested for companion-to-companion tests, so Repeater support is out of scope.

It works like the Meshtastic version, with these differences:

- **Each ping is a short DM**, such as `Ping 3/20`. A MeshCore DM has no NodeInfo request, so the round trip comes from the DM's own ACK: the radio reports the ACK's trip time, and MeshMonitor records it as the ping's RTT.
- **One attempt per ping.** A normal MeshCore DM is resent up to three times, and the last try resets the path and floods. A ping is never resent, so each result is one real try, and a ping never changes the route you are testing.
- **Direct or flood.** Each ping records whether it went **direct** (the contact had a known path when the ping was sent) or by **flood** (no known path). A flood ACK can teach the radio a path part-way through a session, so later pings may show as direct.
- **Timeout.** A ping times out after the **Ping Timeout** setting, or after the radio's own suggested wait when that is longer.
- **No NAK.** MeshCore reports no delivery failure, so a ping is either ACKed or timed out.
- **Summary.** The summary DM matches the Meshtastic one and adds the direct and flood counts, for example:

  ```
  Auto-ping done: 18/20 ok
  Min/Avg/Max: 812/1450/3020ms
  Timeouts: 2
  Direct: 15 Flood: 5
  ```

- **Active sessions** show a **Direct / Flood** column, and the table refreshes every 5 seconds while a session runs.

The settings, defaults and ranges are the same as on Meshtastic, saved per source. Saving the settings never starts or restarts a session. Sessions live in memory: a disconnect or a restart ends them, and they do not resume.

**Airtime.** Each ping is a DM plus its ACK, so a 20-ping session puts about 40 packets on the air. With no known path both are flooded, and every repeater in range sends them again.

**Loops.** Auto-Acknowledge and the Auto-Responder never answer an Auto Ping DM (the pings, the start reply or the summary), and a `ping N` from one of MeshMonitor's own nodes is ignored, so two MeshMonitor companions cannot ping each other in a loop. As on Meshtastic, a `ping N` command skips the Auto-Responder, but Auto-Acknowledge can still answer the command itself if its pattern matches.

### Troubleshooting

**"ping 5" not working**:
- Verify Auto Ping is enabled in the Automation settings
- Ensure the command is sent as a direct message (not on a channel)
- Check that the number doesn't exceed the configured maximum

**All pings timing out**:
- The target node may be out of range or unreachable
- Check mesh connectivity to the MeshMonitor node
- Try increasing the timeout value

**Session not appearing in UI**:
- Refresh the browser page
- Verify you have `automation` read permission on the source, which the Automation tab needs, and `settings` read for the Auto Ping panel

### Permissions

- **UI Settings**: Requires `settings:read` to view, `settings:write` to modify configuration or force-stop sessions
- **DM Commands**: Any mesh user can trigger a ping session (feature gated by the `autoPingEnabled` setting)

## Auto Heap Management {#auto-heap-management}

Automatically protects low-memory Meshtastic nodes from running out of heap by purging stale nodes and rebooting the device when free memory drops below a configurable threshold.

When enabled, MeshMonitor watches the `heapFreeBytes` value in LocalStats telemetry. If free heap falls below your configured threshold, it removes the 10 least-recently-heard nodes from the device database and triggers a reboot (~10 seconds disconnect, then automatic reconnect). A 30-minute cooldown prevents repeated triggers.

Most useful on nodes running MQTT, networking, and telemetry with 100+ nodes in the database — especially on LoRa32, T-Beam, and RAK4631 hardware.

See the full [Auto Heap Management](/features/auto-heap-management) documentation for configuration details, threshold recommendations, target hardware, and FAQ.

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
- Check that nodes are "active" (heard within the configured maxNodeAgeHours). When the node window is 0 (show all nodes), the scanner, Auto-Traceroute and remote LocalStats use the **Transmit target window** setting instead (default 24 hours)
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

## Auto Time Sync {#auto-time-sync}

Automatically synchronizes the MeshMonitor server's clock to nodes in your mesh network that support remote administration. This keeps node clocks accurate, which is important for proper message ordering and timestamp display.

### How It Works

When enabled, MeshMonitor periodically selects one eligible node that needs a time sync and sends it a **Set Time** admin command with the server's current time. The scheduler processes one node per interval tick, cycling through all eligible nodes over time.

A node is eligible for time sync if:
- It has been discovered by the [Remote Admin Scanner](#remote-admin-scanner) (has remote admin capability), **or** it is the local node
- Its last time sync is older than the configured **expiration** period (or it has never been synced)
- Optionally, it is included in the node filter list (when filtering is enabled)

### Configuration

Open the source's **Automation** tab and find the **Auto Time Sync** section.

| Setting | Description | Default | Range |
|---------|-------------|---------|-------|
| **Enable** | Turn auto time sync on or off | Off | - |
| **Interval** | How often to sync the next eligible node (in minutes) | 15 | 15 - 1440 |
| **Expiration** | How many hours before a previously synced node becomes eligible again | 24 | 1 - 24 |
| **Filter to specific nodes** | When enabled, only sync nodes in the selected list | Off | - |

### Node Filter

When the node filter is enabled, you can select which specific nodes should receive time syncs. The node list shows only nodes with remote admin capability. Use the **Select All** / **Deselect All** buttons and the search field to manage the list.

When the filter is disabled (default), all eligible nodes are included automatically.

### Prerequisites

- **Remote Admin Scanner** must be enabled and must have discovered nodes with remote admin capability before Auto Time Sync can target them
- MeshMonitor must be connected to a Meshtastic node

### Use Cases

- **Keeping node clocks accurate** - Nodes without GPS or NTP may drift over time; periodic syncing corrects this
- **Consistent timestamps** - Ensures messages across the mesh have accurate, comparable timestamps
- **Automated maintenance** - Set it and forget it; the scheduler handles all nodes over time

### Best Practices

- The default interval is 15 minutes, the shortest allowed. One node is synced per tick, so on a small mesh a longer interval such as 60 minutes saves airtime
- Use a 24-hour expiration so each node gets synced roughly once per day
- If you have a large mesh, the scheduler will cycle through all nodes automatically — one per interval tick
- Use the node filter if you only want to sync specific nodes (e.g., solar-powered nodes that lose time on reboot)

### Related Documentation

- [Remote Admin Scanner](#remote-admin-scanner) - Required to discover nodes with remote admin capability
- [Admin Commands](/features/admin-commands) - Manual admin commands including Set Time

## Auto Key Management {#auto-key-management}

Automatically detects and repairs PKI (Public Key Infrastructure) key mismatches between nodes in your mesh network. Key mismatches can occur when a node's encryption key changes (e.g., after a factory reset or firmware update) but other nodes still have the old key cached. This prevents encrypted communication from working correctly.

### How It Works

When enabled, MeshMonitor periodically scans for nodes with key mismatches and attempts to repair them by exchanging node info. The exchange process forces nodes to share their current encryption keys, resolving stale key caches.

The repair process for each node with a key mismatch:

1. **Detect**: MeshMonitor identifies nodes whose cached public key doesn't match the key seen in recent packets
2. **Exchange**: Sends a node info exchange request to trigger a fresh key exchange
3. **Verify**: Waits for the exchange to complete and checks if the key mismatch is resolved
4. **Retry**: If still mismatched, retries up to the configured maximum number of exchanges
5. **Purge** (optional): If all exchanges fail and auto-purge is enabled, removes the node from the device database and sends one final exchange to re-establish the connection cleanly

### Configuration

Open the source's **Automation** tab and find the **Auto Key Management** section.

**Enable/Disable**: Toggle the checkbox next to "Auto Key Management"

| Setting | Description | Default | Range |
|---------|-------------|---------|-------|
| **Enable** | Turn auto key management on or off | Off | — |
| **Interval Between Attempts** | Time to wait between node info exchange attempts for each node (minutes) | 5 | 1–60 |
| **Maximum Exchange Attempts** | Number of node info exchanges to attempt before giving up on a node | 3 | 1–10 |
| **Auto-Purge After Exhausting Attempts** | If enabled, automatically remove the node from the device database after all exchange attempts fail, then send one final node info exchange | Off | — |

### Activity Log

The Auto Key Management panel includes a real-time activity log showing recent repair activity:

- **Time**: When the action occurred
- **Node**: The node name or ID
- **Action**: What was attempted
  - **Exchange**: A node info exchange was sent
  - **Fixed**: The key mismatch was resolved
  - **Exhausted**: All exchange attempts were used without resolving the mismatch
  - **Purge**: The node was removed from the device database (when auto-purge is enabled)
- **Status**: Success or failure indicator

The log refreshes automatically every 30 seconds.

### Side Effects

- **Network Traffic**: Each exchange attempt generates node info packets on the mesh
- **Auto-Purge Risk**: Enabling auto-purge will remove nodes from the device database if exchanges fail — the node will need to be re-discovered
- **Background Processing**: Runs on a timer; does not require user interaction after configuration

### Use Cases

- **Post-Firmware Update**: Repair key mismatches after nodes update their firmware and regenerate keys
- **Factory Reset Recovery**: Automatically handle key changes when nodes are factory-reset
- **Large Network Maintenance**: Keep encryption keys current across a large mesh without manual intervention
- **Security Hygiene**: Ensure all nodes can communicate securely with current keys

### Best Practices

- Start with the default 5-minute interval and 3 exchange attempts
- Enable auto-purge only if you're comfortable with nodes being temporarily removed and re-discovered
- Monitor the activity log after enabling to verify repairs are succeeding
- For more information about encryption keys and key mismatches, see [Duplicate Encryption Keys](/security-duplicate-keys)

### Related Documentation

- [Duplicate Encryption Keys](/security-duplicate-keys) - Understanding key mismatches and how to fix them manually
- [Security](/features/security) - Learn about node security and encryption

## Auto Delete by Distance {#auto-delete-by-distance}

Removes nodes that sit farther than a set distance from a home point. Use it to clear far-off nodes that reach your mesh through relays on aircraft.

1. Turn on **Enable Auto Delete by Distance**.
2. Set the **Home Coordinate**, or click **Use Current Node Position**.
3. Set the **Distance Threshold** (shown in your chosen distance unit) and the **Check Interval** in hours.
4. Choose the **Action**:
   - **Delete node** removes the node from MeshMonitor. It comes back if it keeps broadcasting.
   - **Ignore node** hides it and syncs the ignore to the device (firmware 2.7.0 or later). See [Ignored Nodes](#ignored-nodes).

**Run Now** runs a check at once. The **Activity Log** lists each run and how many nodes it removed.

Favorited nodes and your local node are never removed. MeshCore sources have a matching setting with the same Delete or Ignore choice.

## Ignored Nodes {#ignored-nodes}

Manages the persistent ignore list for nodes you want to exclude from your mesh monitoring. Ignored nodes are hidden from the node list and stay ignored permanently — whenever a listed node reappears without the ignore flag, MeshMonitor re-applies it automatically. This covers both inactive-node cleanup and the case where the device's own node database fills up and silently clears the ignore (see [#2601](https://github.com/Yeraze/meshmonitor/issues/2601)).

### How It Works

When you ignore a node (via the Node Details panel), MeshMonitor records it in a persistent ignore list. This section of the Automation tab shows all currently ignored nodes and allows you to manage the list.

Unlike simply hiding a node from the UI, the persistent ignore list ensures that:

- **Survival across cleanup**: If an inactive node is pruned from the database and later reappears, it will automatically be re-ignored
- **Survival across device churn**: Meshtastic devices hold a limited on-board ignore list; when their node database fills up they drop ignores and report the node as un-ignored. MeshMonitor treats its own list as authoritative and re-applies the ignore flag the next time the node is seen — both in its own database and on the locally-connected radio. The re-push to the radio is a local admin command (no destination), so it never generates mesh traffic; a short per-node cooldown prevents command storms if a device cannot durably hold the ignore
- **Consistent filtering**: Ignored nodes are hidden from the main Node List, advanced filters, and Admin Commands by default
- **Network transparency**: Ignoring a node is purely a UI action — it does not affect message delivery or mesh network functionality

### Viewing Ignored Nodes

The Ignored Nodes panel displays:

- **Total Count**: A summary showing how many nodes are currently ignored
- **Node Table**: A detailed table with columns:
  - **Node ID**: The hex ID of the ignored node (e.g., `!a1b2c3d4`)
  - **Long Name**: The node's long name (if known)
  - **Short Name**: The node's short name (if known)
  - **Ignored At**: When the node was added to the ignore list
  - **Actions**: Un-ignore button to remove the node from the list

### How to Ignore a Node

1. Select a node in the Node List to open its details
2. In the Node Details panel, click the **Ignore Node** button
3. The node will be added to the persistent ignore list and hidden from the Node List

### How to Un-ignore a Node

**From the Automation tab**:
1. Open the source's **Automation** tab and find **Ignored Nodes**
2. Find the node in the table
3. Click the **Un-ignore** button

**From the Node List**:
1. Enable "Show ignored nodes" in the Node List filter panel (🚫 icon)
2. Find the ignored node in the list and select it
3. In the Node Details panel, click the **Un-ignore Node** button

### Use Cases

- **Noise Reduction**: Hide spammy or malfunctioning nodes that clutter your node list
- **Network Focus**: Narrow monitoring to only the nodes you care about
- **Persistent Exclusion**: Ensure problematic nodes stay hidden even after database cleanup cycles
- **Temporary Suppression**: Hide nodes during troubleshooting, then un-ignore them later

### Permissions

- Viewing the ignored nodes list requires `settings:read` permission
- Ignoring or un-ignoring nodes requires appropriate admin permissions

### Related Documentation

- [Settings - Ignored Nodes Filter](/features/settings#ignored-nodes-filter) - UI filtering for ignored nodes in the Node List
- [Admin Commands](/features/admin-commands) - Managing nodes through admin commands

## Automatic Favorites Management (Remote) {#remote-favorites}

Keeps the favorites list up to date **on a remote infrastructure node you administer** — preserving Meshtastic's zero-hop cost between favorited routers as your mesh grows, without site visits or blind CLI spamming.

This is distinct from [Auto Favorite](#auto-favorite) above: that feature manages favorites on *your own* locally-connected node. Automatic Favorites Management runs over [Remote Admin](#remote-admin-scanner) and manages the favorites list on *another* node — typically a router or base station two hops away that you can't easily reach.

You configure it per target node in the **Automatic Favorites** section of **Admin Commands** (select the target node, then scroll to the section).

### How It Works

Each enabled target runs a "cycle" no more often than its configured interval (default 24 hours). A cycle:

1. **Discovers the target's direct neighbors** from one or both sources:
   - **Use NeighborInfo** — the nodes the target reports in its NeighborInfo broadcasts.
   - **Use Traceroutes** — the nodes immediately adjacent to the target in any traceroute that passes through it.
2. **Filters** the candidates to the configured eligible roles (default Router / Router Late / Client Base — the roles that benefit from zero-hop favoriting). The controlling (local) node is eligible too if it shows up as a direct neighbor.
3. **Favorites** up to *Maximum new neighbors per cycle* newly-discovered nodes by sending `set-favorite` admin commands to the target, and **re-asserts** up to *Maximum re-favorite per cycle* previously-assigned favorites.

### Acknowledged, not blind

Favorite commands sent over Remote Admin request a response, so the target node returns a **routing ACK**. MeshMonitor captures it and shows the result per favorite:

- **✓ confirmed** — the target received, authorized, and processed the command.
- **⏱ no ack** — no acknowledgement arrived within the timeout (it may still have applied).
- **✕ &lt;error&gt;** — the target rejected the command (e.g. `ADMIN_BAD_SESSION_KEY`).

The same confirmation is shown as a toast on the manual **Set Favorite** / **Remove Favorite** buttons in Node Management.

> **Caveat:** an ACK confirms the *remote processed the request*. Historically, if the favorited node was not yet in the remote node's database, the firmware accepted and ACKed `set_favorite_node` but the favorite was a no-op there until that node was known. MeshMonitor now sends an `add_contact` admin message **before** `set_favorite_node` (#6153), built from the node's stored user data. The firmware's `addFromContact` creates the NodeDB entry and, for most device roles, sets the favorite flag in the same step — so MeshMonitor only sends the extra `set_favorite_node` follow-up when the target radio's role is `CLIENT_BASE` (which skips the flag in `addFromContact`) or when MeshMonitor does not know the target's role. For every other known role the `add_contact` alone sets the favorite, saving one admin packet. If MeshMonitor holds essentially no user data for the node, it skips `add_contact` and falls back to sending `set_favorite_node` alone. The **re-favorite** pass still exists to recover any favorites whose command was dropped or didn't stick.

### Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| Enable | Run discovery + favorite cycles for this target on the schedule below | Off |
| Use NeighborInfo | Discover neighbors from the target's NeighborInfo broadcasts (target must have the NeighborInfo module enabled) | On |
| Use Traceroutes | Discover neighbors from traceroutes that pass through the target | On |
| Cycle interval (hours) | How often to run a favorite cycle | 24 |
| Maximum neighbor age (hours) | Reuse an on-file NeighborInfo record newer than this instead of requesting a fresh one (0 = always request) | 24 |
| Maximum new neighbors per cycle | Cap on how many newly-discovered neighbors are favorited each cycle | 1 |
| Maximum re-favorite per cycle | How many previously-assigned favorites are re-asserted each cycle | 1 |
| Eligible neighbor roles | Which roles are favorited (multi-select) | Router, Router Late, Client Base |

A **Run Cycle Now** button triggers one cycle immediately for the selected target (useful for testing).

### Requirements

- **Remote Admin access** to the target node (a session passkey is negotiated automatically; see [Remote Admin Scanner](#remote-admin-scanner)).
- Local device firmware **≥ 2.7.0** (favorites support).
- For NeighborInfo discovery, the **NeighborInfo module must be enabled** on the target node.

### Side Effects

- **Heavy operation**: each favorite is multiple packets per transaction (including a session-passkey handshake) plus a wait for the ACK. Keep the per-cycle limits low and the interval long, and use it sparingly.
- **Airtime**: discovery requests and favorite commands use admin-channel airtime on the path to the target.

### Permissions

- Configuring Automatic Favorites Management requires **admin** access (**Admin Commands**).

---
