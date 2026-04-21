# Geofence Triggers

::: tip Added in 4.0
Define geographic zones and have MeshMonitor act automatically when nodes enter, exit, or dwell inside them — arrival alerts, asset-tracking, proximity pings, or any scripted response.
:::

## What's a Geofence Trigger?

A geofence is a circular or polygonal region on the map. A **trigger** pairs that region with an event and an action:

| Event | Fires when… |
| --- | --- |
| `enter` | A tracked node moves from outside the fence to inside |
| `exit` | A tracked node moves from inside to outside |
| `dwell` | A tracked node remains inside longer than the dwell threshold |

Each trigger runs an action — send a channel message, send a DM, run an auto-responder script, send a push notification, or post to an Apprise URL.

## Creating a geofence

1. Open **Settings → Automation → Geofence Triggers**
2. Click **Add geofence**
3. Drop a circle (centre + radius) or draw a polygon on the map
4. Name it and save

The geofence appears on the main map as a translucent overlay (colour-coded by the map overlay colour palette).

## Building a trigger

1. Pick the geofence
2. Choose which nodes it applies to — a single node, a tag group, or **any**
3. Choose the event (`enter`, `exit`, `dwell`) and — for `dwell` — the dwell duration
4. Pick an action:
   - **Channel message** — broadcast on a specific channel
   - **Direct message** — DM a specific node
   - **Auto-Responder script** — runs your custom Python/Bash/JS script with context in environment variables
   - **Push / Apprise** — notify humans instead of nodes
5. Optional: throttle / cooldown per node to avoid bounce

## Common patterns

| Scenario | Setup |
| --- | --- |
| "Kid got home" | Single-node enter-trigger on home fence → push notification |
| Asset tracking | Any-node enter/exit on warehouse fence → channel message |
| Event perimeter | Dwell-trigger (5 min) on event fence → DM organizer |
| Safety zone | Exit-trigger on coverage fence → Apprise to on-call |

## Related

- [Automation Overview](/features/automation)
- [Auto-Responder Scripting](/developers/auto-responder-scripting) — custom actions
- [Per-Source Permissions](/features/per-source-permissions) — who can edit geofences
