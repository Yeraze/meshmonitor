# Reliable PKI

Meshtastic encrypts a direct message or a data request to one node with PKI when your radio holds that node's public key. PKI works both ways: the other node can only read the packet if it holds **your** public key. Nodes with small NodeDBs drop keys, and then every DM or request you send them is lost without a word.

**Reliable PKI** offers two fixes. **As needed** watches whether your encrypted exchanges with each node get an answer, and when the last one failed, sends that node your node info (which carries your public key) before the next encrypted send. **Avoid PKI** skips PKI for data requests: they go out encrypted with the node's channel key, so the node does not need your key at all.

## Where to set it

| Page | Setting | Values |
|---|---|---|
| **Global Settings → Security** | Reliable PKI (default for every source) | **Off** (default), **As needed**, **Avoid PKI** |
| A Meshtastic source's **Settings → Reliable PKI** | Reliable PKI for this source | **Use the global default**, **Off**, **As needed**, **Avoid PKI** |

- **Off** — MeshMonitor never sends anything extra.
- **As needed** — when the last encrypted DM or request to a node got no answer, MeshMonitor sends that node your node info first, waits 5 seconds, then sends the real message.
- **Avoid PKI** — telemetry, LocalStats and neighbor info requests go out encrypted with the node's channel key instead of PKI. DMs, waypoints and remote administration are not affected. No node info is ever sent first. See [Avoid PKI](#avoid-pki).

## What it costs

::: warning Airtime
When a node stops answering encrypted requests, MeshMonitor sends it your node info first (at most once an hour per node). Each one uses airtime on the mesh.
:::

- One extra packet per node per hour **at most**, and only after an encrypted exchange with that node failed, and only when you send to that node again.
- That packet is a node info exchange sent to the node on its channel. Like any packet it is repeated by up to *hop limit* relays, and the node answers with its own node info.
- **At most 10 priming packets per source in any rolling hour**, whatever the number of failing nodes. Once a source has sent 10 in the last hour, the next encrypted send goes out without priming, exactly as it would with the setting Off. A node info your radio sent on its own after a "no key" reply counts toward the 10.
- Both limits are worked out from timestamps stored in the database, per source and node. Restarting MeshMonitor or saving settings resets neither.
- No priming is sent when the source cannot transmit (disconnected, TX disabled), while the [airtime cutoff](/features/automation) pauses automations, to ignored nodes, to your own node, or to a node with a key mismatch (Auto Key Management handles those).
- If the node info cannot be sent, your message goes out as it would have anyway. Reliable PKI never blocks a send.

## Which sends count

The radio PKI-encrypts a packet to one node when it holds that node's key, except traceroute, node info, routing and position packets. So Reliable PKI covers:

- Direct messages (from the UI, the API, auto-replies and automations)
- Telemetry and LocalStats requests
- Neighbor info requests
- Waypoints sent to one node

In **Avoid PKI** mode the telemetry, LocalStats and neighbor info requests leave this list: they no longer use PKI.

Traceroutes, position requests and node info exchanges never use PKI, so they are never primed and never change the state. Remote administration uses its own admin keys and session passkeys and is not covered.

## Avoid PKI

::: warning Who can read the request
Requests and their replies are readable by anyone on that channel. DMs are not affected.
:::

In **Avoid PKI** mode these requests use the node's channel key instead of PKI:

| Request | Without Avoid PKI | With Avoid PKI |
|---|---|---|
| Telemetry request (device, environment, air quality, power) | PKI | Channel key |
| LocalStats request to another node | PKI | Channel key |
| Neighbor info request | PKI | Channel key |
| Position request, traceroute | Channel key (the radio never uses PKI for these) | No change |
| Direct messages, waypoints to one node, remote administration | PKI | No change (PKI) |

The request does not need the node to hold your key. Its reply comes back as the node chooses: with PKI if it holds your key, with the channel key if not. Your radio reads both.

**How it works.** Your radio decides the encryption itself: it uses PKI for every packet it sends to one node whose key it holds (except traceroute, node info, routing and position), and it ignores a request from the app to skip PKI. It does send a packet that arrives already encrypted as it is. So in this mode MeshMonitor encrypts the request with the channel key itself, exactly as the radio would for a channel packet, and hands your radio the encrypted packet.

**Which channel.** The node's channel: the one MeshMonitor last heard the node on, the same channel Auto Key Management uses for its node info exchanges. When a request names a channel, that channel is used.

**When MeshMonitor sends the request the normal way instead** (and your radio uses PKI as usual):

- your radio has not reported that channel since it connected, or the channel was changed from MeshMonitor since then (it is used again once the radio reports it, for example after a reconnect);
- the channel uses AEAD encryption;
- the channel's on-air hash is 0 (rare; your radio would overwrite it).

A debug log line starting with `Avoid PKI:` says which way each request went and why.

**What else changes.** A request sent this way is not sent to MQTT by your radio (your radio only uplinks packets it encrypts itself). Nothing is primed in this mode, and requests do not change the **Encrypted requests** state. DMs and waypoints still update it, as with the setting Off. Rows recorded before are kept and still shown in Node Details; switching back to **As needed** uses them again.

## How MeshMonitor decides an exchange failed

A send only changes the state when it asks for something back (an acknowledgement or a reply). It then waits:

| What comes back | Result |
|---|---|
| The node's reply, or its acknowledgement | **Answered** |
| A routing reply that shows the node read the packet (e.g. "no response", "not authorized") | **Answered** |
| The node reports it does not have your key (`PKI_UNKNOWN_PUBKEY`) | **Failed**. Your radio already sends the node your node info in this case, so MeshMonitor counts that toward the hourly limit |
| The node could not decrypt the packet (`NO_CHANNEL`) | **Failed** |
| Your radio gave up after its retries (`MAX_RETRANSMIT`) | **Failed** |
| Nothing within 3 minutes | **Failed** |

An acknowledgement from your own radio when it hears a relay repeat the packet does not count: it shows the packet left, not that the node could read it.

A single failure is enough. A wrong "failed" costs at most one node info an hour; a wrong "answered" leaves requests failing in silence.

## Seeing the state

**Node Details** shows an **Encrypted requests** line for a node with a public key once MeshMonitor has sent it something encrypted: *Last answered …*, *Failing since …* with the reason, or *Waiting for an answer*. It also shows when your node info was last sent to it. When MeshMonitor sends a priming node info it writes a debug log line starting with `Reliable PKI: sent NodeInfo`.

## Related

- [Security Overview](/features/security)
- [PKI Direct Message Decryption](/features/pki-dm-decryption)
- [Global Settings](/features/global-settings)
