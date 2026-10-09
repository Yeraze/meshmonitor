# Reliable PKI

Meshtastic encrypts a direct message or a data request to one node with PKI when your radio holds that node's public key. PKI works both ways: the other node can only read the packet if it holds **your** public key. Nodes with small NodeDBs drop keys, and then every DM or request you send them is lost without a word.

**Reliable PKI** watches whether your encrypted exchanges with each node get an answer. When the last one failed, MeshMonitor sends that node your node info (which carries your public key) before the next encrypted send.

## Where to set it

| Page | Setting | Values |
|---|---|---|
| **Global Settings → Security** | Reliable PKI (default for every source) | **Off** (default), **As needed** |
| A Meshtastic source's **Settings → Reliable PKI** | Reliable PKI for this source | **Use the global default**, **Off**, **As needed** |

- **Off** — MeshMonitor never sends anything extra.
- **As needed** — when the last encrypted DM or request to a node got no answer, MeshMonitor sends that node your node info first, waits 5 seconds, then sends the real message.

## What it costs

::: warning Airtime
When a node stops answering encrypted requests, MeshMonitor sends it your node info first (at most once an hour per node). Each one uses airtime on the mesh.
:::

- One extra packet per node per hour **at most**, and only after an encrypted exchange with that node failed, and only when you send to that node again.
- That packet is a node info exchange sent to the node on its channel. Like any packet it is repeated by up to *hop limit* relays, and the node answers with its own node info.
- The hourly limit is stored in the database per source and node. Restarting MeshMonitor or saving settings does not reset it.
- No priming is sent when the source cannot transmit (disconnected, TX disabled), while the [airtime cutoff](/features/automation) pauses automations, to ignored nodes, to your own node, or to a node with a key mismatch (Auto Key Management handles those).
- If the node info cannot be sent, your message goes out as it would have anyway. Reliable PKI never blocks a send.

## Which sends count

The radio PKI-encrypts a packet to one node when it holds that node's key, except traceroute, node info, routing and position packets. So Reliable PKI covers:

- Direct messages (from the UI, the API, auto-replies and automations)
- Telemetry and LocalStats requests
- Neighbor info requests
- Waypoints sent to one node

Traceroutes, position requests and node info exchanges never use PKI, so they are never primed and never change the state. Remote administration uses its own admin keys and session passkeys and is not covered.

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
