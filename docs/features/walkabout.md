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

A map view of a finished session comes in a later release.

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

Errors: `409 WALKABOUT_NOT_LIVE` when a session already ended, and
`409 WALKABOUT_LIVE_SESSION` when you delete a live one.

## Related

- [Coverage Report](./coverage-report) — the passive map built from position
  packets
- [Analysis & Reports](./analysis-reports) — the workspace Walkabout lives in
- [Per-Source Permissions](./per-source-permissions) — how source grants work
