# Automation

MeshMonitor can act on its own: answer messages, send on a schedule, trace routes, repair keys and tidy the node list. There are two ways to set this up.

## Which one should I use? {#which-one}

**Use the [Automation Engine](/features/automation-engine) for anything new.** It is where MeshMonitor automation is heading. One rule can watch every source, check conditions, keep variables, send messages, run scripts and send notifications. Open it from **Automation Engine** in the dashboard sidebar.

The **built-in automations** are the older, fixed features on each source's **Automation** view (MeshCore: **Automations**). They keep working. Use them when the Engine has no match yet, or when one checkbox does the job.

| I want to… | Automation Engine | Built-in |
|---|---|---|
| Answer range testers | **Auto-Ack** template | [Auto Acknowledge](/features/automation-messages#auto-acknowledge) (has a converter to the Engine) |
| Send a message on a schedule | **Timed Announcement** template, **On a schedule** trigger | [Auto Announce](/features/automation-messages#auto-announce), [Timer Triggers](/features/automation-triggers#timer-triggers) |
| Act when a node enters or leaves an area | **A node enters/leaves a region** trigger | [Geofence Triggers](/features/automation-triggers#geofence-triggers) |
| Get alerts for low battery, silent nodes or reboots | **Device Health** template | none |
| Relay between Meshtastic and MeshCore | **MT↔MC Bridge** template | none |
| Reply to keywords, call a web API, run a bot | Partial: **A message is received** trigger | [Auto Responder](/features/automation-messages#auto-responder) |
| Greet new nodes | Partial: **A new node is discovered** trigger | [Auto Welcome](/features/automation-messages#auto-welcome) |
| Forward my DMs to my phone | Partial: **A message is received** trigger with **Send a message** | [Forwarding](/features/automation-messages#forwarding) |
| Trace routes, poll stats, ping, sync clocks, repair keys, prune nodes | Partial for some; see [the table](/features/automation-upkeep) | [Mesh upkeep](/features/automation-upkeep) |

## Built-in automations {#built-in}

The built-ins are grouped on three pages:

- **[Message Automations](/features/automation-messages)**: Auto Acknowledge, Auto Responder, Auto Welcome, Auto Announce, Forwarding.
- **[Timer and Geofence Triggers](/features/automation-triggers)**: send or run a script on a schedule, or when a node crosses a fence.
- **[Mesh Upkeep Automations](/features/automation-upkeep)**: Auto Favorite, Auto Traceroute, Auto Remote LocalStats, Auto Ping, Auto Heap Management, Remote Admin Scanner, Auto Time Sync, Auto Key Management, Auto Delete by Distance, Ignored Nodes.

<span id="configuration-storage"></span><span id="permissions"></span>Settings are per source and live on the server, so they survive restarts and apply to every user. Changing them needs the per-source `automation` write permission. The Automation Engine uses its own global `automations` permission instead.

![Automation](/images/features/automation.png)

## Automated Messages Are Flagged {#is-automation}

Every Meshtastic packet MeshMonitor sends for an automation carries the **`is_automation`** flag: bit 2 (`0x04`) of the packet's `Data.bitfield`, reserved by Meshtastic for this purpose. That covers Auto Acknowledge, Auto Responder, Auto Announce, Auto Traceroute, timers, scheduled requests, key-repair NodeInfo exchanges and Automation Engine actions. A message you type yourself never carries it.

- **Messages** show a bot icon next to the hop count on any message whose sender set the flag, from MeshMonitor or any other client.
- **Packet Monitor** shows the flag in its own column.
- **Auto Acknowledge** and **Auto Responder** ignore flagged messages by default, so two bots can't answer each other forever. See [Respond to Automated Messages](/features/automation-messages#respond-to-automated-ack).
- **Automation Engine** message rules can filter on it. See [Sent by](/features/automation-engine#sent-by).

The flag costs no airtime: the bitfield is already in every packet. Older firmware and clients ignore it. The sender sets the flag itself and nothing verifies it, so use it to cut noise and stop loops, not to decide what a node is allowed to do.

## Cutoff Airtime Utilization Threshold {#airtime-cutoff}

When the mesh gets busy, this setting pauses a Meshtastic source's built-in automations so they stop adding traffic. They start again once Channel Utilization drops back under the threshold.

- **Cutoff Airtime Utilization Threshold (%)**: the Channel Utilization above which automations pause. Default `30`. `0` turns the cutoff off.
- The status line shows whether automations are active or paused, and the reading it used.

The cutoff pauses Auto Acknowledge, Auto Responder, Auto Welcome, Auto Announce, Forwarding, Timer Triggers, Geofence Triggers, Auto Traceroute, Auto Remote LocalStats, Auto Ping, Remote Admin Scanner, Auto Time Sync and Auto Key Management.

It also holds back **Automation Engine** actions that transmit on that source: send message, tapback, request data, broadcast waypoint and a remote reboot. The rule still runs, its other steps still happen, and the run log shows the held-back step as "paused: airtime over cutoff". **Run now** sends anyway and notes it in the log. See [Airtime cutoff](/features/automation-engine-reference#airtime-cutoff) in the Engine reference.

The cutoff only reads Meshtastic sources. MeshCore, Reticulum and MQTT sources have no Channel Utilization figure, so rules there are never held back.

### Where the reading comes from {#airtime-cutoff-source}

**Measure Channel Utilization from** picks one of two sources:

- **Local node** (default): the connected node's own self-reported ChUtil.
- **Nearby infrastructure**: the average ChUtil of router or repeater neighbours the local node has heard, either the strongest-RSSI ones or the ones you pick. Useful when the local node is well placed and its own reading under-represents the wider mesh.

**Choose infrastructure nodes** ([issue #6007](https://github.com/Yeraze/meshmonitor/issues/6007)), shown when the source is Nearby infrastructure:

- **Auto (strongest RSSI)** (default): averages the strongest-RSSI routers within the maximum hops. **Number of infrastructure nodes to average** sets how many (`3`-`5`, default `3`).
- **Manual (selected nodes)**: averages only the nodes you pick. The picker lists Router, Router Late and Client Base nodes (plus the deprecated Router Client and Repeater roles) heard in the last day, with role, hops, last ChUtil and how old that reading is. Pick `3` to `5`. A pick with no ChUtil reading in the last **3 hours** is skipped, and the status line names it. Use this when the strongest routers are not the ones that share your channel, for example a far router relayed by a strong local node.

Rules that apply in both modes:

- **Nodes heard over MQTT never count.** Their ChUtil describes a different RF area. The picker does not list them, and a saved pick that later becomes MQTT-only is skipped and named in the status line.
- **The local reading fills the gap.** When fewer nodes qualify than wanted (the sample count in Auto, the pick count in Manual), the gate uses the higher of the local node's ChUtil and their average. With none qualifying it uses the local ChUtil. The status line says so, for example "2 of 3 infrastructure nodes qualify; using local 31% (higher than their average 18%)". If the local ChUtil is not known yet either, the gate stays open as before.

![Airtime cutoff manual infrastructure picker](/images/features/6007-airtime-manual-infra.png)

**Maximum hops for neighbour candidates** (`0`-`7`, default `0`): Auto mode only; Manual mode ignores it. `0` is strict, only directly heard routers count. Raise to `1` if a `CLIENT_BASE` (or similar) node relays routers into your local node, so those routers arrive as one hop away. If the "waiting for neighbours" banner persists after several minutes on a setup you expect to work, try `1` first. See [issue #4801](https://github.com/Yeraze/meshmonitor/issues/4801) for the details.

## Where each built-in is documented {#moved}

Each built-in now has its full write-up on one of the pages above. These short entries keep old links working.

### Auto Acknowledge {#auto-acknowledge}

Replies to messages that match a pattern, for range testing. [Full docs](/features/automation-messages#auto-acknowledge). Engine: **Auto-Ack** template, or [convert your settings](/features/automation-engine-recipes#converting-auto-acknowledge-to-an-automation).

- <span id="auto-ack-max-responses"></span>[Maximum Number of Responses](/features/automation-messages#auto-ack-max-responses)
- <span id="meshcore-long-replies"></span>[Long Replies on MeshCore](/features/automation-messages#meshcore-long-replies)
- <span id="meshtastic-long-replies"></span>[Long Replies on Meshtastic](/features/automation-messages#meshtastic-long-replies)
- <span id="skip-incomplete-nodes-ack"></span>[Skip Incomplete Nodes](/features/automation-messages#skip-incomplete-nodes-ack)
- <span id="respond-to-automated-ack"></span>[Respond to Automated Messages](/features/automation-messages#respond-to-automated-ack)

### Auto Responder {#auto-responder}

Answers keywords with text, an HTTP call or a script. [Full docs](/features/automation-messages#auto-responder).

- <span id="match-mode-pattern-or-regex"></span>[Match mode: Pattern or Regex](/features/automation-messages#match-mode-pattern-or-regex)
- <span id="mailbox-dead-drop"></span>[Mailbox (Dead Drop)](/features/automation-messages#mailbox-dead-drop)
- <span id="skip-incomplete-nodes-responder"></span>[Skip Incomplete Nodes](/features/automation-messages#skip-incomplete-nodes-responder)
- <span id="respond-to-automated-responder"></span>[Respond to Automated Messages](/features/automation-messages#respond-to-automated-responder)
- Scripts: [Writing automation scripts](/developers/auto-responder-scripting)

### Auto Welcome {#auto-welcome}

Greets nodes the first time they appear. [Full docs](/features/automation-messages#auto-welcome).

### Auto Announce {#auto-announce}

Broadcasts a message on a schedule. [Full docs](/features/automation-messages#auto-announce). Engine: **Timed Announcement** template.

### Forwarding {#forwarding}

Copies matching incoming messages to another destination, such as your DMs to your phone. [Full docs](/features/automation-messages#forwarding).

### Timer Triggers {#timer-triggers}

Sends a message or runs a script on a cron schedule. [Full docs](/features/automation-triggers#timer-triggers). Engine: **On a schedule** trigger.

### Geofence Triggers {#geofence-triggers}

Acts when a node enters, leaves or stays in an area. [Full docs](/features/automation-triggers#geofence-triggers). Engine: **A node enters/leaves a region** trigger.

### Auto Favorite {#auto-favorite}

Favorites nodes that are active on your mesh and unfavorites stale ones. [Full docs](/features/automation-upkeep#auto-favorite).

### Auto Traceroute {#auto-traceroute}

Traces routes to nodes on a schedule. [Full docs](/features/automation-upkeep#auto-traceroute).

### Auto Remote LocalStats {#auto-remote-localstats}

<a id="auto-localstats"></a>

Polls remote nodes for noise floor, channel use and uptime. [Full docs](/features/automation-upkeep#auto-remote-localstats).

### Auto Ping {#auto-ping}

Lets mesh users start a ping session by DM (`ping N`) to test their link. [Full docs](/features/automation-upkeep#auto-ping).

- <span id="auto-ping-meshcore"></span>[MeshCore Companion Sources](/features/automation-upkeep#auto-ping-meshcore)

### Auto Heap Management {#auto-heap-management}

Reboots low-memory nodes before they run out of heap. [Full docs](/features/auto-heap-management).

### Remote Admin Scanner {#remote-admin-scanner}

Finds nodes you can administer remotely. [Full docs](/features/automation-upkeep#remote-admin-scanner).

### Auto Time Sync {#auto-time-sync}

Sends the server's time to nodes that allow remote admin. [Full docs](/features/automation-upkeep#auto-time-sync).

### Auto Key Management {#auto-key-management}

Repairs PKI key mismatches. [Full docs](/features/automation-upkeep#auto-key-management).

### Auto Delete by Distance {#auto-delete-by-distance}

Deletes or ignores nodes beyond a set distance from home. [Full docs](/features/automation-upkeep#auto-delete-by-distance).

### Ignored Nodes {#ignored-nodes}

Keeps a list of nodes to hide, and re-applies the ignore if it drops off. [Full docs](/features/automation-upkeep#ignored-nodes).

### Automatic Favorites Management (Remote) {#remote-favorites}

Keeps the favorites list up to date on a remote node you administer. Set it up in **Admin Commands** → **Automatic Favorites**. [Full docs](/features/automation-upkeep#remote-favorites).

## Related Documentation {#related-documentation}

- [Automation Engine](/features/automation-engine)
- [Writing automation scripts](/developers/auto-responder-scripting)
- [Push Notifications](/features/notifications)
- [Settings](/features/settings)
- [Device Configuration](/features/device)
