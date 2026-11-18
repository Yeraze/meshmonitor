# Use the MeshCore page

Each MeshCore source has its own page: click the source in the dashboard sidebar. The page's sidebar lists **Map**, **Channels**, **Rooms**, **Node Details**, **Telemetry**, **Packet Monitor**, **Node Info**, **Device Configuration**, **Automations**, **Notifications**, **Settings** and **Security**. A tab shows only when you hold the read permission its data needs on that source.

This page covers the day-to-day views: the map, channels and direct messages, contacts, reactions, rooms, the Packet Monitor and notifications. Device settings and telemetry are on [Configure a MeshCore source](/features/meshcore-configuration).

## Map {#nodes}

The **Map** tab (called **Nodes** before 4.17.2, and named **Map** on every source type) holds a map of every contact with valid coordinates, plus a styled row list aligned to the same visual vocabulary as the Meshtastic nodes view. The map honours zoom-based label visibility and falls through to the dashboard map when the source is selected at the dashboard level. A search/filter bar lets you quickly find contacts by name or public key prefix.

The list header has two rows: search and filters on the first, sort and view controls on the second.

![MeshCore Nodes list header with two rows](/images/features/5936-meshcore-nodes-header.png)

**Live packet traffic** in the map's Features panel shows packets as your companion hears them, as dots flying from the last hop (or the sender) to your node. It works with the Packet Monitor log off. See [Live packet traffic](/features/maps#live-packet-traffic).

**Ducting**, in the same panel, shades where the lower air bends radio further than usual, from a NOAA forecast. It appears once an admin turns the overlay on, and the forecast covers this source's contacts. See [Tropospheric ducting overlay](/features/maps#tropospheric-ducting-overlay).

