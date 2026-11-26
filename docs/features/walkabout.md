# Walkabout

Walkabout turns your phone into a moving receiver. You walk or drive with the
phone open in a browser. Every packet the source radio hears gets tagged with
where you are at that moment. The result is a measured record of what that
radio hears along your route.

![Walkabout session running](/images/features/walkabout-live.png)

Open it from **Analysis → Reports → Walkabout**.

## MeshMonitor sends nothing

Walkabout is passive. It sends no packet on the mesh. It only records packets
the source radio already receives.

## The radio must travel with the phone

MeshMonitor tags what the **source radio** hears. It uses your phone's GPS as
that radio's position. If the radio sits at home while you walk, it hears the
same nodes at every point, and the data says nothing about coverage.

Carry the radio MeshMonitor is connected to, and keep it linked to
MeshMonitor while you move.

## What you need

- **HTTPS or localhost.** Browsers give location to secure pages only. A plain
  `http://` LAN address gets no GPS. Put MeshMonitor behind a reverse proxy with
  TLS, or use Tailscale HTTPS.
- **Screen on.** A phone stops sending GPS when it locks. The page asks the
  browser to keep the screen on where the browser supports it. If the screen
  turns off anyway, the page shows how long GPS paused.
- **Location allowed** for the site in your browser.

## Start a walkabout

1. Open **Analysis → Reports → Walkabout**.
2. Pick a source. Meshtastic TCP and MeshCore sources show up. MQTT sources do
   not.
3. Optionally name the session.
4. Confirm that the radio travels with you, then press **Start walking**.

The live panel shows time elapsed, time left, samples, receptions, nodes
heard, and your current GPS accuracy. Press **Stop** to end the session.

## Limits

| Limit | Value |
|-------|-------|
| Session length | 2 hours, then it stops on its own |
| GPS fix accuracy | Fixes worse than 100 m are dropped |
| Accuracy warning | The page warns above 30 m |
| Sample rate | One sample per 5 seconds |
| Live sessions | One per source |
| Send retries | Samples that wait over 30 seconds for the server are dropped |

If another user already walks a source, you see that and cannot start a second
session on it.

## What "credited" means

Each packet is credited to one node: the **last-hop node**.

- For a direct packet, that is the sender.
- For a relayed packet, that is the repeater that handed it to your radio.

MeshMonitor skips a packet when it cannot name that node with certainty, for
example when two nodes share the relay byte. The **Not counted** line in the live
panel shows how many packets it skipped, and why: no fresh fix, an unknown or
shared relay, or no sender.

## Permissions

| Action | Permission |
|--------|-----------|
| Start, stop, or delete a session | `nodes:write` on the source |
| View sessions | `nodes:read` on the source |

Anyone who can read the source sees its sessions and tracks.

## Sessions

Sessions stay until you delete them. Stop a live session before you delete it.
Deleting removes the session with all its samples and receptions.

## Export and import

Tap the download button on a finished session to export it:

- **JSON** keeps everything: the session, every GPS sample, and every credited
  reception. It is the only format you can import again.
- **CSV** and **GeoJSON** list one row (or point) per GPS sample, with how many
  receptions were heard there, how many nodes, and the best SNR and RSSI.
  GeoJSON also draws the track as a line. Use these in other tools; MeshMonitor
  does not import them.

An export holds only what you can see. Receptions from nodes hidden from you
are left out, and the dialog says how many. Anyone who can read the source can
export its sessions.

To import, tap **Import** above the session list (you need `nodes:write` on the
target source), pick a Meshtastic TCP or MeshCore source, and choose a JSON
file. Each session in the file becomes a new, finished session tagged
**Imported**. Receptions of the other protocol are skipped. The file's source
and user are never kept.

- Limits are shared with Coverage imports: 32 MB and 10,000 rows (samples plus
  receptions) per file, and 50 imports and 200,000 imported rows per source.
- A file already imported into a source is refused.
- A node that the target source has never heard shows only to admins and to
  users with the source's base map permission (`channel_0:viewOnMap` on
  Meshtastic, `nodes:viewOnMap` on MeshCore). A node the source knows keeps its
  own map rules, so an import never shows a hidden node.
- Deleting an imported session deletes its whole import.

## Map

