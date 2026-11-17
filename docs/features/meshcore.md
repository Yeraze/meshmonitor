# MeshCore Support

::: warning STILL EARLY
MeshCore support is still **new and basic**. The core capabilities are stable and shipping incrementally — but expect rough edges, missing pieces compared to the Meshtastic side, and a fast-moving feature surface. If something doesn't behave the way you'd expect, [open an issue](https://github.com/yeraze/meshmonitor/issues/new).
:::

## Overview

[MeshCore](https://meshcore.co) is a LoRa mesh protocol that runs on much of the same hardware as Meshtastic. In MeshMonitor each MeshCore radio is a **source**: it sits in the Sources sidebar next to your Meshtastic nodes, with its own permissions, page and telemetry, and its contacts with a position appear on the dashboard map.

One MeshMonitor can run several MeshCore and Meshtastic sources side by side. A MeshCore source can be a **Companion** (USB or TCP) or a **Repeater** (USB only). A Room Server connects as a Companion.

## Start here {#start-here}

Connect a Companion radio and send your first channel message:

1. Flash the radio with MeshCore **Companion** firmware. Use a USB build, or a WiFi/Ethernet build to connect over TCP.
2. **USB:** map the port into the container with `devices:` (for example `/dev/ttyACM0`). **TCP:** note the radio's LAN IP; WiFi and Ethernet builds listen on port `5000`.
3. On the dashboard, open the **Sources** sidebar (admins only) and click **+ Add**.
4. Set **Type** to **MeshCore**, pick the **Transport** (**USB / Serial** or **TCP**) and enter the port or host, set **Device Type** to **Companion**, and save. The source connects at once; no restart needed.
5. Click the source to open its page. Contacts fill the **Map** as their adverts arrive. To let nearby nodes find you, send **Advert (nearby, zero-hop)** from the status bar.
6. Open **Channels**, pick **Public**, type a message and press **Send**.

For a **Repeater**, pick **USB / Serial** and **Repeater** in step 4. A Repeater source reads the radio's console and sends no messages; see [What a Repeater Source Shows](/features/meshcore-remote-admin#what-a-repeater-source-shows).

## Guides

| Page | What it covers |
|---|---|
| [Set up a MeshCore source](/features/meshcore-setup) | USB and TCP links, env vars for headless installs, Virtual Node, connection troubleshooting |
| [Use the MeshCore page](/features/meshcore-using) | Map, channels, direct messages, contacts, reactions, rooms, Packet Monitor, notifications |
| [Configure a MeshCore source](/features/meshcore-configuration) | Device and radio settings, backups, telemetry, the radio's contact list, permissions, API |
| [Paths, discovery and regions](/features/meshcore-paths) | Route lines, traces, neighbours, node discovery, adverts, regions and scopes |
| [Repeaters and remote admin](/features/meshcore-remote-admin) | Repeater sources, repeater settings, remote settings, remote and local consoles |
| [Receive-Only Mode](/features/meshcore-receive-only) | Block every transmission from a source |
| [Analyzer Observer](/features/meshcore-analyzer-observer) | Publish what your radio hears to MeshCore Analyzer brokers |
| [MQTT Ingest](/features/meshcore-mqtt-ingest) and [MQTT Broker](/features/meshcore-mqtt-broker) | MeshCore sources with no radio |

## Automations

The source's **Automations** tab holds the built-in automations below. Auto-Pathfinding is on [Paths, discovery and regions](/features/meshcore-paths#auto-pathfinding).

## Auto Ping

On a **Companion** source, the **Automations** view also has an **Auto Ping** section: a contact DMs `ping N` and the companion pings it back N times, recording each ping's round trip, timeout, and whether it went direct or by flood. Repeater sources do not have it. See [Auto Ping on MeshCore](/features/automation#auto-ping-meshcore).

## Auto-Announce

The **Automations** view also hosts a per-source Auto-Announce that periodically broadcasts a status message to one or more MeshCore channels:

- **Scheduling** — choose either a simple interval (every N hours, 1–168) or a standard 5-field cron expression. An optional *announce on connection* fires a single message whenever the source reconnects.
- **Message template** — the message body supports token expansion. Available tokens: `{VERSION}`, `{DURATION}`, `{CONTACTCOUNT}`, `{COMPANIONCOUNT}`, `{REPEATERCOUNT}`, `{ROOMCOUNT}`, `{NODE_NAME}`, `{NODE_ID}`. A live preview shows the rendered text, and clickable token buttons insert at the cursor.
- **Target channels** — the announcement is broadcast to every selected channel each run.
- **Optional advert burst** — fire a MeshCore advert N seconds (0–600) after each announcement so neighbours rediscover the node. Choose **Zero-hop** (default) or **Flood**; see [Automated flood limit](#automated-flood-limit).
- **Send Now** — manually fire the configured announcement for testing without waiting for the schedule.

## Auto-Responder

Auto-Responder matches incoming messages against operator-defined patterns and replies automatically:

- **Per-trigger pattern** — match incoming text with per-channel filtering, DM listening, and a per-sender cooldown to avoid loops. Each trigger has a **Match mode**, the same as on Meshtastic (see [Match mode](/features/automation#match-mode-pattern-or-regex)): **Pattern** (the Meshtastic syntax, whole message, `{name}` captures that fill the reply and reach a script as `PARAM_<name>`) or **Regex** (case-insensitive, matches anywhere in the message, `(?<name>…)` captures). New triggers start as Pattern; triggers saved before match modes existed stay Regex. Both modes take emoji and other non-ASCII text.
- **Per-trigger pre-send delay** — wait a configurable number of seconds (0–120, `0` = immediate) after a match before replying, so a relaying repeater can finish its own transmission before your reply floods. Mirrors the Auto-Acknowledge pre-send delay; the wait applies once per fire, ahead of both text and script responses.
- **Two actions** — reply with a **text response** (same token expansion as Auto-Announce) or **run a script** (with token-expanded script args). Script execution reuses the shared script runner, with `MESHCORE_*` environment variables injected so a script can branch on which stack invoked it.
- **Reply scope/region** — choose which region the reply floods to: **Inherit** the channel/source default, **Match the triggering message's scope** (answer back on the same region it arrived on), send **Unscoped**, or pick **a specific region**. This mirrors the MeshCore scope control in the [Automation Engine](/features/automation-engine#actions).

Triggers work the same way as on Meshtastic: each one is a card with its own on/off switch, a summary and tags. Click **Add trigger** or **Edit** to open a card, then **Done**, then **Save**. **Delete** asks first. The **Test a message** box shows which triggers a sample message fires, each in its own match mode, and their reply text with captured values filled in and tokens such as `{VERSION}` left as written. It sends nothing and does not apply channel filters.

### Route tokens

Auto-Acknowledge and Auto-Responder templates can quote the path the triggering message took:

| Token | Meaning | Example |
|-------|---------|---------|
| `{ROUTE}` | Relay-hash chain the message took | `a3→7f` |
| `{ROUTE_NAMES}` | Same chain, with each hop resolved to the repeater or room-server name where known | `Hilltop→7f` |
| `{HASH_SIZE}` | Per-hop path-hash width in bytes (1–3), as the sender stamped it | `1` |

A hop MeshMonitor cannot resolve stays as raw hex. When several repeaters share a hash prefix, MeshMonitor picks the one closest to the neighbouring hops' positions — a best guess, not a certainty. The same resolution backs the clickable route line on a received message (see [Message route line](#message-route-line)).

Auto-Responder **scripts** get the same values as environment variables: `HOPS`, `ROUTE`, `ROUTE_NAMES`, `HASH_SIZE` and `SCOPE`. Each holds exactly what the matching `{TOKEN}` would render, including `—` when the value is unknown (for example, `HASH_SIZE` on a direct message, which carries no relay hops).

## Forwarding

Forwarding copies matching incoming DMs or channel messages to one contact or another channel on the same MeshCore source, with an on/off checkbox per rule. It uses the same rules and fixed limits as Meshtastic forwarding (5 forwards per rule per minute, 200 characters, no loops) and stays read-only in receive-only mode. A master switch in the section header, and the FWD pill on the source's sidebar card, turn all forwarding on that source on or off at once. See [Forwarding](/features/automation#forwarding) for details.

## Timer Triggers

Timer Triggers schedule recurring actions independent of incoming traffic:

- **Per-trigger schedule** — each trigger runs on its own cron or interval.
- **Three actions** — send a **text** message (token expansion supported) to a channel or contact, fire a MeshCore **advert** (zero-hop by default, or flood; see [Automated flood limit](#automated-flood-limit)), or **run a script** (token-expanded args).
- **Last-run telemetry** — the UI surfaces the last fire time and outcome per trigger.

## Automated Channel-Send Auto-Retry

MeshCore channel (broadcast) messages are unacked, fire-and-forget floods — unlike a direct message, there is no firmware ACK to confirm delivery. MeshMonitor instead listens for nearby repeaters re-flooding your own packet (the "heard repeaters" signal, see [Channels](#channels)). When **no** repeater is heard, the message likely reached no one.

The **MeshCore Messaging** section of global **Settings** hosts an opt-in toggle, **Auto-retry automated MeshCore channel sends** (default **off**). When enabled:

- An **automated** channel send that hears **zero** repeaters within **30 seconds** is resent **exactly once**.
- It applies only to automated senders: the [Automation Engine](/features/automation-engine) `Send message` action, Auto-Acknowledge, the [Auto-Responder](#auto-responder), [Auto-Announce](#auto-announce), and [Timer Triggers](#timer-triggers).
- **User-initiated sends are never retried automatically** — a message you type into the send bar goes out once regardless of this setting. To send it again yourself, use the **Resend** button (see [Channels](#channels)).
- It is **one-shot**: the resend is never itself retried, so at most one extra transmission ever occurs per logical send.
- The resend does **not** create a second message bubble and does **not** re-enter the automation event bus, so it can never trigger a fresh automation.

A split Auto-Acknowledge reply (see [Long Replies on MeshCore](/features/automation#meshcore-long-replies); Auto Responder, Timer, Auto Announce and Automation Engine splits work the same way) counts as one automated send per part, so each part can be resent once.

This is **distinct from the direct-message retry**, which is always on and follows the firmware's own same-path/flood ACK cadence. Because a channel send has no delivery ACK, the retry can only guess from the heard-repeater signal — so with this enabled you may occasionally see a duplicate on the mesh if a late echo arrives right around the 30-second mark. Leave it off if duplicates are unacceptable for your deployment.

## Analyzer Observer

::: tip Added in 4.14 (#4457)
A Companion source can publish the packets it hears to one or more MeshCore Analyzer MQTT brokers, so your node shows up as a regional observer. One-click presets cover MeshMapper, LetsMesh, meshcore.ca and RF Lab; any compatible broker works too.
:::

It's observation-only — MeshMonitor never subscribes to the broker or transmits on your behalf. Turn it on and pick its brokers on the source's **Device Configuration** page, then fetch or paste the signing key under **Credentials**. See the [MeshCore Analyzer Observer guide](/features/meshcore-analyzer-observer) for setup, a troubleshooting table, and what data leaves your network.

## Receive-Only Mode

*New in 4.14.* A per-source **Receive-only mode** toggle in MeshCore Settings blocks every
transmission from that source — messages, adverts, remote admin, path discovery, and every
transmitting automation — while receiving, the packet log, the Analyzer Observer, and local
serial configuration keep working. MeshCore firmware has no radio-level transmit switch, so
MeshMonitor enforces this in software; it cannot stop link-layer acknowledgements or an
on-device advert schedule configured outside MeshMonitor. See
[MeshCore Receive-Only Mode](/features/meshcore-receive-only) for the full picture, including
Virtual Node behavior and the firmware limitation.

## Still Early

Companion sources get most of the features. Known gaps:

- A **Repeater** source is USB only, cannot send messages or traces, and cannot run the Analyzer Observer. Most of what it shows beyond neighbours and local telemetry needs a firmware build with packet logging (see [What a Repeater Source Shows](/features/meshcore-remote-admin#what-a-repeater-source-shows)).
- The **telemetry mode** settings (Basic, Location, Environment) apply to Companions only.

## Sections that moved

These sections now live on the guide pages above. Each heading keeps its old link.

### Headless installs: first-boot env vars {#headless-installs-first-boot-env-vars}

Create a MeshCore source on first boot with no clicks. See [Headless installs](/features/meshcore-setup#headless-installs-first-boot-env-vars).

### Configuration {#configuration}

Change a Companion's name, position, radio and other settings: see [Device configuration](/features/meshcore-configuration#configuration). For a Repeater source, see [Repeater settings](/features/meshcore-remote-admin#repeater-settings).

### Radio Configuration {#radio-configuration}

Pick a preset or set frequency, bandwidth, SF and CR. See [Radio Configuration](/features/meshcore-configuration#radio-configuration).

### Companion Backups {#backups}

Back up and restore a Companion's settings and channels. See [Companion Backups](/features/meshcore-configuration#backups).

### Telemetry Modes {#telemetry-modes}

Choose which telemetry the device shares. See [Telemetry Modes](/features/meshcore-configuration#telemetry-modes).

### Radio contact table vs MeshMonitor {#radio-contact-table-vs-meshmonitor}

Why a node MeshMonitor shows can still refuse a login, and how to fix it. See [Radio contact table vs MeshMonitor](/features/meshcore-configuration#radio-contact-table-vs-meshmonitor).

### Per-Source Settings {#per-source-settings}

Default path hash size, infrastructure node age and more. See [Per-Source Settings](/features/meshcore-configuration#per-source-settings).

### Map {#nodes}

The map and node list. See [Map](/features/meshcore-using#nodes).

### Channels {#channels}

Channel messages, unread markers, heard repeaters, delivery marks and Resend. See [Channels](/features/meshcore-using#channels).

### Contact location override {#contact-location-override}

Pin a contact to a position you choose. See [Contact location override](/features/meshcore-using#contact-location-override).

### Message route line {#message-route-line}

The relay path under each received message. See [Message route line](/features/meshcore-using#message-route-line).

### Contact tokens (MeshCore One) {#contact-tokens}

Share and import contacts inside messages. See [Contact tokens](/features/meshcore-using#contact-tokens).

### Send under another name (API) {#api-sender-names}

Let API callers post under names you list. See [Send under another name](/features/meshcore-using#api-sender-names).

### Reactions {#reactions}

Emoji reactions from MeshCore One and meshcore-open. See [Reactions](/features/meshcore-using#reactions).

### Packet Monitor {#packet-monitor}

Raw frames your radio hears. See [Packet Monitor](/features/meshcore-using#packet-monitor).

### Decoding channel packets {#decoding-channel-packets}

Open encrypted channel packets in Packet Decode. See [Decoding channel packets](/features/meshcore-using#decoding-channel-packets).

### Trace SNR History {#trace-snr-history}

Per-hop SNR from every trace your radio hears. See [Trace SNR History](/features/meshcore-paths#trace-snr-history).

### Adverts {#adverts}

Zero-hop and flood adverts and what they cost. See [Adverts](/features/meshcore-paths#adverts).

### Automated flood limit {#automated-flood-limit}

Automated flood adverts are capped at one per hour per source. See [Automated flood limit](/features/meshcore-paths#automated-flood-limit).

### Regions / Scopes {#regions-scopes}

Tag outgoing floods with a region so repeaters that drop unscoped traffic forward them. See [Regions / Scopes](/features/meshcore-paths#regions-scopes).

### Setting a scope {#setting-a-scope}

Per-channel, per-source and per-message scopes. See [Setting a scope](/features/meshcore-paths#setting-a-scope).

### Remote settings {#remote-settings}

Read and change a remote Repeater or Room Server's settings from a form. See [Remote settings](/features/meshcore-remote-admin#remote-settings).

### Remote Administration {#remote-administration}

Log in to repeaters and room servers and run CLI commands. See [Remote Administration](/features/meshcore-remote-admin#remote-administration).

### Companion remote CLI {#companion-remote-cli}

Run CLI commands on another Companion with no login. See [Companion remote CLI](/features/meshcore-remote-admin#companion-remote-cli).

### Credential store {#credential-store}

How MeshMonitor encrypts saved node passwords. See [Credential store](/features/meshcore-remote-admin#credential-store).

### CLI command history {#cli-command-history}

Every CLI command sent through MeshMonitor, with its reply. See [CLI command history](/features/meshcore-remote-admin#cli-command-history).
