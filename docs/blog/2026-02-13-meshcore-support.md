---
id: news-2026-02-13-meshcore-support
title: MeshMonitor v3.5.0 - Experimental MeshCore Support
date: '2026-02-13T18:00:00Z'
category: feature
priority: important
minVersion: 3.5.0
---
MeshMonitor v3.5.0 is a milestone release introducing **experimental MeshCore protocol support**, along with AutoTraceroute scheduling improvements, Remote Admin UI enhancements, and several bug fixes.

## MeshCore Protocol Support (Experimental)

MeshMonitor can now connect to **MeshCore** repeaters and clients via serial port, enabling monitoring and messaging with MeshCore-based mesh networks alongside standard Meshtastic nodes.

### Key Capabilities

- **Serial port connectivity** to MeshCore repeaters and clients
- **Node discovery and tracking** for MeshCore devices on the map
- **Two-way messaging** between MeshMonitor and MeshCore nodes
- **Contact management** with automatic discovery

MeshCore support is experimental and requires a compatible MeshCore device connected via serial port. For more information about MeshCore, visit [meshcore.co](https://meshcore.co).

[Read more about MeshCore support](https://meshmonitor.org/features/meshcore)

## Other Improvements

- **AutoTraceroute & Remote Admin time window scheduling** — Restrict scans to specific hours (e.g., off-peak 22:00–06:00) with overnight wrapping support ([#1871](https://github.com/Yeraze/meshmonitor/pull/1871))
- **Remote Admin icon and filter on map** — Quickly identify and filter nodes with remote admin access ([#1868](https://github.com/Yeraze/meshmonitor/pull/1868))
- **Successful nodes first in Remote Admin Scanner** — Improved scan log readability ([#1870](https://github.com/Yeraze/meshmonitor/pull/1870))
- **LLM Bridge user script** — New community script for connecting LLMs to your mesh ([#1878](https://github.com/Yeraze/meshmonitor/pull/1878))
- **Compact node list and packet charts** — Tighter layouts and combined paxcounter graphs
- **Tapback DM routing fix** — Tapback emoji reactions now correctly stay on the original channel instead of being sent as DMs ([#1885](https://github.com/Yeraze/meshmonitor/pull/1885))
- **Outgoing message timestamp fix** — Timestamps now update to node time on ACK receipt ([#1884](https://github.com/Yeraze/meshmonitor/pull/1884))