The map shows what the source radio heard along your routes. Find it in two
places:

- The **Walkabout** page, in a panel under the session list. It stays hidden
  during a live walk. The page says "The map opens when you stop."
- **Coverage Report → View → Walkabout**. See [Coverage Report](./coverage-report).

![Walkabout hex map](/images/features/walkabout-map.png)

Each hex takes the colour of the **best** signal heard in it, counting the
last-hop node only (see "What credited means" above). The hex size grows as
you zoom out, so the map stays easy to read at any scale.

| Colour | Meaning |
|--------|---------|
| Strong | Best SNR of 0 dB or more |
| Medium | Best SNR from -5 to 0 dB |
| Weak | Best SNR from -10 to -5 dB |
| None | Best SNR below -10 dB, or you walked there and heard nothing |
| Grey | Heard, but with no SNR reading |

The bands are fixed. Slow presets decode below -10 dB, so they may read low
on this map. Per-source bands are tracked in
[#6571](https://github.com/Yeraze/meshmonitor/issues/6571).

Tap a hex to see "N nodes heard here". The list shows each node's best SNR and
how many times you heard it (x count).

**Time window.** Choose 24h, 7d, 14d or 30d, or pick one session. When you pick
one session, the map also draws the walker's track. Anyone who can read the
source can see that track.

**Hidden nodes.** The map leaves out receptions from nodes hidden from the
map. A banner shows how many it dropped.

**Large windows.** When a window holds more data than the map loads, a note
reads "showing part of this window". Pick a shorter window to see all of it.

## API

All routes live under `/api/sources/:id/walkabout`. Read routes need
`nodes:read`. Write routes need `nodes:write`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/sessions` | List sessions for the source |
| GET | `/sessions/live` | The live session, or `null` |
| GET | `/sessions/:sessionId` | One session with counts |
| POST | `/sessions` | Start a session (optional `name`) |
| POST | `/sessions/:sessionId/samples` | Post GPS samples (`latitude`, `longitude`, `accuracyM`, `deviceFixAt`, `ageMs`) |
| POST | `/sessions/:sessionId/stop` | Stop a session |
| DELETE | `/sessions/:sessionId` | Delete a stopped session |
| GET | `/cells` | Hex cells with best SNR for a time window or one session (login + `nodes:read`) |
| GET | `/cell-nodes` | Nodes heard in one hex (login + `nodes:read`) |
| GET | `/sessions/:sessionId/track` | The walker's track for one session (login + `nodes:read`) |
| GET | `/sessions/:sessionId/export` | The session as the JSON export, filtered for the viewer (login + `nodes:read`) |

Import uses the Coverage import route: `POST /api/sources/:id/coverage/imports`
with the JSON file as `application/octet-stream` and an `X-Filename` ending in
`.json`. Delete an import with `DELETE /api/sources/:id/coverage/imports/:importId`.

Errors: `409 WALKABOUT_NOT_LIVE` when a session already ended,
`409 WALKABOUT_LIVE_SESSION` when you delete a live one, and
`409 WALKABOUT_IMPORTED` (with `importId`) when you delete an imported session
on its own.

## Repeaters only

A walker wants to know which repeaters the walk can reach. The **Repeaters**
chip sits in the header of the Map Features panel, beside the zoom-to-fit
button, on the Meshtastic map, the Dashboard and Unified maps, and the MeshCore
map. Click it to hide every node that is not a repeater. Click it again to show
all nodes.

![Dashboard map with Repeaters only on](/images/features/map-repeaters-only.png)

- **Meshtastic:** Router, Router Late, Repeater, the deprecated Router Client,
  and Client Base. A node with no role counts as a client and is hidden.
- **MeshCore:** repeaters and room servers.
- Your own node stays on the map. Favourites do not stay, so the map shows
  repeaters only.
- The choice persists in this browser across reloads. The chip stays in the
  header when the panel is collapsed, so you can see that the filter is on.
- It only changes what the map draws. It sends nothing and does not change the
  node list.

## Related

- [Coverage Report](./coverage-report) — the passive map built from position
  packets
- [Analysis & Reports](./analysis-reports) — the workspace Walkabout lives in
- [Per-Source Permissions](./per-source-permissions) — how source grants work
