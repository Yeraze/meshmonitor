# MeshCore Receive-Only Mode

::: tip Added in 4.14 (#4547)
A per-source strict receive-only setting for MeshCore sources — the node keeps listening, but MeshMonitor blocks every transmission it controls.
:::

::: danger MeshCore firmware has no transmit kill switch
MeshCore firmware exposes **no radio-level transmit switch**. We checked: the companion protocol client `@liamcottle/meshcore.js` (v1.13.0) has no `txEnabled`, `disableTx`, or `radioOff` command anywhere in its command set. `SetTxPower` only lowers transmit power — it never stops transmission.

So MeshMonitor enforces receive-only **in software**, by refusing every send it controls: the web UI, the REST API, schedulers, automations, and the Virtual Node port. It **cannot** stop transmissions the node makes on its own — link-layer acknowledgements, and any advert schedule you configured on the device outside MeshMonitor.

**MeshMonitor's guarantee is "MeshMonitor will not key the radio," not "this radio is silent."** If you need this for a regulatory or site-policy reason, read that sentence again before you rely on it. Contrast this with Meshtastic's [`lora.txEnabled`](/features/receive-only-mode), which **is** a firmware kill switch — Meshtastic hardware drops outbound packets at the radio driver, before they reach the air.
:::

## What it is

Receive-only mode is a per-source setting (`meshcoreReceiveOnly`) that applies to a single MeshCore source — Companion or Repeater. Turn it on and MeshMonitor stops sending anything to that node's radio: no messages, no adverts, no remote admin, no path discovery, and no automation transmits. Everything the node hears keeps flowing in as normal.

Good reasons to run a MeshCore source this way:

- A dedicated **Analyzer Observer** box that should only listen and report, never key up
- A **passive monitoring station** watching mesh activity without participating in it
- A **regulatory or site-policy** environment that requires a listen-only radio
- A **shared install** — a kiosk, a public terminal, a lab node — where accidental transmission by any user must be prevented

## What still works

- **Receiving and decoding** every packet the radio hears
- The **Analyzer Observer** — it publishes heard packets outbound to an MQTT broker, which is a network path, not a radio path (see [MeshCore Analyzer Observer](/features/meshcore-analyzer-observer))
- The **MeshCore Packet Monitor** (raw OTA capture)
- Contact, route, telemetry, and dashboard updates learned from RF traffic
- The connection itself, over USB or TCP — the source stays connected
- **Local serial configuration**: device name, radio parameters, TX power, coordinates, channel create/edit/delete, RTC sync, device stats, reboot, and contact import/export
- The **local serial CLI**, except the synthetic `advert` verb (see [What is blocked](#what-is-blocked))
- **Read-only Virtual Node access** — see [below](#virtual-node-access)

## What is blocked

Anything that puts a packet on the air from this node:

- Channel messages and direct messages
- Self-adverts
- Remote CLI and remote logins
- Path discovery and traceroute
- Telemetry and status requests to other nodes
- Neighbour requests
- Node and region discovery
- Contact sharing
- Discovery auto-responses (the node no longer answers other nodes' discovery requests)
- Every automation that transmits: auto-acknowledge, the auto-responder, auto-announce, auto-pathfinding, and timer triggers

Automation settings are **preserved, not cleared**. Each affected automation section shows a "Paused — receive-only mode" note; the configuration stays exactly as you left it and resumes on its own configured schedule the moment you turn receive-only off. Turning it on never discards a saved automation.

## Virtual Node access

The [MeshCore Virtual Node](/configuration/virtual-node#meshcore-virtual-node) port stays up and keeps serving reads while a source is receive-only: identity, contacts, channels, message sync, device info, battery, time, local config setters, and PKI export (where enabled) all keep working, along with the live packet feed. This matters because the Virtual Node port is a raw TCP socket that bypasses MeshMonitor's HTTP API entirely — closing it off is what makes receive-only complete.

The nine transmit-causing companion commands are refused instead: `SendChannelTxtMsg`, `SendTxtMsg` (including the CLI relay), `SendSelfAdvert`, `SendLogin`, `SendTracePath`, `SendTelemetryReq`, `SendStatusReq`, and `SendBinaryReq` (neighbour requests). A third-party MeshCore client connected to the Virtual Node gets a prompt, well-formed refusal on each of these — not a silent drop, and not a timeout.

::: warning The Virtual Node port is unauthenticated
Keeping reads available cuts both ways: the Virtual Node port has no authentication, so any client that can reach it can read your identity, contacts, channels and messages. That is existing Virtual Node behaviour and receive-only mode does not change it — but it is worth restating here, because "receive-only" means *this node will not transmit*, not *this node will not disclose anything*. If that distinction matters for your deployment, restrict access to the port, or turn the Virtual Node off.
:::

## How to enable / disable it

1. Open the source's **MeshCore Settings**.
2. Toggle **Receive-only mode**.
3. Turning it **on** takes effect immediately — no confirmation needed.
4. Turning it **off** shows a confirmation dialog, because it resumes RF: messages, adverts, remote admin, and every enabled automation will start transmitting again. Confirm to apply.

The change applies with no reload and no reconnect.

## API behaviour

Any MeshCore route that would transmit returns:

```json
{
  "success": false,
  "error": "Transmission blocked: this MeshCore source is configured for receive-only operation.",
  "code": "TX_DISABLED"
}
```

with HTTP status `409`. This is the same `TX_DISABLED` code Meshtastic sources use for `lora.txEnabled = false` — see the [REST API reference](https://github.com/Yeraze/meshmonitor/blob/main/docs/api/API_REFERENCE.md) for the full route list. Two of the gated routes are `GET` requests (fetching neighbours and remote admin status), which is easy to miss if you're only checking `POST` routes.

## Per-source scope

Receive-only applies to **one source only**. A sibling MeshCore source, or any Meshtastic source, keeps transmitting normally. There is no global switch — set it per source, on the sources that need it.

## Related

- [MeshCore Support](/features/meshcore) — source setup and configuration
- [MeshCore Virtual Node](/configuration/virtual-node#meshcore-virtual-node) — what read-only access covers
- [MeshCore Analyzer Observer](/features/meshcore-analyzer-observer) — keeps publishing under receive-only
- [Receive-Only Mode](/features/receive-only-mode) — the Meshtastic equivalent, which **is** a firmware kill switch
- [REST API Reference](https://github.com/Yeraze/meshmonitor/blob/main/docs/api/API_REFERENCE.md) — `409 TX_DISABLED` error shape
