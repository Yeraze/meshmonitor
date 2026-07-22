# MeshCore Support

::: warning STILL EARLY
MeshCore support is still **new and basic**. The core capabilities are stable and shipping incrementally — but expect rough edges, missing pieces compared to the Meshtastic side, and a fast-moving feature surface. If something doesn't behave the way you'd expect, [open an issue](https://github.com/yeraze/meshmonitor/issues/new).
:::

## Overview

[MeshCore](https://meshcore.co) is an alternative LoRa mesh networking protocol that runs on much of the same hardware as Meshtastic. In MeshMonitor 4.5+, each MeshCore device is a first-class **source** — it lives in the Sources sidebar next to your Meshtastic nodes, has its own per-source permissions, its own page, its own telemetry, and contributes contacts with valid coordinates to the unified dashboard map.

A single MeshMonitor deployment can run multiple MeshCore sources alongside multiple Meshtastic sources and gate access to each one independently. MeshCore sources are added from the UI and support both USB (Companion or Repeater) and TCP (Companion) transports.

When a MeshCore source is connected, you get:

- **Per-source MeshCore page** — Nodes, Channels, Node Details, Configuration, and a Node Info page in a single multi-pane layout
- **Dashboard integration** — MeshCore sources appear as styled cards in the dashboard sidebar with their own logo, status, and node count
- **Unified map** — MeshCore contacts with GPS appear on the dashboard map alongside Meshtastic nodes
- **Local-node telemetry** — Battery, radio stats, packet rates, and duty-cycle graphs from the connected companion
- **Per-node remote telemetry** — Scheduled cross-mesh telemetry pulls from other MeshCore nodes, written into the same telemetry store as Meshtastic
- **Radio preset selector** — Pick from the official MeshCore preset list instead of hand-tuning freq/bw/sf/cr
- **Contact-detail panel** — Hops, RSSI/SNR, last heard, position, and the full public key shown next to DM threads
- **Contact management** — Remove contacts from the device, export as `meshcore://` URLs for sharing, import from pasted URLs or hex blobs
- **Repeater neighbour list** — Query a repeater's neighbour table with SNR and last-heard timestamps, with results rendered on the map
- **Path visualization** — Show route lines on the map colored by hop count, with Discover Path buttons for manual route establishment
- **Position history** — Per-node movement trails on the map, with a configurable retention window
- **Auto-pathfinding** — Scheduled path discovery and neighbor collection across your entire mesh
- **Region / scope tagging** — Stamp outgoing flood traffic with a named region so meshes that drop un-scoped packets (e.g. `region denyf *`) forward it; per-channel, per-source default, and per-message override
- **Room server support** — Login, post, and auto-sync with MeshCore room servers (BBS-style message boards)
- **@mention highlighting** — Messages mentioning your name are visually highlighted
- **Delivery status** — Sent DMs show pending/confirmed/failed indicators
- **Clickable contact names** — Names in messages navigate to that contact's DM thread
- **Mobile-responsive layout** — Full MeshCore page works on mobile with list/detail toggle
- **Device time sync** — One-click RTC sync from the Node Info page
- **Device management** — Reboot device, backup/restore Ed25519 private key (danger-gated with confirmation)
- **Telemetry-mode configuration** — Toggle base / location / environment telemetry on the device itself
- **UI permission gating** — Write controls are disabled (not just rejected) for users without the right permission

## Source Types

MeshCore sources are added through the UI. The Sources sidebar lets you pick a device type of **Companion** (native JS backend via meshcore.js) or **Repeater** (direct serial), and a transport of **USB** or **TCP**.

::: tip Room Server
**Room Server** devices use the same Companion path — when present they're auto-detected on connection. There's no Room Server option in the device-type selector; pick Companion and the device will be identified correctly.
:::

## Requirements

1. **A MeshCore device** — A LoRa device flashed with MeshCore firmware (Companion, Repeater, or Room Server)
2. **Serial port access** — If connecting via USB serial, the device must be mapped into the container with `devices:`

## Adding a MeshCore Source

Add MeshCore sources from the UI — they hot-connect immediately without a restart.

1. Open the **Sources sidebar** on the dashboard (admin only)
2. Click the **+** button next to the Sources header
3. Pick **MeshCore** as the source type
4. Choose the transport — **USB** (enter the serial port, e.g. `/dev/ttyACM0`) or **TCP** (enter the host and port; see [TCP Transport](#tcp-transport) below)
5. Pick the **device type** — **Companion** for full-featured devices, **Repeater** for direct-serial repeaters (USB only)
6. *(Optional)* Set a **Heartbeat** interval in seconds (0 = off). When set, MeshMonitor periodically probes the Companion node and automatically reconnects with exponential backoff if the link drops — the same setting Meshtastic sources have. Applies to Companion devices only.
7. Save — the source connects immediately if **Auto-connect** is on

Sources you create from the UI are wired into the per-source MeshCore manager registry the same way Meshtastic TCP sources are, so create / update / delete / connect / disconnect all work without a process restart.

### TCP Transport

Added in 4.5.1. MeshCore Companions can now be reached over TCP directly from the UI — no env-var bootstrap, no container restart. Pick **TCP** in the transport selector when adding or editing a MeshCore source.

| Field | Default | Notes |
|---|---|---|
| Host | (none) | Hostname or IP of the device or proxy reachable from the MeshMonitor container |
| Port | `4403` | TCP port the companion is listening on; override if your proxy uses a different port |

Common ways to put a MeshCore Companion on TCP:

- **Native TCP firmware** — MeshCore Companion builds that expose the binary protocol directly over TCP (listening on `4403` by default). Wire the device to your network, point MeshMonitor at it.
- **`ser2net`** — Bridge a serial-attached MeshCore device on another host to a TCP port. Useful when the companion is plugged into a Pi or workstation that isn't running MeshMonitor.
- **`esp-link`** — ESP8266/ESP32-based serial-to-WiFi adapter wired to the companion's UART. The same binary protocol flows transparently over the link.

::: tip Container networking
TCP sources connect from inside the MeshMonitor container, so the host must be reachable from there — use the device's LAN IP (or your gateway hostname), not `localhost` or `127.0.0.1`. If the companion is on the same host as MeshMonitor, use `host.docker.internal` (already configured in `docker-compose.dev.yml`) or the host's LAN IP.
:::

::: warning Companion only
TCP is a Companion-class feature. Repeater devices are still USB-only — pick the **USB** transport when adding a Repeater source.
:::

### Tuning Environment Variables

A couple of background-scheduler tuning knobs are still environment-driven:

| Variable | Default | Description |
|---|---|---|
| `MESHCORE_TELEMETRY_INTERVAL_MS` | `300000` | How often (ms) to poll the **local** companion for telemetry. Default 5 minutes. |
| `MESHCORE_REMOTE_TELEMETRY_TICK_MS` | `30000` | How often (ms) the remote-telemetry scheduler walks each source and picks an eligible node. |

::: warning Removed in 4.6
The 3.x `MESHCORE_ENABLED`, `MESHCORE_SERIAL_PORT`, `MESHCORE_BAUD_RATE`, `MESHCORE_TCP_HOST`, `MESHCORE_TCP_PORT`, and `MESHCORE_FIRMWARE_TYPE` env-var bootstrap was removed when MeshCore became a first-class source type. Add a MeshCore source from the Sources sidebar instead.
:::

::: tip
`ENABLE_VIRTUAL_NODE` is a separate Meshtastic feature for proxying the Meshtastic protocol to mobile apps — it has **no relation** to MeshCore connectivity and is ignored by MeshCore sources.
:::

## Device Types

MeshMonitor automatically detects the device type on connection:

| Device Type | Description | Connection Method |
|---|---|---|
| **Companion** | Full-featured device with binary protocol support | Native JS backend (meshcore.js, serial or TCP) |
| **Repeater** | Lightweight relay with text CLI interface | Direct serial |
| **Room Server** | Chat room server for group messaging | Native JS backend (meshcore.js) |

## The MeshCore Page

Each MeshCore source has its own multi-pane page accessible by clicking the source in the dashboard sidebar. The page has a sub-toolbar with these views:

### Nodes

A map of every contact with valid coordinates, plus a styled row list aligned to the same visual vocabulary as the Meshtastic nodes view. The map honours zoom-based label visibility and falls through to the dashboard map when the source is selected at the dashboard level. A search/filter bar lets you quickly find contacts by name or public key prefix.

On **mobile**, the node list and the map occupy the same area; a toggle button switches between them so the map is always reachable without first selecting a node. On desktop, a collapse button collapses the list to a thin sidebar (preference persisted to `localStorage`).

### Channels

The device's channels with the most recent message stream. Channel-message senders are now extracted from the `"Name: body"` prefix that MeshCore embeds in the text body, so the sender column and the message body are no longer collapsed into one string.

**Unread indicators** — channels with messages newer than the last time you opened them show an unread dot and a **bold name** in the channel list. A header badge counts how many channels currently have unread messages, and an optional **"unread first"** sort toggle (persisted) floats those channels to the top. Opening a channel marks it read up to the newest visible message. MeshCore read state is tracked **client-side in `localStorage`, scoped by `sourceId`** — there's no server-side MeshCore read table, so read markers are per-browser rather than per-account.

**Reply** — received channel messages carry a **Reply** button. Clicking it prefills the composer with the sender's MeshCore mention (`@[Sender]: `) and sends the reply **on the scope the original message arrived on**, so a threaded answer stays in the same region. The button appears only on incoming channel messages — not on your own messages, and not in 1:1 DMs.

**Heard repeaters** — outgoing channel posts show a **📡 N** badge with an expandable list of the repeaters that re-flooded the message and the SNR each was heard at. This is populated best-effort by **self-echo correlation**: when a repeater re-floods your `GRP_TXT` packet, MeshMonitor hears it inbound and attributes the relay hashes to the most recent matching channel send within a ~30-second window. Channel sends carry no protocol ACK, so this is a heuristic, not a delivery receipt. Correlation runs on the raw inbound packet before the opt-in packet-monitor gate, so it works **regardless of whether the packet monitor is enabled**. Relay hashes are resolved to repeater names where known; otherwise the raw hash is shown.

### Node Details

Per-contact DM view (renamed from "Direct Messages" to reflect that it also surfaces node details, not just DMs) with a **contact-detail panel** that mirrors the Meshtastic NodeDetailsBlock. It surfaces:

- Contact name and type (companion / repeater / room server)
- Hops away (`pathLen`)
- RSSI and SNR
- Last heard and last advert
- Position (if known)
- Full public key
- **Discover Path** button — triggers firmware CMD 52 to establish/refresh the route to a companion contact
- **Define Path** editor — manually set the route to a contact when you already know the relay hops, instead of probing for it. Add hops in order and pick the per-hop **hash width** (1, 2, or 3 bytes) — the selector is pre-filled from the current path, and changing the width clears the hop list since the encoding differs. The hop count is capped at 63. Use this when Discover Path can't reach the contact but you know the topology.
- **Delivery status** — sent DMs show pending / confirmed / failed indicators with timestamp tooltips

Contact names in messages are **clickable** — clicking a name navigates directly to that contact's DM thread. Messages containing **@YourName** are visually highlighted.

The panel is collapsible with state persisted to localStorage.

The **per-node remote-telemetry config** panel hangs off the contact-detail panel (see [Per-Node Remote Telemetry](#per-node-remote-telemetry) below).

::: warning Repeaters have no DM composer
MeshCore repeaters (`advType=2`) can't hold a conversation, so they no longer expose a message composer. The 💬 button is hidden on repeater rows, and selecting a repeater shows its node detail and telemetry/graphs instead of an (empty) conversation pane. The repeater stays listed in the contact sidebar — only the chat surface is dropped. The Meshtastic side does the same for nodes flagged unmessagable.
:::

### Message route line

Received channel and DM messages show a route line beneath the body, derived from the packet's relay path:

- **📍 direct** — heard with zero hops (direct RF).
- **🛰 N hops · a3 → 7f → 02** — relayed; the chain lists each relay's hash in order.

**Clicking the hash chain** opens a route-detail popup with the message's reception details (sender, time, hops, scope, text) and the route expanded per hop into **repeater / room-server names** from the contact list. Only relay infrastructure ever appears in a MeshCore path — each forwarder appends the leading bytes of its public key at the hash width the original sender chose (1–3 bytes) — so matching is limited to those contacts. Unknown hashes stay as raw hex; when several repeaters share a hash prefix, the popup best-guesses the one closest to the neighbouring hops' positions and labels it as such.

When **every** relay hop resolves to a contact with a known position, the popup also shows a **Packet flow** mini map: a dashed line tracing the packet geospatially across the relays, each hop marked and labeled (`#1 Hilltop`, `#2 Downtown`, …). The sender and your local node are added as endpoints when their positions are known. If any hop is unknown or unpositioned the map is omitted entirely — a partial line would misrepresent the path.

Room-server posts and messages with no recoverable path show no route line.

### Send bar

Below every MeshCore composer (channel and DM) a live **`<bytes>/<limit>`** counter shows how much of the packet budget the current draft uses. Counting is **UTF-8 byte-accurate**, not character-based, so emoji and CJK characters cost more than one byte each. Limits are per-context:

| Context | Limit |
|---|---|
| Channel message | 130 bytes |
| Channel message with a scope/region | 120 bytes |
| Direct message | 150 bytes |

The counter appears only once the draft is non-empty, turns **yellow at 90%** of the limit and **red when over**, and the **Send button is disabled while over the limit** (the backend rejects an over-budget send as well).

### Node Info

A dashboard-style view of the connected local companion. It graphs the data collected by the local-telemetry poller (see [Local-Node Telemetry](#local-node-telemetry) below) across 1h / 6h / 24h / 3d / 7d ranges, plus identity (firmware version, build, model), current radio settings, current health, and cumulative counters.

This view is only available when the page is mounted from a per-source URL — the legacy app-shell mount path does not have a `sourceId` and hides the Node Info entry.

### Configuration

Where you change the device's settings:

- **Identity** — Name and advert
- **Location** — Position and advert-location policy
- **Radio** — Frequency, bandwidth, spreading factor, coding rate (now with a preset selector)
- **Telemetry mode** — Which telemetry classes the device emits (see [Telemetry Modes](#telemetry-modes))

## Telemetry

MeshMonitor collects three kinds of telemetry from MeshCore sources, all written into the same `telemetry` table the Meshtastic side uses (just with `mc_*` type names) so the graphing UI works the same way.

### Local-Node Telemetry

A module-level singleton polls every connected companion every `MESHCORE_TELEMETRY_INTERVAL_MS` (default 5 minutes). It calls `GetStats core / radio / packets`, `GetDeviceTime`, and `DeviceQuery` — **none of which transmit on the air** — and writes batched rows stamped with `sourceId` and prefixed `mc_`. tx/rx duty-cycle and packet rates are computed as deltas vs the prior sample.

This drives the [Node Info](#node-info) view.

### Telemetry Modes

You can toggle which telemetry classes the device itself emits over the air:

- **base** — Battery, voltage, uptime
- **loc** — Position
- **env** — Environmental sensors (where supported by the hardware)

Set these from the Configuration view; the device-side flag is persisted on the companion.

### Per-Node Remote Telemetry

Each row in `meshcore_nodes` can opt in to periodic `req_telemetry_sync` requests with a per-node interval. The remote-telemetry scheduler walks every registered manager every `MESHCORE_REMOTE_TELEMETRY_TICK_MS` (default 30s), picks at most one most-overdue eligible node per source, decodes the LPP response, and writes `mc_<lpp-type-name>` rows into the same `telemetry` table.

A global 60-second minimum spacing between any two scheduled mesh ops on the same source is enforced through `MeshCoreManager.lastMeshTxAt`, so future scheduled operations on the same manager (auto-traceroute, periodic adverts, etc.) coordinate against a single field instead of each owning their own throttle.

You configure this from the contact-detail panel in the Node Details view:

1. Open the DM with the target contact
2. Open the contact-detail panel
3. Toggle **Remote telemetry** on
4. Set the **interval** (minutes)
5. Save

The config requires `configuration:write` on the source. Read-only users see the panel with controls disabled and a banner explaining why.

#### On-demand polling

Alongside the scheduled config, the panel has two buttons to pull telemetry from a node right now instead of waiting for its interval:

- **Poll Status** — requests battery / uptime / counters (repeater- and room-server-oriented).
- **Poll Environment (LPP)** — requests a Cayenne-LPP environment reading (companion-oriented).

Both transmit on the mesh, so they share the per-source **60-second mesh-TX gate** — if another scheduled or manual op fired too recently the request is refused with **HTTP 429 and a `Retry-After`**, surfaced as a throttle message on the button. Each button shows a pending state and reports how many telemetry rows were written. On-demand polling requires only **`nodes:read`** on the source (and returns 409 if the source isn't connected).

The composite primary key on `meshcore_nodes` is `(sourceId, publicKey)`, so the same device advertising under two different sources is tracked independently.

## Regions / Scopes

Some MeshCore meshes restrict which flood traffic their repeaters forward. A repeater running `region denyf *` **drops any un-scoped flood packet** — so a message MeshMonitor sends without a scope simply never propagates past those repeaters. The Germany mesh is the most common example.

A **scope** (also called a **region**) is just a named tag — e.g. `germany` or `muenchen` — that MeshMonitor stamps onto outgoing flood traffic. Repeaters configured to allow that region then forward it. The wire value is derived purely from the name (a hash of `#<name>`), so two operators only have to agree on the text of the region name to interoperate; there's no shared key to exchange.

::: warning One global scope on the device
The MeshCore companion firmware exposes only a **single, global flood scope**, not a per-channel one. MeshMonitor owns the per-channel/per-source scope mapping itself and asserts the right scope on the device immediately before each send, serializing those operations per source. If the scope can't be asserted, the send is aborted rather than leaked un-scoped.
:::

### Setting a scope

There are three layers, resolved most-specific-first (**channel scope → source default scope → unscoped**):

- **Per-channel Region / Scope** — each channel's settings has a **Region / Scope** field. Traffic on that channel is stamped with this scope.
- **Per-source default scope** — the MeshCore **Settings** view has a default-scope section backed by the `meshcoreDefaultScope` setting. Channels without their own scope fall back to this, so you can scope a whole source with one value.
- **Unscoped** — leave both blank and traffic goes out with no scope (the legacy behavior).

Channel-settings and the per-message override both offer a region-picker **datalist** drawn from your saved + discovered regions (see below); free typing is still allowed. Region names are normalized (leading `#` stripped; letters, digits, and hyphens kept).

### What gets scoped

Originated flood traffic is scoped end-to-end. That covers channel messages, DM messages, **adverts**, **remote-admin login**, **remote telemetry requests**, and **remote CLI commands**. Operations that are never flood-forwarded — node discovery (zero-hop), local/config-only commands, and direct-routed traffic — are intentionally left alone.

### Discover Regions

In the default-scope section of MeshCore **Settings**, the **Discover Regions** button asks nearby repeaters which regions they serve:

- It runs a **0-hop sweep first** and queries **only the repeaters (and room servers) that answer in direct RF range**, in arrival order — not every repeater you've ever heard.
- If the first sweep finds nothing it **retries once**.
- It distinguishes the two empty cases: **no nearby (0-hop) repeaters were found** vs. **repeaters answered but reported no regions**.

Discovered region names render as chips you can click to fill the scope field, and each chip has a save (**＋**, **✓** once saved) button to add it to the catalog.

::: tip Why 0-hop
A repeater only answers a regions query over a direct route, so MeshMonitor installs a zero-hop path to each responder before asking. A benign `set_out_path` ack-timeout during this step is expected and logged at debug level — it doesn't mean the discovery failed.
:::

### Per-message scope override

Next to the channel compose box is an optional one-off **scope/region override**. It applies to that single message and is **never persisted** to the channel — your next normal send re-asserts the channel/default scope. It defaults to the channel's resolved scope, offers the same discovered/saved-region datalist, and resets when you switch channels. Leave it blank/whitespace to send that one message explicitly unscoped.

### Scope of sent and received messages

Channel and DM messages show a scope line so you can tell which region a message used — on **both** received messages (how it reached you) and your **own sent** messages (which scope it went out on). MeshMonitor recovers the scope by recomputing each of your known region names against the packet (the raw name can't be reversed out of the wire value):

- **🔒 muenchen** — scoped to a region you know; the name is shown.
- **🔒 #a3f2** — scoped, but to a region not in your known set; the raw code is shown as hex.

Un-scoped messages show **no scope line at all** — the absence of a badge is itself the signal that the message flooded without a region.

### Saved regions catalog

The MeshCore **Settings** view has a **Saved regions** section — a catalog of region names (with optional notes) you've saved, so you don't have to retype them. The catalog is **global** (shared across all MeshCore sources, not per-source). Saved regions feed the region-picker datalists on the channel scope field and on the per-message override (the override list is the de-duplicated union of saved + discovered regions). Add regions inline (or via the **＋** on a discovered-region chip) and delete them per-item.

## Remote Administration

::: tip Added in 4.7
The MeshCore Remote-Administration console ships in 4.7 — gated on the new per-source `remote_admin` permission. See [the internal architecture doc](https://github.com/Yeraze/meshmonitor/blob/main/docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md) (`docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md` in the repo) for the protocol-level architecture; this section is the operator-facing summary.
:::

MeshCore's remote-admin protocol is **CLI text sent as an encrypted DM** — the same `PAYLOAD_TYPE_TXT_MSG` packet a chat message uses, distinguished by a single `txt_type` byte (`CliData = 1` vs `Plain = 0`). The remote node dispatches the text into its `CommonCLI::handleCommand` handler and replies with one packet of text. MeshMonitor wraps the wire-level traffic behind two consoles.

### Remote console (per contact)

For any Repeater (advType=2) or Room Server (advType=3) contact in your MeshCore source, the contact-detail panel surfaces a **Remote administration** section. The user with `remote_admin:write` on that source can:

- **Log in** with the node's admin password (or blank for guest access). Optionally tick "Remember this password" — see *Credential store* below.
- **Send arbitrary CLI commands** (e.g. `ver`, `stats`, `neighbors`, `set radio …`) and see the reply inline in the transcript.
- **Click quick-action buttons** that pre-fill the input for the most-common commands. `Reboot` is flagged danger — see *Danger commands* below.
- **Read live stats** in a structured panel (battery, queue, packet counts, air time, last SNR / RSSI) auto-refreshed every 30 s while logged in.
- **Manage the ACL** via a `setperm` form: paste a 64-char hex pubkey, pick **Remove / Guest / ReadWrite / Admin**, click Apply. The built command (`setperm <pubkey> <level>`) lands in the same transcript as free-typed commands.

The console only renders for Repeater / Room Server advTypes since Companion firmware doesn't expose a remote-admin surface. Replies are single-packet (≈130 – 180 byte MTU) and there is no chunking — long output is truncated at the firmware level.

### Local console (Configuration view)

The Configuration tab gets a **Device console** for the locally connected node. Dispatch depends on the firmware:

| Local firmware | Console behavior |
|---|---|
| Repeater / Room Server | Forwards to the device's native serial CLI via `sendRepeaterCommand`. Same command set as a remote Repeater. |
| Companion | A small synthetic interpreter on the server side maps `ver` / `stats [core\|radio\|packets]` / `clock` / `advert` / `help` to existing companion-protocol bridge commands and formats the response as text. Mutating verbs (`set name`, `set radio` …) are intentionally NOT in the synthetic CLI — the existing form fields on the same Configuration tab handle those with proper validation. |

No login flow: the connection is physical (USB serial or direct TCP), so there's no admin password concept. Gated on the existing `configuration:write` permission.

### Credential store

When the user ticks "Remember this password" at login, the plaintext is encrypted with **AES-256-GCM** using a key derived from `SESSION_SECRET` via HKDF and stored in `meshcore_nodes.adminCredential` (added by migration 070). Each envelope includes a 4-byte `kid` fingerprint of the current secret; on subsequent visits the console silently logs in using the saved password if `kid` matches. If `SESSION_SECRET` rotates, the mismatched `kid` triggers a yellow banner asking the user to re-enter the password — never a silent auth-tag failure.

::: warning Capability gating
When `SESSION_SECRET` was auto-generated rather than explicitly configured, the "Remember password" checkbox is disabled with a tooltip explanation. Persisting against an ephemeral key would lose every saved password on every restart, which is worse than re-prompting. Set `SESSION_SECRET=$(openssl rand -hex 32)` in your environment to enable credential persistence.
:::

**Security boundary**: the credential store defends against a DB-file-only exfil (someone grabs `meshmonitor.db` without the host environment). It does **not** defend against a host compromise — anyone running code on the host has `SESSION_SECRET` and the DB. Same posture as the existing channel-PSK storage. The plaintext password **never** leaves the server process: the auto-login route reads the encrypted envelope, decrypts in-process, and calls `loginToNode(pubkey, plaintext)` without echoing the password to the client. A test canary in `meshcoreRoutes.test.ts` walks every audit-emitting login code path and asserts the plaintext is absent from each response body and audit row.

### Danger commands

Destructive verbs matching `/(reboot|erase|clkreboot|factory)/i` are gated by a typed-name confirmation modal: the user must type the contact name (or local device name) exactly to enable the Confirm button. The same regex is mirrored server-side — `POST /admin/cli` and `POST /cli` both reject without `confirm: true` in the body with `code: DANGER_CONFIRM_REQUIRED`. Mirrored deliberately so a script bypassing the modal still gets the prompt-as-requirement.

### Audit log

Every CLI command, login outcome, and credential mutation writes an `audit_log` row through a new `auditMeshcoreEvent` helper. Distinct `action` values per outcome:

| Action | When |
|---|---|
| `meshcore_remote_login` / `_failed` | manual `/admin/login` success / auth failure |
| `meshcore_remote_login_saved` / `_failed` | auto-login via saved credential (failures carry the specific code) |
| `meshcore_remote_cli` / `_failed` / `_blocked` | per-CLI command on a remote node |
| `meshcore_local_cli` / `_failed` / `_blocked` | per-CLI command on the local node |
| `meshcore_credential_forget` | `DELETE /admin/credentials/:pubkey` |

The `details` JSON captures `sourceId`, `publicKey` (where relevant), command text, reply length, and elapsed milliseconds. **The plaintext password never appears in audit details**, verified by the canary test referenced above.

## Path Visualization

The MeshCore map can render **route lines** between your local node and each contact, colored by hop count:

- **Green** — direct (1 hop)
- **Orange** — 2-3 hops
- **Red** — 4+ hops

Toggle path visibility from the map toolbar. Paths are populated by the **Discover Path** button in the contact-detail panel (sends firmware CMD 52) or automatically by the [Auto-Pathfinding](#auto-pathfinding) scheduler. When the firmware responds with path discovery results (push code 0x8D), the route is stored and rendered immediately.

## Position History

The MeshCore map can render a per-node movement trail, mirroring the Meshtastic Position History feature:

- **Show Position History** toggle and a **history length slider** (1h–7d, default 24h) in the map toolbar, persisted per-browser.
- Trails render as a gradient polyline per node, oldest fix to newest.
- **Keep history (days)** — a retention control (default **7 days**) wired to the shared `/api/settings` endpoint; a scheduled hourly sweep prunes fixes older than the configured window.

Points come entirely from existing MeshCore GPS sources — contact adverts and the [remote telemetry](#per-node-remote-telemetry) poll — recording only fixes that actually moved (sub-epsilon jitter and Null Island are dropped), so stationary nodes don't accumulate noise. No firmware changes are involved.

## Neighbor Discovery

Repeaters maintain a neighbor table of other repeaters heard via zero-hop adverts. MeshMonitor can query this table and display the results:

- **Contact-detail panel** — a "Get Neighbours" button appears for repeater contacts. Results show each neighbor's name (resolved from pubkey prefix), SNR, and last-heard time.
- **Map rendering** — neighbor links appear on the map as dashed lines between repeaters.
- **Map Analysis** — the inspector panel in Map Analysis mode includes a MeshCore neighbor links layer with transport-type filtering (RF / UDP / unknown).
- **Database persistence** — neighbor data is stored in `meshcore_neighbor_info` and survives page refreshes.

Neighbor queries require authentication to the repeater (guest or admin login). See [the MeshCore protocol details](/features/meshcore#remote-administration) for auth requirements.

## Active Node Discovery

Beyond passively reading a repeater's neighbor table, MeshMonitor can actively probe the airwaves for nearby MeshCore devices (added in 4.8.3). The MeshCore **Settings** view exposes two buttons:

- **Discover Nearby Nodes** — sweep for any MeshCore node in zero-hop (direct RF) range, matching the mobile app's discovery behaviour. Responders are added/refreshed as contacts.
- **Discover Repeaters** — the same sweep scoped to repeater-class devices.

Discovery is direct-range only (zero-hop) — it surfaces devices you can hear without relaying. MeshMonitor is also **discoverable** in the other direction: it answers inbound discovery requests from peers, so your source shows up when another node runs the same sweep.

## Auto-Pathfinding

The **Automation** view (accessible from the MeshCore page sub-toolbar) provides scheduled path discovery and neighbor collection:

- **Path Discovery** — periodically sends Discover Path requests to all companion contacts to keep route information fresh.
- **Neighbors for Repeaters** — periodically queries the neighbor list from all repeater contacts and persists results to the database for map rendering.
- **Configurable schedule** — set the delay between individual requests (default: 5 minutes) and how often the full cycle repeats (default: every 24 hours).
- **Independent toggles** — enable/disable path discovery and neighbor collection independently.
- **RF-aware throttling** — requests are spaced by the configured interval to avoid flooding the mesh. A global 60-second minimum spacing between any two scheduled mesh operations on the same source is also enforced.

Retrieved neighbor data is automatically resolved (pubkey prefixes mapped to full contact records) and persisted to `meshcore_neighbor_info` for map rendering and the Map Analysis inspector panel.

### Target filtering

By default Auto-Pathfinding processes **every** Companion and Repeater contact each cycle. On a large contact list that spends mesh airtime and cycle time on nodes you may not care about. Enable **Filter target contacts** to narrow which contacts are targeted — it is fully opt-in, so leaving it off keeps the original "everything" behavior. A single filter list covers both sub-features (path discovery still targets companions, neighbor queries still target repeaters).

The filter combines several optional controls, each independently toggleable:

- **Limit to selected contacts** — a searchable checklist (with Select All / Deselect All and a running count) of the specific contacts to include.
- **Filter by name (regex)** — include contacts whose name matches a regular expression.
- **Limit by last heard** — only contacts heard within the last N hours.
- **Limit by hop range** — only contacts whose cached route hop-count falls within a min–max range. Contacts with an unknown route (i.e. the next send would flood) are excluded while this is on.
- **Limit by signal quality** — only contacts at or above a minimum RSSI (dBm) and/or SNR (dB). Leave a threshold at its floor value to ignore it.

The controls combine intuitively: **last heard**, **hop range** and **signal quality** first *narrow* the pool of contacts, then the **selected-contacts** list and **name regex** *include* any contact matching either of them. If you turn the filter on without configuring a selected-contacts list or a name regex, every contact surviving the narrowing filters is targeted. A live **matching targets** preview shows how many contacts the current settings would target, updating as you edit. All settings are per-source and saved from the shared MeshCore Automations save bar.

## Auto-Announce

The **Automation** view also hosts a per-source Auto-Announce that periodically broadcasts a status message to one or more MeshCore channels:

- **Scheduling** — choose either a simple interval (every N hours, 1–168) or a standard 5-field cron expression. An optional *announce on connection* fires a single message whenever the source reconnects.
- **Message template** — the message body supports token expansion. Available tokens: `{VERSION}`, `{DURATION}`, `{CONTACTCOUNT}`, `{COMPANIONCOUNT}`, `{REPEATERCOUNT}`, `{ROOMCOUNT}`, `{NODE_NAME}`, `{NODE_ID}`. A live preview shows the rendered text, and clickable token buttons insert at the cursor.
- **Target channels** — the announcement is broadcast to every selected channel each run.
- **Optional advert burst** — fire a MeshCore advert N seconds (0–600) after each announcement so neighbours rediscover the node.
- **Send Now** — manually fire the configured announcement for testing without waiting for the schedule.

## Auto-Responder

Auto-Responder matches incoming messages against operator-defined patterns and replies automatically:

- **Per-trigger pattern** — match incoming text via a regular expression, with per-channel filtering, DM listening, and a per-sender cooldown to avoid loops.
- **Per-trigger pre-send delay** — wait a configurable number of seconds (0–120, `0` = immediate) after a match before replying, so a relaying repeater can finish its own transmission before your reply floods. Mirrors the Auto-Acknowledge pre-send delay; the wait applies once per fire, ahead of both text and script responses.
- **Two actions** — reply with a **text response** (same token expansion as Auto-Announce) or **run a script** (with token-expanded script args). Script execution reuses the shared script runner, with `MESHCORE_*` environment variables injected so a script can branch on which stack invoked it.
- **Reply scope/region** — choose which region the reply floods to: **Inherit** the channel/source default, **Match the triggering message's scope** (answer back on the same region it arrived on), send **Unscoped**, or pick **a specific region**. This mirrors the MeshCore scope control in the [Automation Engine](/features/automation-engine#actions).

## Timer Triggers

Timer Triggers schedule recurring actions independent of incoming traffic:

- **Per-trigger schedule** — each trigger runs on its own cron or interval.
- **Three actions** — send a **text** message (token expansion supported) to a channel or contact, fire a MeshCore **advert**, or **run a script** (token-expanded args).
- **Last-run telemetry** — the UI surfaces the last fire time and outcome per trigger.

## Automated Channel-Send Auto-Retry

MeshCore channel (broadcast) messages are unacked, fire-and-forget floods — unlike a direct message, there is no firmware ACK to confirm delivery. MeshMonitor instead listens for nearby repeaters re-flooding your own packet (the "heard repeaters" signal, see [Message route line](#message-route-line)). When **no** repeater is heard, the message likely reached no one.

The **MeshCore Messaging** section of global **Settings** hosts an opt-in toggle, **Auto-retry automated MeshCore channel sends** (default **off**). When enabled:

- An **automated** channel send that hears **zero** repeaters within **30 seconds** is resent **exactly once**.
- It applies only to automated senders: the [Automation Engine](/features/automation-engine) `Send message` action, Auto-Acknowledge, the [Auto-Responder](#auto-responder), [Auto-Announce](#auto-announce), and [Timer Triggers](#timer-triggers).
- **User-initiated sends are never retried** — a message you type into the send bar goes out once regardless of this setting.
- It is **one-shot**: the resend is never itself retried, so at most one extra transmission ever occurs per logical send.
- The resend does **not** create a second message bubble and does **not** re-enter the automation event bus, so it can never trigger a fresh automation.

This is **distinct from the direct-message retry**, which is always on and follows the firmware's own same-path/flood ACK cadence. Because a channel send has no delivery ACK, the retry can only guess from the heard-repeater signal — so with this enabled you may occasionally see a duplicate on the mesh if a late echo arrives right around the 30-second mark. Leave it off if duplicates are unacceptable for your deployment.

## Room Servers

Room servers (advType=3) are BBS-style MeshCore nodes that store posts and push-sync them to connected clients. The **Rooms** view in the MeshCore page lists discovered room servers and provides:

- **Login / auto-login** — enter a password to join a room, or save credentials for automatic login on future visits. Login retries up to 3 times automatically to handle RF packet loss.
- **Post stream** — read and send posts in the room's message board.
- **Auto-sync** — configure periodic re-login to fetch new posts on a schedule (1h to 24h intervals). The auto-sync setting is persisted per-room and loaded when the room is selected.
- **Credential persistence** — saved room passwords are AES-256-GCM encrypted via the same credential store used for remote admin passwords.

## Multi-Source Dashboard

MeshCore sources appear as styled cards in the dashboard sidebar — same visual language as Meshtastic sources, with a MeshCore logo and per-source status.

The aggregate dashboard map and `/api/nodes` endpoint enumerate every connected MeshCore manager and include contacts that have valid `(latitude, longitude)` (zeros are rejected). Each contact gets a synthetic `nodeId` of `mc:<sourceId>:<pubkeyPrefix>` so cross-source duplicates don't collide on React keys, and `getNodeLatLng` resolves either the flat `{latitude, longitude}` shape or the nested `position` shape.

## Permissions

In 4.5 the global `meshcore` permission is gone. Migration 058 expanded every legacy `meshcore` grant into the per-source **sourcey** resource set, matching how Meshtastic resources are scoped:

| Resource | Scope | Description |
|---|---|---|
| `connection` | Per-source | Connect/disconnect, status |
| `configuration` | Per-source | Identity, radio, telemetry mode, location, per-node remote-telemetry config |
| `nodes` | Per-source | Node list, contacts, map data |
| `messages` | Per-source | Read and send DMs / channel messages |

Anonymous users can view MeshCore data on sources where the anonymous user has the relevant `*:read` permission. Sending messages, changing config, and toggling remote telemetry all require `configuration:write` (or `messages:write` for sends).

### UI Permission Gating

Write controls in the MeshCore UI are now **disabled in place** for users without the right permission — not just rejected on submit. The Configuration view, Channels view, DM compose box, and remote-telemetry toggle all dim themselves and surface an explanatory banner, mirroring how the Meshtastic side handles permission gating.

See [Per-Source Permissions](/features/per-source-permissions) for the full model.

## Radio Configuration

Use the Configuration view's **Preset** dropdown to pick from the official MeshCore preset list, or choose **Custom** to manually set:

- **Frequency** (100-1000 MHz)
- **Bandwidth** (125, 250, 500 kHz)
- **Spreading Factor** (5-12)
- **Coding Rate** (5-8)

::: danger
Changing radio parameters will disconnect you from nodes using different settings. Make sure all nodes in your mesh use the same radio configuration.
:::

Saved radio params are now persisted authoritatively: the backend propagates device-side errors back instead of silently returning success, and the manager optimistically updates `localNode.radio*` then refreshes from the device so the next snapshot reflects the real device state.

## Packet Monitor

The MeshCore page includes a **Packet Monitor** tab (sub-toolbar: **Packets**) that surfaces raw OTA frames captured from the companion's `LogRxData` (0x88) push. This is the MeshCore analogue of the Meshtastic [Packet Monitor](/features/packet-monitor).

Capture is opt-in. The view exposes an **Enable** toggle and retention controls (max packet count, max age in hours) inline; no separate settings page is required. Once enabled, the monitor shows:

- **Timestamp** — when the packet was received
- **Route type** — direct / flood / etc. (decoded from the OTA frame)
- **Payload type** — message type in human-readable form where known, raw hex otherwise
- **Relay chain** — the relay-hash sequence from the packet
- **Hop count**, **SNR**, and **RSSI**
- **Raw hex dump** — the full OTA frame, accessible via the detail modal

New packets stream in live over the existing Socket.io connection (no separate subscription is needed). The view can be **paused** and **exported** (`.jsonl` format) for offline analysis. Filtering by payload type and route type narrows the display.

The `packetmonitor:write` permission is required to clear the log; `settings:write` is required to toggle capture on/off and adjust retention.

## Still Early

MeshCore support has come a long way since 4.5 — remote administration, path visualization, neighbor discovery, auto-pathfinding, room servers, and a mobile-responsive layout are all shipping. But there are still gaps:

Known gaps and limitations:

- **Repeater / Room Server per-source parity** is behind Companion. Repeater is selectable as a USB device type, but features like local telemetry polling and telemetry-mode toggles require a Companion connection on the source side.
- **Notifications** for MeshCore events are minimal — apprise/push surfaces aren't yet first-class.
- **Companion-only telemetry mode toggles** — Repeaters report what they report; the base/loc/env toggle is meaningful on Companions.

The roadmap is incremental: keep landing MeshCore features each release, keep aligning the UI vocabulary with Meshtastic, and gradually close the remaining parity gap.

## Troubleshooting

### MeshCore source can't be added or connection fails
- For **USB** sources: Verify the serial port is accessible inside the container (check `devices:` mapping in docker-compose). The entrypoint auto-grants the `node` user access to mapped tty groups; if you mounted a device after the container started, restart it.
- For **TCP** sources: Verify the host is reachable from inside the container (the MeshMonitor process resolves it, not your browser). Use a LAN IP rather than `localhost`/`127.0.0.1`, or `host.docker.internal` when the device shares a host with MeshMonitor. Confirm the port (default `4403`) is open and the proxy/firmware is listening.
- Check MeshMonitor logs for `[MeshCore]` entries for detailed error messages.

### Runtime-added MeshCore source idle until restart
This is fixed in 4.5 — source create/update/delete/connect/disconnect endpoints all wire MeshCore into the per-source registry. If you're seeing this on an earlier 4.x version, restart the container as a workaround and upgrade.

### No nodes appearing
- Verify your MeshCore device is properly flashed and operating.
- Check that the radio frequency and parameters match other nodes in your mesh.
- Try sending an advert to announce your presence on the network.

### Radio parameter changes "revert" on save
Earlier 4.x versions had a hook-dependency bug where Phase 3 push events overwrote staged radio/location edits before Save fired. Fixed in 4.5.

## Reporting Issues

If you hit a problem, please [open an issue](https://github.com/yeraze/meshmonitor/issues/new) with:

- Your MeshCore device type and firmware version
- MeshMonitor version
- Relevant log output (look for `[MeshCore]` prefixed messages)
- Steps to reproduce the issue
