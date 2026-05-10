# Waypoints

MeshMonitor renders, stores, and authors **Meshtastic waypoints** — the per-source pins on the mesh's `WAYPOINT_APP` channel. Use them to mark net check-ins, repeaters, supply caches, hazards, or any geographic point of interest you want everyone on the mesh to see.

Waypoints are first-class data alongside nodes, messages, and telemetry: they live in the per-source database, route through the same WebSocket fan-out, and are gated by a dedicated `waypoints:read` / `waypoints:write` permission pair.

## What you get

- **Per-source storage** of every WAYPOINT_APP packet received, with the owner node, expiry, lock-to-node, and emoji icon preserved
- **Map rendering** on both the per-source dashboard map and Map Analysis, using the waypoint's emoji as the marker icon
- **In-place authoring** — create, edit, and delete waypoints from the per-source map and broadcast them to the mesh
- **Expiry handling**: `expire_at = 0` is treated as "no expiration"; expired waypoints are swept out by the daily maintenance task with a grace window
- **Real-time updates**: `waypoint:upserted`, `waypoint:deleted`, and `waypoint:expired` events fan out over the existing source-scoped WebSocket rooms

## Permissions

Waypoints are gated by a new permission pair, granted per source the same way other source permissions work:

| Permission | What it lets a user do |
| --- | --- |
| `waypoints:read` | See waypoints on the map and in the API |
| `waypoints:write` | Create, edit, and delete waypoints (subject to `locked_to`) |

On upgrade, every user with `messages:read` / `messages:write` for a given source automatically receives the matching `waypoints:*` grant — admins bypass the row check anyway. You can adjust per-user grants from the Users page like any other source permission.

## Viewing waypoints

### Per-source dashboard map

Open the Dashboard, select a source from the sidebar, and waypoints appear as emoji markers alongside the source's nodes. Click a waypoint to see:

- Name and description
- Owner node (and source)
- Expiry timestamp, or "never" when `expire_at` is unset
- 🔒 indicator when the waypoint is locked to a specific node

The unified "all sources" dashboard renders waypoints from every source you can read, but suppresses authoring actions — those are scoped to a specific source.

### Map Analysis

The Map Analysis canvas exposes a **Waypoints** layer in the toolbar. Toggle it to overlay every visible waypoint on top of the existing analysis layers (heatmap, traceroutes, etc.).

## Creating, editing, and deleting waypoints

Authoring is available on the per-source dashboard map for users with `waypoints:write`.

### Create

1. Open a source's dashboard map.
2. Open the **Map Features** dropdown and click **➕ Waypoint** (or right-click the map for the same shortcut).
3. The cursor switches to a crosshair — click the map at the desired location, or press **Esc** to cancel.
4. Fill in the waypoint editor:
   - **Name** and **Description**
   - **Icon** — pick an emoji from the picker (rendered with VS-16 forcing so it shows as an emoji on every platform)
   - **Lock to me** — only your node can edit this waypoint after broadcast
   - **Expires** — toggle on to set an expiry timestamp; off means "never expires"
5. Click **Save**. MeshMonitor allocates a waypoint id (Python-style id allocation), persists the row, and broadcasts a WAYPOINT_APP packet to the mesh.

### Edit

Click the waypoint marker, then **Edit** in the popup. Editing is suppressed when the waypoint is locked to another node.

### Delete

Click **Delete** in the waypoint popup. MeshMonitor removes the row locally and broadcasts an `expire = 0` tombstone so peers also drop it. (The on-wire delete signal is the tombstone; locally we treat `expire_at = 0` as "no expiration", so the deletion is intentional and not a side effect of the column value.)

## REST API

Waypoints are exposed on the v1 source-scoped routes, gated by `waypoints:read|write`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`    | `/api/sources/:id/waypoints` | List waypoints (supports `?bbox=` and `?include_expired=`) |
| `POST`   | `/api/sources/:id/waypoints` | Create a local waypoint and broadcast it |
| `PATCH`  | `/api/sources/:id/waypoints/:waypointId` | Update name/description/icon/expiry/lock |
| `DELETE` | `/api/sources/:id/waypoints/:waypointId` | Delete locally and broadcast a tombstone |

All mutations require the standard `X-CSRF-Token` header. Mutations on a waypoint with `locked_to` set to another node return `403`.

## Database

Waypoints live in a per-source `waypoints` table introduced in migration **053**, with composite primary key `(sourceId, waypointId)`, a foreign key to `sources` with `ON DELETE CASCADE`, and indexes on `(sourceId, expireAt)` and `(sourceId, ownerNodeNum)`.

Migrations **054** / **055** seed the new `waypoints:read` / `waypoints:write` permissions for existing users by cloning their `messages` grants per source.

The daily database maintenance tick sweeps expired waypoints (with a grace window) and emits `waypoint:expired` events for each removed row.

## Limitations and follow-ups

- **Rebroadcast scheduler is not yet wired**. The `rebroadcast_interval_s` column is persisted and accepted by the API, but no timer fires it. Waypoints you create are broadcast once on save; resends rely on the stock Meshtastic firmware behaviour at this time.
- **Automation hooks** for the waypoint message type are not yet available — Auto-Responders and Geofence Triggers do not currently match on waypoint events.

Both are tracked as follow-ups; see [#2936](https://github.com/Yeraze/meshmonitor/issues/2936) for the umbrella issue.
