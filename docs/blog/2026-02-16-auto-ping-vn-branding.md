---
id: news-2026-02-16-auto-ping-vn-branding
title: MeshMonitor v3.6.0 - Auto-Ping & Virtual Node Enhancements
date: '2026-02-16T18:00:00Z'
category: feature
priority: important
minVersion: 3.6.0
---
MeshMonitor v3.6.0 introduces the **Auto-Ping** automation feature for mesh network diagnostics and improves **Virtual Node** identification with firmware version branding.

## Auto-Ping Automation

A new DM-command driven **Auto-Ping** feature lets mesh users test connectivity and measure latency to your MeshMonitor node.

### How It Works

- Any mesh user can DM your node with `ping N` to start N pings at a configurable interval
- Each ping sends a text DM and tracks ACK, NAK, and timeout responses
- After all pings complete, a summary message is sent with **min/avg/max latency** and timeout count
- Send `ping stop` to cancel an active session

### Admin Controls

- Configure ping **interval** (default 30s), **max pings** (default 20), and **timeout** (default 60s) in the Automation tab
- Monitor active ping sessions in real-time with a stop button
- Enable or disable the feature globally

[Read more about Auto-Ping](https://meshmonitor.org/features/automation#auto-ping)

## Virtual Node Firmware Branding

Virtual Node connections now report a branded firmware version string (e.g., `2.6.6-MM3.6.0`), making it easy to identify that a client is connected through MeshMonitor rather than directly to a physical radio. This appears in both MyNodeInfo and DeviceMetadata responses.

## Other Improvements

- **Virtual Node channel stability** — Fixed an issue where `configComplete` broadcasts during physical radio reconnection could cause VN clients to lose their channel list ([#1920](https://github.com/Yeraze/meshmonitor/pull/1920))
- **Telemetry packet ID tracking** — Telemetry records now include `packetId` from the originating mesh packet, enabling API consumers to de-duplicate data received via multiple mesh paths ([#1921](https://github.com/Yeraze/meshmonitor/pull/1921))
- **Packet distribution fix** — Portnum filter now correctly applies to total count in the packet distribution API ([#1919](https://github.com/Yeraze/meshmonitor/pull/1919))
- **Automation documentation** — Added missing docs for Auto-Ping, Auto Key Management, and Ignored Nodes ([#1918](https://github.com/Yeraze/meshmonitor/pull/1918))
- **Poll optimization** — Batch queries for `/api/poll` and `/api/unread-counts` reduce database load ([#1909](https://github.com/Yeraze/meshmonitor/pull/1909))
- **Mobile scroll fix** — Fixed infinite scroll and always-visible virtual channels on mobile ([#1907](https://github.com/Yeraze/meshmonitor/pull/1907))
- **Dependency updates** — Updated serialport, @serialport/parser-readline, jose, jiti, sass, and sharp
