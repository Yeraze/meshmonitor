# MQTT Setup Guide

This guide walks through the three MQTT setups people ask about most, start to finish. For every option on its own, see the [Embedded MQTT Broker & Bridge](/features/mqtt-broker) reference.

1. [One node to an upstream server](#setup-1-one-node-to-an-upstream-server), with filters such as keeping automation traffic off it
2. [Several nodes to an upstream server](#setup-2-several-nodes-to-an-upstream-server)
3. [One node to several upstream servers](#setup-3-one-node-to-several-upstream-servers)

Read [The parts and which way traffic flows](#the-parts-and-which-way-traffic-flows) first. Nearly every MQTT problem comes from a part doing something its owner did not expect, most often putting broker traffic on the air.

The bridge's configuration page links to this guide and to the broker reference:

![MQTT Bridge Configuration with links to the setup guide](/images/features/5013-mqtt-docs-links.png)

## The parts and which way traffic flows

Four parts can carry MQTT traffic. Each one moves it in a fixed direction:

| Part | Where it lives | Takes traffic from | Sends traffic to | Can it put packets on the air? |
|---|---|---|---|---|
| **Node MQTT module** | On the radio, **Device Configuration → MQTT Module** | The mesh, and the broker it connects to | The broker, and the mesh | **Yes.** It transmits a broker packet when the channel has **Downlink Enabled**. |
| **Embedded MQTT Broker** source | Inside MeshMonitor | Nodes and other MQTT clients that connect to it, and its bridges | Every client subscribed to the topic, its bridges, and linked nodes | Not by itself. It hands packets to radios, and they decide. |
| **MQTT Bridge** source | Inside MeshMonitor | One upstream server (**downlink**) and its parent broker (**uplink**) | Its parent broker (downlink), and the upstream server (uplink) | Not by itself. Only through the broker or a linked node. |
| **MQTT source link** ("Proxy to Client") | Between a node source and a broker or bridge | The node, over its connection to MeshMonitor | The linked broker or bridge, and back to the node | **Yes**, through the node, as above. |

Two rules follow from this table:

- **Watching traffic never needs a radio.** A bridge source reads an upstream server and stores what it decodes. Nothing it receives reaches the air unless it has a parent broker with radios behind it, or a node is linked to it.
- **Only a radio transmits.** Every path to the air ends at a node that accepts a broker packet on a channel with **Downlink Enabled**. Turn that off and the node still uplinks, but nothing from the broker goes out over LoRa.

::: tip Monitor or bridge? Decide first
- **Monitor only** (log the upstream server, keep it off your air): use a bridge with no parent broker, or leave **Downlink Enabled** off on your nodes' channels.
- **Bridge into the mesh** (upstream packets should be transmitted locally): needs a broker, a node with Downlink Enabled, and a hop limit you have chosen. See [How much airtime downlink costs](#how-much-airtime-downlink-costs).
:::

### How a node reaches the broker

A node connects to MeshMonitor's broker in one of two ways. Use one or the other per node, never both:

| How | Node settings | MeshMonitor settings | Use it when |
|---|---|---|---|
| **Direct** | MQTT Module on, **Proxy to Client** off, address = MeshMonitor's host and broker port, broker username and password | Port `1883` published from the container | The node has its own WiFi or Ethernet and can reach the MeshMonitor host |
| **Client proxy** | MQTT Module on, **Proxy to Client** on | Link the node's source to the broker: **Device Configuration → MQTT Module → Quick configure from a MeshMonitor MQTT source** | The node talks to MeshMonitor over TCP, serial or BLE, or cannot reach port 1883 |

With **Proxy to Client** on, the node opens no broker connection of its own. If nothing is linked, its MQTT traffic goes nowhere; see [Why don't I see MQTT traffic?](/features/mqtt-broker#why-no-mqtt-traffic).

::: warning One MQTT path per node
Do not point a node's MQTT module at the upstream server while MeshMonitor also bridges that node's traffic upstream, and do not run the [MQTT Proxy sidecar](/add-ons/mqtt-proxy) on a node that is also linked to a broker. Each path publishes its own copy and skips the other's filters.
:::

## Setup 1: One node to an upstream server

**Goal:** one node's traffic reaches an upstream server such as `mqtt.meshtastic.org`, filtered by MeshMonitor, and (if you want) upstream traffic reaches the node.

```
node ──(direct or client proxy)──▶ Embedded Broker ──▶ Bridge ──▶ upstream server
     ◀── (Downlink Enabled only) ───               ◀──        ◀──
```

Use a **broker and an attached bridge**, not a bridge alone. A node linked straight to a bridge (no broker) gets only **Don't uplink MeshMonitor automation traffic**. It skips the uplink channel and topic filters and the `ok_to_mqtt` check.

### Steps

1. **Create the broker.** **Dashboard → Sources → Add Source → Embedded MQTT Broker (devices connect here)**. Set a username and password. Leave the root topic at `msh` unless your nodes use another.
2. **Create the bridge.** **Add Source → MQTT Bridge (forward to/from an upstream broker)**. Set **Parent broker** to the broker from step 1, then the upstream URL, credentials and topics. Subscribe as narrowly as you can, for example `msh/US/FL/#` rather than `msh/US/#` ([why](/features/mqtt-broker#scope-your-subscriptions)).
3. **Connect the node** to the broker, [directly or through the client proxy](#how-a-node-reaches-the-broker).
4. **Choose the channels.** On the node, under **Device Configuration → Channels Configuration**, tick **Uplink Enabled** on each channel you want published. Tick **Downlink Enabled** only if upstream traffic should be transmitted on your mesh.
5. **Set the filters** on the bridge's **Settings → MQTT Bridge Configuration** page. See the next section.
6. **Test.** Turn on packet capture in the bridge's [Packet Monitor](/features/packet-monitor#mqtt-sources), send a message on an uplinked channel, and check that it appears.

### Filters worth turning on

| Setting | Where | What it does |
|---|---|---|
| **Don't uplink MeshMonitor automation traffic** | Bridge → Forwarding | Keeps auto-acknowledge tapbacks, auto-responder replies, announcements, Automation Engine sends and scheduled requests off the upstream server. They still go out over LoRa. Messages you send by hand are not affected. [Details](/features/mqtt-broker#keep-automation-traffic-off-the-upstream-broker) |
| **Uplink only these channels** | Bridge → Publish (outgoing) | Publishes only the channels you tick, whatever the node uplinks. |
| **Publish topic filter** | Bridge → Advanced: topic filter | Allow or block upstream publishes by topic pattern. |
| **Block specific topics** | Bridge → Subscribe (incoming) | Drops upstream topics you subscribed to but do not want, such as a neighbouring region. |
| **Restrict to geographic bounding box** | Bridge → Subscribe (incoming) | Stops upstream position packets from outside an area being handed to your broker and radios. |
| **Mode** | Bridge → Forwarding | **Publish only** sends up and never brings anything down. **Subscribe only** brings down and never sends up. |

::: tip Why automation filtering matters
A node with **OK to MQTT** on marks every packet it sends as fine to publish, including MeshMonitor's automated replies. On a busy channel, Auto Acknowledge alone can publish a tapback for every message it answers. **Don't uplink MeshMonitor automation traffic** is the only setting that stops these, and it works only on traffic that passes through the bridge. A node whose own MQTT module connects straight to the upstream server bypasses it.
:::

The bridge also honours each packet's **OK to MQTT** setting. It publishes a packet only when the sender allowed it, and **drops encrypted packets it cannot read**. If a channel's packets never reach the upstream server, add that channel's key to the [Channel Database](/features/channel-database) so the bridge can read the setting. **Uplink all packets (ignore ok_to_mqtt bit)** turns the check off; use it only on a private server whose gateways have all agreed.

## Setup 2: Several nodes to an upstream server

**Goal:** several of your nodes share one upstream connection.

```
node A ──┐
node B ──┼──▶ Embedded Broker ──▶ Bridge ──▶ upstream server
node C ──┘
```

Set it up as in [Setup 1](#setup-1-one-node-to-an-upstream-server) with one broker and one bridge, then connect each node to the broker. Keep **Upstream identity** at **Per-gateway** so each node publishes under its own ID, as it would on its own.

### What the broker does with your nodes' traffic

The broker sends every packet to **every subscribed client**, your own nodes included. So:

- **Node A's uplink is delivered to node B.** If B has **Downlink Enabled** on that channel, B transmits it on B's part of the mesh. That is useful when A and B serve separate areas with no RF path between them: MQTT joins them. When A and B can hear each other, it is wasted airtime.
- **The same packet reaches the upstream server several times** when more than one of your nodes hears it over LoRa and uplinks it. Each copy carries its gateway ID. That is normal MQTT behaviour, and MeshMonitor stores one copy per source.
- **A node gets its own packets back.** The firmware recognises them and drops them.

### Keeping the air quiet

Meshtastic firmware drops a packet it has already seen, so a node that heard a packet over LoRa does not transmit it again when the broker delivers it. Nodes that **cannot** hear each other will each transmit it. Decide which nodes should inject broker traffic:

- **Nodes in RF range of each other:** enable **Downlink Enabled** on at most one of them, or none.
- **Nodes in separate areas:** enable it where you want the other area's traffic heard.
- **On the broker,** set **Hop limit on delivery to radios → Cap forwarded hop count** to `0`. Every injected packet is then transmitted once by the node that receives it and not repeated by its neighbours. This matches `mqtt.meshtastic.org`. See [How much airtime downlink costs](#how-much-airtime-downlink-costs).

## Setup 3: One node to several upstream servers

**Goal:** one node publishes to several upstream servers, for example a regional community server and `mqtt.meshtastic.org`, with different filters for each.

```
                       ┌──▶ Bridge 1 ──▶ regional server
node ──▶ Embedded Broker
                       └──▶ Bridge 2 ──▶ mqtt.meshtastic.org
```

Create one broker, connect the node to it, and add **one bridge per upstream server**, each with that broker as **Parent broker**. Each bridge has its own topics, filters and mode. The node publishes once, and each bridge decides what to send to its server.

### What happens to traffic

- **Uplink:** each bridge publishes your node's packets to its server. That costs internet bandwidth, not airtime.
- **Downlink:** each server's traffic comes down through its bridge into the broker and on to your node. If both servers carry the same packet, the node receives it twice and the firmware drops the second copy. It is transmitted at most once.
- **Bridges do not relay each other.** Traffic bridge 1 brings down from the regional server is **not** sent up to `mqtt.meshtastic.org` by bridge 2, and the reverse. Each bridge sends upstream only traffic that started on your side. The bridge's settings page counts the packets it held back as **Not relayed so far**. To relay one server into another on purpose, tick **Relay traffic from other bridges** on that bridge. [Details](/features/mqtt-broker#bridges-do-not-relay-each-other)

### Recommended settings

| Server | Mode | Notes |
|---|---|---|
| A public server you only publish to | **Publish only** | Nothing comes down, so nothing from it reaches your air. |
| A public server you also want to watch | **Bidirectional** and **Skip raise on packets from this bridge** | Its traffic is never given more hops than it arrived with. Leave **Downlink Enabled** off on the node if you only want to watch. |
| A trusted regional or private server | **Bidirectional** | Use a narrow subscription and the bounding box. |

- Turn on **Don't uplink MeshMonitor automation traffic** on **every** bridge. It is a per-bridge setting.
- **Do not point two bridges at the same server** with **Upstream identity** set to Per-gateway. Both bridges would connect with the same client IDs (the broker's gateway ID and your nodes' IDs), and the server would keep disconnecting one to let the other in. Use one bridge per server.

## How much airtime downlink costs

Every broker packet a node accepts is a LoRa transmission, and every hop repeats it. A packet with 3 hops left can be sent by the node and then repeated by up to three more layers of neighbours. On a busy public server that is thousands of packets an hour.

The broker's **Hop limit on delivery to radios** settings decide how far injected packets travel:

| Setting | Effect | Use it when |
|---|---|---|
| Neither on | Packets keep the hop limit they arrived with. `mqtt.meshtastic.org` delivers everything at 0. | Every upstream server already sets a hop limit you accept. |
| **Cap forwarded hop count** at `0` | Each injected packet is transmitted once and not repeated. | Almost always. It matches the public server. |
| **Cap forwarded hop count** at `1`–`3` | Neighbours repeat it up to that many times. | You want broker traffic to spread a little past the receiving node. |
| **Raise hop count for backhaul** | Increases the hop limit on the packet types you pick. | A trusted backhaul link between your own sites. Never for a public server; use **Skip raise on packets from this bridge** on those bridges. [Details](/features/mqtt-broker#raise-hop-count-for-backhaul) |

The settings change only what radios receive. What MeshMonitor stores, and what a bridge sends upstream, keep the original hop limit.

## Checklist

Before you turn on downlink anywhere:

- [ ] Each node uses **one** MQTT path: its own module, the client proxy, or the sidecar.
- [ ] **Uplink Enabled** is on for each channel you want published, and off for the rest.
- [ ] **Downlink Enabled** is on only for channels whose broker traffic you want transmitted, and on only one node per RF area.
- [ ] The broker's **Cap forwarded hop count** is set, usually to `0`.
- [ ] Each bridge subscribes to the narrowest topic that covers your area.
- [ ] **Don't uplink MeshMonitor automation traffic** is on for every bridge.
- [ ] Bridges to public servers have **Skip raise on packets from this bridge** on.
- [ ] **Relay traffic from other bridges** is off unless you mean to join two servers.
- [ ] The keys of every channel you uplink are in the [Channel Database](/features/channel-database).

## Related

- [Embedded MQTT Broker & Bridge](/features/mqtt-broker): every option in detail
- [Why don't I see MQTT traffic?](/features/mqtt-broker#why-no-mqtt-traffic)
- [MQTT Client Proxy sidecar](/add-ons/mqtt-proxy)
- [Packet Monitor for MQTT sources](/features/packet-monitor#mqtt-sources)
- [Meshtastic MQTT module documentation](https://meshtastic.org/docs/configuration/module/mqtt/)
