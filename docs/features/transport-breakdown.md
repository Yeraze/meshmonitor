# Transport Breakdown

::: tip New in 4.16.2
MeshMonitor now splits node counts, packet counts, and route records by **transport**: RF (LoRa), UDP, and MQTT.
:::

## Overview

A packet reaches MeshMonitor over one of three transports:

| Transport | Meaning |
|-----------|---------|
| **RF** | Received over LoRa by a radio |
| **UDP** | Received over the Meshtastic UDP multicast link |
| **MQTT** | Received through an MQTT broker or gateway |

The Info tab shows the split for each connected Meshtastic source. An MQTT-only source has one transport, so it shows no split.

## Network Survey

The **Reach by hop count** bars in the Network Survey split each hop bucket into RF, UDP, and MQTT segments. Hover over a bar to see the counts. MQTT also counts routes that include a hop with no measured signal, which usually means an MQTT-bridged leg.

## Network Statistics

- **Total Nodes** adds a **Heard via** line: `RF n · UDP n · MQTT n`. A node heard over two transports counts in each, so the parts can add up to more than the total.
- **Total Messages** is now a real count of stored messages for the source, not the last 100. A line under it splits the count by transport.
- **Packet Distribution** has a **Transport** filter (All, RF, UDP, MQTT). It limits the Packet Distribution cards to packets from that transport.

## Longest Active and Record Holder

The **Longest Active Route Segment** and **Record Holder Route Segment** cards keep one entry per transport. A record set before 4.16.2 counts as RF, because MeshMonitor did not store the transport then and the traceroute is gone. The card says so.

**Clear Record** clears the record for one transport. See [Per-Source Permissions](/features/per-source-permissions#traceroute-records) for the permissions these cards need.

## Device counters cover all transports

The node counts these values itself, across every transport, so MeshMonitor cannot split them. They carry a note saying so:

- Radio Statistics
- Packets TX and Packets RX
- The "(Device)" charts, such as the device packet-rate charts

## Traffic by Transport charts

Two charts on the Info tab come from what MeshMonitor counts itself, in 5-minute bins:

- **Nodes Heard by Transport**: how many nodes each transport heard per bin.
- **Packets Received by Transport**: how many packets arrived on each transport per bin. Each packet counts once.

On long time ranges, each point averages several bins. Star a chart to add it to the Dashboard as a favourite.