![Ducting overlay on a MeshCore source's map](/images/features/5972-meshcore-ducting.png)

On **mobile**, the node list and the map share the screen, and the map shows first, as on Meshtastic. **Node list** above the map opens the list, and the collapse button in the list header goes back to the map. On desktop, a collapse button collapses the list to a thin sidebar (preference persisted to `localStorage`).

## Channels

The device's channels with the most recent message stream. Channel-message senders are now extracted from the `"Name: body"` prefix that MeshCore embeds in the text body, so the sender column and the message body are no longer collapsed into one string.

**Message time and order** — direct and channel messages show, and sort by, the time MeshMonitor received them. Every MeshCore node keeps its own clock and nothing keeps them in step, so a sender whose clock is a few minutes off would otherwise land out of sequence. When the sender's clock differs from receipt time by 5 seconds or more, the gap shows in parentheses after the time, as receipt time minus sender time: `8:00:00 PM (+15m30s)` means the sender's clock read 7:44:30 PM, and `(-15m30s)` means it read 8:15:30 PM. Hover the gap for a tooltip. No gap shows when the message carries no sender time, or when the sender's time is more than a day from receipt (an unset or broken clock). Unread markers use receipt time too. The same rules apply to messages from Companion, Repeater and MQTT sources, to the MQTT source's channel list, and to MeshCore messages on [Unified Messages](/features/multi-source), where a message heard by several sources shows the earliest receipt time.

Room posts are the exception. A room server sends its backlog when you log in, so the receipt time of a replayed post is the login time. Room posts keep the sender's time and order, and show no gap.

![MeshCore channel messages showing receipt time and the sender's clock offset](/images/features/5973-meshcore-receipt-time.png)

**Unread indicators** — channels with messages newer than the last time you opened them show an unread dot and a **bold name** in the channel list. A header badge counts how many channels currently have unread messages, and an optional **"unread first"** sort toggle (persisted) floats those channels to the top. Opening a channel marks it read up to the newest visible message. Read markers are saved **on the server, per user and per source**, so they follow your account to another browser or device. The browser keeps a copy in `localStorage` so the list paints at once, and falls back to that copy when you are signed out.

**Mute** — a signed-in user can mute a channel with the bell button beside the message box. A muted channel shows no unread dot and does not count in the header badge. The mute is yours alone, on this source.

**Protocol stripe** — each message carries a thin left border in the MeshCore colour (orange), the same stripe Unified Messages uses to tell MeshCore from Meshtastic and Reticulum. See [Source picker](/features/multi-source#source-picker).

**Reply** — received channel messages carry a **Reply** button. Clicking it prefills the composer with the sender's MeshCore mention (`@[Sender]: `) and sends the reply **on the scope the original message arrived on**, so a threaded answer stays in the same region. The button appears only on incoming channel messages — not on your own messages, and not in 1:1 DMs.

**Heard repeaters** — outgoing channel posts show a **heard badge** (a signal icon and a count) with an expandable list of the repeaters that re-flooded the message and the SNR each was heard at. This is populated best-effort by **self-echo correlation**: when a repeater re-floods your `GRP_TXT` packet, MeshMonitor hears it inbound and attributes the relay hashes to the most recent matching channel send within a ~30-second window. Channel sends carry no protocol ACK, so this is a heuristic, not a delivery receipt. Correlation runs on the raw inbound packet before the opt-in packet-monitor gate, so it works **regardless of whether the packet monitor is enabled**. Relay hashes are resolved to repeater names where known; otherwise the raw hash is shown.

Each copy you hear back counts on its own, so when two repeaters both relay a post, both appear. Each repeater also shows its **hop count**: how many relays sat between you and it (a repeater that heard you directly shows `0 hops`; one that only heard another repeater's copy shows `1 hop`). The list is sorted by hops, then SNR. The SNR shown is the strongest signal at which MeshMonitor heard that repeater directly; a repeater seen only further back in a relay chain shows no SNR. Posts sent before this feature have no hop counts and sort last.

**Sent to radio** — a channel post that no repeater has been heard relaying shows **Sent to radio** in place of the badge. It means your radio accepted the message for sending, and no more. A MeshCore radio does not tell MeshMonitor when it transmits, so the mark does not prove the message went out on the air, and it says nothing about who heard it. If a repeater is heard relaying the post, the mark gives way to the heard badge. A send that the radio refuses, or that receive-only mode blocks, shows an error and adds no message at all. Click the mark to open [Delivery Details](/features/delivery-diagnostics).

**Direct messages and room posts** — these carry a real acknowledgement, so your own message moves through up to three marks:

| Mark | Direct message | Room post |
|---|---|---|
| **Sent to radio** | Your radio accepted it. MeshMonitor is waiting for the recipient's radio to acknowledge it. | Your radio accepted it. MeshMonitor is waiting for the room server to acknowledge it. |
| Double tick | The recipient's radio acknowledged it. | The room server acknowledged it, so it holds the post. This does not show which members have fetched or read it. |
| Warning icon (**Not confirmed**) | No acknowledgement after all retries (two on the known path, one flood). | No acknowledgement in the time the radio estimated. MeshMonitor does not resend room posts. |

**Not confirmed** is not proof of loss: the message may have arrived while the acknowledgement was lost on the way back. A room server also sends none when you are not logged in or have read-only access. An acknowledgement that arrives late still turns the mark into the double tick. As with channel posts, no mark says the radio transmitted, and a send the radio refuses adds no message. The marks survive a page reload and a restart. One limit: if MeshMonitor restarts or the radio disconnects while a message is still waiting, the wait is lost, and the message keeps **Sent to radio** with a tooltip saying no acknowledgement is on record.

**Resend** — if no repeater was heard relaying one of your channel posts, a **Resend** button appears next to it 30 seconds after you sent it. Click it and confirm to send the same packet again. The resend carries the original text and the original timestamp, so a repeater that already relayed the first copy drops the resend, and recipients never see the message twice. The resend adds no new message to the stream, and it fires no automations or notifications. If a repeater relays the resend, the heard badge appears on the original message.

Limits, to protect the mesh:

- At most **3 resends** per message.
- **30 seconds** between the send and the first resend, and between resends.
- Only messages under **1 hour** old.
- The button stays hidden while the automatic channel retry is still waiting on that message, and on messages sent before MeshMonitor stored send timestamps (older than this feature).
- You need **Messages: write** on the source, and the button is hidden while the source is in receive-only mode.

The resend count lives in the database, so restarting MeshMonitor does not reset it. Direct messages don't get this button: they already retry on their own until the recipient acknowledges them.

**Required repeaters.** By default any repeater echo clears the Resend button. In the source's **Settings**, **Required repeaters** lets you pick the direct repeaters (heard on a zero-hop path) that must relay your message. **Match mode** sets the rule: **Any** stops the resend once one of them relays, **All** waits for every one. Leave the list empty for the default. A saved repeater that is no longer direct stays on the list and shows "no longer direct". Sent direct messages show the repeaters heard relaying them in the same heard-by bubble.

**Auto Resend.** Under the list, **Auto Resend until the required repeaters hear it** makes MeshMonitor click Resend for you. It is off by default and needs at least one required repeater. When it is on, every channel message and direct message this source sends, including automated ones, is resent until the match mode is met. It runs on the server, so it works with no browser open, and it uses the same limits as the button:

- A resend goes out 30 seconds after the send, then 30 seconds after each resend.
- At most **3 resends** per message, counting any you made by hand.
- Only messages under **1 hour** old. A direct message the recipient acknowledged is never resent.

Each resend is another flood, so turn it on only where a required repeater often misses your messages, for example several repeaters sharing one tower. If a message uses all 3 resends and the rule is still unmet, Auto Resend pauses for that channel or contact for an hour and logs a warning; manual Resend still works. That usually means the list is wrong: a repeater out of range, removed from your contacts, or sharing a hash prefix with another. Pending resends stop when the radio disconnects; after a reconnect or restart MeshMonitor picks up messages from the last hour, and the stored count means no message gets more than 3. When Auto Resend is on, it replaces the one-shot automatic channel retry for this source.

## Channel order

The Channels page has a **Sort channels by** dropdown with five choices: **Device order**, **Channel name**, **Last message**, **Message count** and **Custom**. **Last message** puts the most recently active channel first and shows how long ago each channel's last message arrived. **Message count** puts the busiest channel first. Channels with no messages sink to the bottom in both. Pick **Custom** and click **Sort** to drag channels (or use the arrows) into the order you want. MeshMonitor saves the sort choice and the custom order in your browser, per source. This changes only how MeshMonitor lists the channels. The slots on the device stay as they are.

### Reordering channel slots on the companion

To change the slots stored on the device, open the source's **Device Configuration** tab, go to **Channels**, and click **Reorder slots on device**. Drag channels into the order you want, then click **Save order to device**.

- MeshMonitor packs channels into slots 1, 2, 3 and so on, which closes empty slots. Public stays in slot 0.
- It writes each slot over the serial or TCP link and reads it back to check it. It sends nothing over the radio. Keep the device connected until it finishes.
- If a write fails, MeshMonitor writes the original layout back. If it cannot confirm the undo, it tells you to reconnect the device and run the reorder again.
- Message history, unread markers, scopes, per-channel permissions, and the auto-ack, auto-announce, auto-responder and timer settings follow each channel to its new slot. A channel that moves to slot 8 or higher loses its per-channel permission grants, because those slots have none.
- Apps connected through the Virtual Node disconnect, so they reload the new channel list.
- Automations that name a raw channel number are not changed. MeshMonitor lists them so you can check that they still point at the right channel.

## Node Details

Per-contact DM view (renamed from "Direct Messages" to reflect that it also surfaces node details, not just DMs) with a **contact-detail panel** that mirrors the Meshtastic NodeDetailsBlock. It surfaces:

- Contact name and type (companion / repeater / room server)
- Hops away (`pathLen`)
- RSSI and SNR
- Last heard and last advert
- Position (if known). A note under the Position card says when a [location override](#contact-location-override) is in use.
- **Show on Map** button under the Position card — opens the Nodes map on this node, zooms in and opens its popup. It shows only when the map would draw the node, so it is hidden for a node with no position, a 0/0 fix, an ignored or blocked node, or a node hidden by **Hide nodes without a current position advert**. Works on Companion and Repeater sources.
- Full public key
- **Discover Path** button — triggers firmware CMD 52 to establish/refresh the route to a companion contact. The button then counts down while it waits for the reply (20 to 60 seconds, from the radio's own estimate) and ends with **Path updated** and the hop count, or **No response from** the contact. The countdown sends nothing and never retries.
- **Trace Path** button — sends one trace along the contact's stored path and lists the SNR at each hop. It shows only when the contact has a known path of at least one hop. MeshMonitor waits 8 to 60 seconds for the reply, as the radio suggests, and never retries a trace. With **Auto return path** ticked (the default, saved per browser) the trace comes back along the same route, so you get SNR in both directions: it loops through a repeater or room server, and turns at the last repeater for a companion. The return leg costs about twice the airtime. Results also feed [Trace SNR History](/features/meshcore-paths#trace-snr-history).
- **Define Path** editor — manually set the route to a contact when you already know the relay hops, instead of probing for it. Add hops in order and pick the per-hop **hash width** (1, 2, or 3 bytes) — the selector is pre-filled from the current path, and changing the width clears the hop list since the encoding differs. The hop count is capped at 63. Use this when Discover Path can't reach the contact but you know the topology.
- **Delivery status** — your own DMs show **Sent to radio**, a double tick, or **Not confirmed** (see the table under [Channels](#channels))

Discover Path and the other action buttons need **Nodes: write** on the source, and a Companion source. Trace Path needs **Traceroute: write** instead, because it sends a packet.

The star in the panel header, and the one on each row of the Nodes list, toggles a contact's **favorite**. It needs **Nodes: write** and works for every contact type. The favorite syncs to the firmware's favourite bit on
the device, in both directions. MeshMonitor is the source of truth: to
un-favourite a contact, do it in MeshMonitor rather than on the device.

### Contact location override {#contact-location-override}

Click **Override location** in the contact's details to pin the contact to a position you choose. The map, the node list and the other maps then use that position in place of the one in its adverts. It needs **Nodes: write** on the source.

- The override lives in MeshMonitor only. MeshMonitor sends nothing to the radio, so it works for Companion and Repeater sources, and while the source is disconnected.
- A new advert does not move a pinned contact or clear the override.
- Mark the override private to show it only to signed-in users who hold the **Private Positions** permission on the source. Everyone else sees the advertised position.
- Cross-source links, the Coverage Report and the other features that read a contact's position use the override too.

It matches the location override on Meshtastic nodes.

You can also remove a contact from the radio, or export it as a `meshcore://` URL to share. The Import dialog in the node list on the **Map** tab takes a pasted `meshcore://` URL, a contact token or a hex advert blob.

Contact names in messages are **clickable** — clicking a name navigates directly to that contact's DM thread. Messages containing **@YourName** are visually highlighted.

The panel is collapsible with state persisted to localStorage.

The **per-node remote-telemetry config** panel hangs off the contact-detail panel (see [Per-Node Remote Telemetry](/features/meshcore-configuration#per-node-remote-telemetry)).

::: warning Repeaters have no DM composer
MeshCore repeaters (`advType=2`) can't hold a conversation, so they no longer expose a message composer. The message button is hidden on repeater rows, and selecting a repeater shows its node detail and telemetry/graphs instead of an (empty) conversation pane. The repeater stays listed in the contact sidebar — only the chat surface is dropped. The Meshtastic side does the same for nodes flagged unmessagable.
:::

## Message route line

Received channel and DM messages show a route line beneath the body, derived from the packet's relay path:

- **direct** (with a pin icon) — heard with zero hops (direct RF). The SNR and RSSI of that link follow it.
- **N hops** and the chain **a3 → 7f → 02** (with a route icon) — relayed; the chain lists each relay's hash in order.

**Clicking the hash chain** opens a route-detail popup with the message's reception details (sender, time, hops, scope, text) and the route expanded per hop into **repeater / room-server names** from the contact list. Only relay infrastructure ever appears in a MeshCore path — each forwarder appends the leading bytes of its public key at the hash width the original sender chose (1–3 bytes) — so matching is limited to those contacts. Unknown hashes stay as raw hex; when several repeaters share a hash prefix, the popup best-guesses the one closest to the neighbouring hops' positions and labels it as such.

When **every** relay hop resolves to a contact with a known position, the popup also shows a **Packet flow** mini map: a dashed line tracing the packet geospatially across the relays, each hop marked and labeled (`#1 Hilltop`, `#2 Downtown`, …). The sender and your local node are added as endpoints when their positions are known. If any hop is unknown or unpositioned the map is omitted entirely — a partial line would misrepresent the path.

**Naming hops from other sources.** When a relay hash matches none of this source's contacts, MeshMonitor can look it up in the MeshCore nodes of other sources you can read, including MQTT feeds. Turn it on with **Use other sources to resolve unknown hops** under **Settings → MeshCore Messaging**. It is off by default. It changes only what you see: nothing goes over the air.

- Your own contacts always win. Other sources fill in only hops with no match of your own.
- A single match reads `Name (via Source)`. When several nodes share the hash, the popup shows the nearest as a guess, such as `Name? (via Source, 3 candidates)`, and lists all candidates, nearest first. A guess never appears on the Packet flow map.
- A node from a device-backed source counts as soon as that source knows it. A node from an MQTT feed counts only after its signed advert checks out. MeshMonitor checks MQTT adverts only while this setting is on, so each MQTT node becomes usable when it sends its next advert.
- You see only nodes from sources you can read. A private or hidden position never ranks a guess for you.

Room-server posts and messages with no recoverable path show no route line.

## Send bar

Below every MeshCore composer (channel and DM) a live **`<bytes>/<limit>`** counter shows how much of the packet budget the current draft uses. Counting is **UTF-8 byte-accurate**, not character-based, so emoji and CJK characters cost more than one byte each. Limits are per-context:

| Context | Limit |
|---|---|
| Channel message | 160 bytes minus your node name and 2 (127 for the longest name) |
| Direct message | 160 bytes |

The counter appears only once the draft is non-empty, turns **yellow at 90%** of the limit and **red when over**, and the **Send button is disabled while over the limit** (the backend rejects an over-budget send as well).

## Contact tokens (MeshCore One) {#contact-tokens}

MeshCore One shares a contact inside a message as a token shaped like `<PUBKEYHEX:type:name>`. MeshMonitor reads and writes the same token.

- **Import.** A token in a channel message, direct message or room post gets an **Import contact** button. It opens a dialog with the name, type and public key. **Import** adds the contact to the radio. The **Nodes** view Import dialog also accepts a token. MeshMonitor sends nothing over the air for an import.
- **Export.** The **+** menu in the composer has **Share contact** (pick a contact by name or key) and **Share my contact info**. The inserted text counts toward the byte limit.
- **Rules.** Types 1 to 3 only (companion, repeater, room server) and a 64-character hex key. A message can hold several tokens. If MeshMonitor already knows the contact, its stored data wins over the unsigned token.
- **Access.** Import needs a connected Companion source and `nodes:write` on it. It reuses the contact-list safeguards: the full-table confirm, favourite protection and the "already on radio" check.

## Send under another name (API) {#api-sender-names}

An API caller can send a channel message under a name of its own (`senderName` on the send endpoints, see the [REST API](https://github.com/Yeraze/meshmonitor/blob/main/docs/api/REST_API.md#send-under-another-name)). This is off by default and needs a source admin to set it up.

**Setup.** Open **Device Configuration, API sender names** on a companion source. Turn on *Allow API callers to send under these names* and list up to 16 names, one per line. Saving needs `configuration:write` on the source. Each name is 1 to 31 bytes, with no `:`, no control characters and no leading `#`.

**What it sends.** MeshMonitor builds the channel packet itself and hands it to the radio as a raw packet, so the name in the message is the name you chose. The radio's own name is not used.

- Needs companion firmware **1.16 or later**. Older firmware answers `FIRMWARE_UNSUPPORTED`.
- Needs **client repeat off** on the companion. With it on, the radio would send its own raw packet a second time, so MeshMonitor refuses.
- **Scope** works as for a normal send: a per-message scope, else the channel's scope, else the source default, else the node's own default region.
- The text limit is **5 bytes lower** than a normal channel send: 155 minus the name's bytes minus 2.
- The message shows once, with a **Sent as `<name>`** line on the bubble. The radio's own copy of the packet is dropped, so Auto-Acknowledge, Auto-Responder, Forwarding and notifications never answer it. On a second source on the same channel the message counts as ours for the next 30 minutes, so nothing there answers it either.
- **Resend** goes out raw under the same name and the same time stamp. It is refused if the name was removed from the list or the feature was turned off.
- Receive-only mode blocks it like any other send.

::: warning Impersonation
MeshCore does not prove who sent a channel message. Anyone with write access to the channel, on a source that allows a name, can post as that name. Receivers, MeshCore apps and MeshMonitor's own block list cannot tell the difference. List only names you want your API callers to use. Every send is in the audit log (`meshcore_message_sent_as`, no message text), and so is each list change (`meshcore_sender_names_updated`).
:::

## Reactions

MeshMonitor reads emoji reactions sent by [MeshCore One](https://github.com/Avi0n/MeshCoreOne) (1.4.1 and later) and meshcore-open. MeshCore has no reaction packet: these apps send a short text message that names the target by a hash, so without this support a reaction shows as a line like `@[Alice]👍` followed by eight odd characters.

- A reaction shows as a **chip** under the message it answers. The chip carries a count when more than one node sent the same emoji; hover it for the names.
- When this source never heard the target message, the reaction shows as one dim line: *"Bob reacted 👍 to a message not seen here"*. Hover it for the original text. If the target arrives later, the line turns into a chip.
- A reaction is not a message. It does not mark a channel or DM unread, raise a mention alert, or trigger Auto-Responder or Forwarding. It fires an automation only when that rule has **Also fire on MeshCore reactions** ticked (see [Automation Engine](/features/automation-engine)).
- Reactions are matched per source. A reaction heard on one source does not attach to a message only another source heard.
- **Unified Messages** shows the same chips on the merged message. A reaction heard on several sources counts once. You see only what the sources you can read have matched, and chips there are read-only: send reactions from the source's own MeshCore page.

  ![Unified Messages with MeshCore reactions](/images/features/5763-unified-meshcore-reactions.png)

- **CSV export** leaves reactions out unless you tick **Include emoji reactions**. A reaction row has `reaction` = 1 and `reply_to_id` = the id of the message it answers.
- **Search** leaves reactions out.
- To **send** a reaction, use the react button on a message and pick an emoji, or click a chip another node left to add the same one. Your own reaction shows with an accent border. MeshMonitor sends the MeshCore One format.
- You can send each emoji once per message. A reaction is never resent, and there is no way to take one back (MeshCore One has none either).
- You cannot react to a room post, to another reaction, or to a message stored before reactions were supported.

![MeshCore reaction chips under a message](/images/features/5761-meshcore-reaction-chips.png)

![Reaction picker](/images/features/5762-meshcore-react-picker.png)

Three switches sit under **MeshCore → Settings → Reactions**:

![MeshCore reaction settings](/images/features/5762-meshcore-react-settings.png)

| Setting | Scope | Default | Effect |
|---|---|---|---|
| Show MeshCore reactions | This source | On | Off stores and shows reactions as plain text, as before. |
| Auto-Acknowledge may answer reactions | All MeshCore sources | Off | On lets a reaction that matches your Auto-Acknowledge rules trigger a reply. |
| Send reactions from MeshMonitor | This source | On | Off hides the react button, makes the API refuse, and makes automations skip their reaction. |

The Auto-Acknowledge switch covers the built-in Auto-Acknowledge only. It has no effect on automations.

::: warning Airtime
A reaction is one tap for the sender. With the second switch on, each one can trigger an Auto-Acknowledge reply on the air. Leave it off on busy channels.

Each reaction you send is one short packet. On a channel, every repeater in range sends it again. Sends share the normal message rate limit, and [receive-only mode](/features/meshcore-receive-only) blocks them.
:::

## Node Info

A dashboard-style view of the connected local companion or repeater. It graphs the data collected by the local-telemetry poller (see [Local-Node Telemetry](/features/meshcore-configuration#local-node-telemetry)) across 1h / 6h / 24h / 3d / 7d ranges, plus identity (firmware version, build, model), current radio settings, current health, and cumulative counters.

This view is only available when the page is mounted from a per-source URL — the legacy app-shell mount path does not have a `sourceId` and hides the Node Info entry.

## Position History

The MeshCore map can render a per-node movement trail, mirroring the Meshtastic Position History feature:

- **Show Position History** toggle and a **history length slider** (1h–7d, default 24h) in the map's **Map controls** panel, persisted per-browser.
- Trails render as a gradient polyline per node, oldest fix to newest.
- **Keep history (days)** — a retention control (default **7 days**) wired to the shared `/api/settings` endpoint; a scheduled hourly sweep prunes fixes older than the configured window.

Points come entirely from existing MeshCore GPS sources — contact adverts and the [remote telemetry](/features/meshcore-configuration#per-node-remote-telemetry) poll — recording only fixes that actually moved (sub-epsilon jitter and Null Island are dropped), so stationary nodes don't accumulate noise. No firmware changes are involved.

## Ignore and Block

MeshCore firmware has no block or mute, so MeshMonitor filters messages in the server. You can filter by node or by text pattern. Each entry has one of two modes:

| Mode | What happens |
|---|---|
| **Ignore** | MeshMonitor stores the message but does nothing else with it. It sends no notification and runs no automation, auto-ack or auto-responder. It does not forward the message or relay it to Virtual Node apps. The message list folds a run of ignored messages into one row, such as "3 ignored messages", that you can expand. |
| **Block** | MeshMonitor drops the message when it arrives and never stores it. |

If a message matches both an Ignore and a Block entry, Block wins.

### Ignoring nodes

Open a contact's detail panel in the direct messages view and use the **Ignore / Block** row. Pick **Ignore** or **Block**, or remove the entry. Block asks you to confirm first.

The **Ignored and blocked nodes** section in the MeshCore source's **Settings** lists every entry with its mode, hit count and last hit. You can remove entries there.

::: warning Channel messages match by name
A channel message carries only a sender name, not a key. MeshMonitor matches it to the node by advert name. Anyone can use any name, and two nodes can share one. Direct messages match by key.
:::

### Text rules

The **Message filters** section in the MeshCore source's **Settings** holds text rules. Each rule has:

- **Pattern** (up to 256 characters)
- **Match type**: *Exact*, *Wildcard* or *Regex*
- **Checks**: *Sender name*, *Message text*, or *Name and text*
- **Mode**: Ignore or Block
- **Case sensitive** and **Enabled** switches

Exact and wildcard patterns must match the whole field. In a wildcard, `*` matches any run of characters and `?` matches one character. A regex matches anywhere in the field. Regexes run on RE2, so lookaround and backreferences are not supported, and MeshMonitor rejects them when you save.

Each rule shows how often it matched and when it last matched. Counts save to the database about every 30 s, so a crash can lose a few.

Ignore and Block send nothing over the radio. Saving a list never triggers a send.

## Room Servers

Room servers (advType=3) are BBS-style MeshCore nodes that store posts and push-sync them to connected clients. The **Rooms** view in the MeshCore page lists discovered room servers and provides:

- **Explicit login** — selecting a room does not log in. MeshMonitor shows the saved posts read-only under a "Not logged in" banner. Enter a password and press **Login** (or **Log in with saved password**) to post or fetch new posts. Login retries up to 3 times automatically to handle RF packet loss. Before 4.17.3, selecting a room logged in at once.
- **Post stream** — read and send posts in the room's message board. Stored posts stay readable with no live login; sending needs one.
- **Auto-sync** — configure periodic re-login to fetch new posts on a schedule (1h to 24h intervals). The auto-sync setting is persisted per-room and loaded when the room is selected. You can change it from the login card without logging in. Scheduled auto-sync still logs in by itself.
- **Credential persistence** — saved room passwords are AES-256-GCM encrypted via the same credential store used for remote admin passwords.

## Multi-Source Dashboard

MeshCore sources appear as styled cards in the dashboard sidebar — same visual language as Meshtastic sources, with a MeshCore logo and per-source status.

### Dashboard widgets

A MeshCore source's Dashboard offers the same **Add Widget** choices as a Meshtastic source: Node Status, Traceroute, Hop Distribution, Distance Distribution, Hop Distance Heatmap and Live Mesh Activity.

- **Node Status** shows a MeshCore node's battery voltage from its stored battery reading.
- **Traceroute** draws the latest trace you started to the node on the shared route map. A MeshCore trace has no return leg.
- **Hop widgets** use each node's path length as its hop count.
- **Live Mesh Activity** lists the senders the source heard in the window. It reads the MeshCore packet log, so turn on the MeshCore packet monitor for the source. See [Live Mesh Activity](/features/packet-monitor#live-mesh-activity-dashboard-widget).

## Packet Monitor

The MeshCore page includes a **Packet Monitor** tab that surfaces raw OTA frames. This is the MeshCore analogue of the Meshtastic [Packet Monitor](/features/packet-monitor). Where the frames come from depends on the source:

- **Companion:** the companion's `LogRxData` (0x88) push. No firmware change is needed.
- **Repeater:** the repeater's serial packet log. This needs a firmware build with `-D MESH_PACKET_LOGGING=1`. Stock repeater firmware prints no packets over serial, and the tab says so.
- **MQTT ingest:** every observer's copy of each frame on the region feed. See [MeshCore MQTT Ingest](/features/meshcore-mqtt-ingest).

Capture is opt-in. The view exposes an **Enable** toggle and retention controls (max packet count, max age in hours) inline; no separate settings page is required. Once enabled, the monitor shows:

- **Timestamp** — when the packet was received
- **Route type** — direct / flood / etc. (decoded from the OTA frame)
- **Payload type** — message type in human-readable form where known, raw hex otherwise
- **Relay chain** — the relay-hash sequence from the packet
- **Hop count**, **SNR**, and **RSSI**
- **Raw hex dump** — the full OTA frame, accessible via the detail modal

New packets stream in live over the existing Socket.io connection (no separate subscription is needed). The view can be **paused** and **exported** (`.jsonl` format) for offline analysis. Filtering by payload type and route type narrows the display.

### Decoding channel packets

Click a row to open **Packet Decode**. Adverts, ACKs and control packets decode in full. Channel packets (`GRP_TXT` and `GRP_DATA`) are encrypted, so the modal asks the server to open them:

- The server tries every channel key it holds: this source's channels, channels on your other sources, and MeshCore entries in the [Channel Database](/features/channel-database).
- A `GRP_TXT` packet shows the channel name, sender, the sender's timestamp and the text. A `GRP_DATA` packet shows the channel name, the data type and a hex + ASCII dump of the body.
- The modal says where the key came from: **this source**, another source by name, or a **virtual channel**.
- You see the plaintext only if you could read that channel's messages anyway (`channel_N:read` or `messages:read` on a source that holds the key, or **Read** on the virtual channel). Otherwise the modal shows **Unknown channel (hash 0xNN)**, the same as when the server has no matching key. Signed-out viewers always see that.

Decryption happens when you open the modal. The packet list, the live feed and the `.jsonl` export stay ciphertext, no plaintext is stored in the packet log, and channel keys never leave the server.

Clearing the log needs `packetmonitor:write`. The Users page offers only a read grant for the Packet Monitor, so in practice that means an administrator. `settings:write` is required to toggle capture on/off and adjust retention.

## Notifications

Each MeshCore source has its own **Notifications** tab, delivered by Web Push, Apprise or desktop notifications. It covers direct messages and room posts, channel messages, keywords, successful traces and path discoveries, Low Battery, Inactive Node, Newly Found Nodes, Server Events and **Mentions**, with the same rules as Meshtastic. A Repeater source offers channel messages and the node alerts only. Settings are saved per user and per source, and the **Settings** view has per-channel sounds.

**Mentions** alerts you when a channel message or room post names the source's own node as `@[Name]`. A reply to you starts with `@[Name]:`, so it alerts too. It is off until you turn it on. One sender can alert at most once every 5 minutes per source, and that limit is stored, so a restart does not reset it. Direct messages, your own messages, and senders you ignore or block never alert. It sends nothing over the radio.

See [MeshCore Sources](/features/notifications#meshcore-sources) in the Notifications guide for the full list and the rules.

## Security

The Security tab works on MeshCore sources. It lists dead contacts, path-hash collisions, advert signature results, names reused under a new key, and own-key changes. It also flags nodes that send more than 30 packets an hour (turn on the Packet Monitor to measure this) and nodes whose clock is off by more than 30 minutes or was never set. It has a scanner, a daily Apprise digest, CSV/JSON export, and a draft-only "Send notification" DM for Companion sources. See [Security Features](/features/security#meshcore-sources) for details.
