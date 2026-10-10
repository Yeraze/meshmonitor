# Local Markers

A **local marker** is a note on the map that stays inside MeshMonitor. It is never sent to the mesh. Use local markers for planning: candidate repeater sites, survey points, aid stations for an event, dead spots you want to remember. A site survey can hold hundreds of them without costing any airtime.

## Local markers and waypoints

| | Waypoint | Local marker |
|---|---|---|
| Sent to the mesh | Yes, broadcast by your node | **No, never** |
| Costs airtime | Yes, on every broadcast | None |
| Seen by phone apps on the mesh | Yes | No |
| Seen by MeshMonitor users | Yes | Yes, with read access to the source |
| Looks like | Filled circle with an emoji | Outline icon in a dashed ring |

Waypoints and nodes always draw on top of a local marker at the same spot.

## Adding a marker

1. Open a source's map (**Nodes**).
2. Click **+ Local marker** above the map, then click the spot. Press Escape to cancel.
3. Enter a label, and optionally notes, altitude, an icon and a colour. Adjust the position if you need to.
4. Click **Save**.

To change or remove a marker, click it and use **Edit** or **Delete** in its popup.

## Who can see and change markers

Markers belong to one source and use that source's **Waypoints** permission:

- **Waypoints: read** on the source shows its markers.
- **Waypoints: write** on the source lets you add, edit and delete them.

A grant on another source does not help. The anonymous account follows its own grants, so a public map shows markers only if the anonymous account can read that source's waypoints. The Dashboard and Map Analysis show markers from every source you can read, but you edit them on the source's own map.

## Showing and hiding markers

- **Nodes and Dashboard maps:** turn **Show Local Markers** on or off in the map controls. The setting is saved in your browser.
- **Map Analysis:** use the **Local Markers** layer toggle.

Markers do not draw in the 3D view.

## Limits

- Up to **1,000 markers per source**. Delete some to add more.
- Label: up to 64 characters. Notes: up to 2,000 characters.
- Six icons (pin, star, target, antenna, home, warning) and six colours that follow the light and dark themes.

## Backups and deleting a source

Markers are included in system backups and restored with them. Deleting a source deletes its markers. Purging a source's nodes does not.
