# Geofence Triggers

::: tip Added in 4.0
Define geographic zones and have MeshMonitor act automatically when nodes enter, exit, or stay inside them: arrival alerts, asset tracking, proximity pings, or any scripted response.
:::

## What's a Geofence Trigger?

A geofence is a circular or polygonal region on the map. A **trigger** pairs that region with an event and an action:

| Event | Fires when… |
| --- | --- |
| **Entry** | A tracked node moves from outside the fence to inside |
| **Exit** | A tracked node moves from inside to outside |
| **While Inside** | A tracked node is still inside, once per interval (in minutes) |

Each trigger runs one action: send a text message, or run a script. The output goes to a channel, to the triggering node as a direct message, or nowhere when a script handles its own output.

## Creating a trigger

A trigger holds its own region; there is no separate list of geofences.

1. Open the source's **Automation** tab and scroll to **Geofence Triggers**
2. Name the trigger
3. Pick **Circle** or **Polygon**. For a circle, click the map to place the centre, then set the radius. For a polygon, click to add each corner and double-click to finish
4. Choose the event: **Entry**, **Exit**, or **While Inside**. For **While Inside**, set the interval in minutes (1 to 1440)
5. Choose which nodes it applies to: **All Nodes** or **Selected Nodes**
6. Pick the action type:
   - **Text Message**: a message with tokens such as `{LONG_NAME}` and `{GEOFENCE_NAME}`
   - **Script**: runs your Python, shell, or JavaScript script from `/data/scripts/`, with context in environment variables
7. Pick the channel: a channel, **Direct Message**, or (scripts only) **None (no mesh output)**
8. Optional: set **Cooldown (minutes)** per node to stop a node on the fence line from firing over and over. `0` means no cooldown
9. Click **Add Geofence Trigger**, then **Save**

See [Automatic Responses: Geofence Triggers](/features/automation#geofence-triggers) for the token list and script arguments.

## Push and Apprise notifications

A Geofence Trigger on the Automation tab sends to the mesh or runs a script. To notify people through Apprise, or to add conditions, build the rule in the [Automation Engine](/features/automation-engine#geofence-trigger) with its **A node enters/leaves a region** trigger and a **Send a notification** action.

## Common patterns

| Scenario | Setup |
| --- | --- |
| "Kid got home" | Selected-node Entry trigger on the home fence → direct message, or an Automation Engine rule → notification |
| Asset tracking | All-nodes Entry and Exit triggers on the warehouse fence → channel message |
| Event perimeter | While Inside trigger (5 min) on the event fence → channel message |
| Safety zone | Automation Engine rule: node leaves the coverage region → Apprise to on-call |

## Related

- [Automatic Responses](/features/automation)
- [Automation Engine](/features/automation-engine)
- [Auto-Responder Scripting](/developers/auto-responder-scripting): custom actions
- [Per-Source Permissions](/features/per-source-permissions): who can edit geofences
