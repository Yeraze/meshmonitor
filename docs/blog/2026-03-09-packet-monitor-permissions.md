---
id: news-2026-03-09-packet-monitor-permissions
title: MeshMonitor v3.8.5 - Packet Monitor Permission & Filtering
date: '2026-03-09T18:00:00Z'
category: feature
priority: important
minVersion: 3.8.5
---
MeshMonitor v3.8.5 introduces a dedicated **Packet Monitor** permission resource and granular packet filtering based on channel and message permissions.

## New Packet Monitor Permission

The Packet Monitor now has its own **packetmonitor:read** permission, replacing the previous requirement for `channel_0:read + messages:read`. This gives administrators more precise control over who can access the packet monitoring feature.

## Action Required

Administrators should review their user permissions:

1. Navigate to **Settings > Users** and select each user
2. Verify the **Packet Monitor** read permission is set appropriately
3. New users and the Anonymous user receive **Packet Monitor: Read** by default
4. The Packet Monitor permission is read-only — there is no write mode

## Channel-Based Packet Filtering

Packet Monitor now filters packets based on your channel permissions:

- **Encrypted packets** are always visible (content is unreadable anyway)
- **Decrypted channel packets** require **Read** permission on the corresponding channel (channel_0 through channel_7)
- **Direct Message packets** (TEXT_MESSAGE_APP to a specific node) require **Direct Messages: Read** permission
- **Admin users** bypass all filtering and see all packets

This means non-admin users will only see packets from channels they have access to, while still being able to see encrypted traffic for signal analysis.

## Other Changes

- **Packet Monitor sidebar tab** — Packet Monitor is now accessible as a dedicated sidebar tab in addition to the map panel ([#2180](https://github.com/Yeraze/meshmonitor/pull/2180))
- **Virtual Node config loop fix** — Prevents reconnect loops caused by cached `rebooted` messages ([#2182](https://github.com/Yeraze/meshmonitor/pull/2182))
- **Debug cleanup** — Removed stale debug logging and backup file ([#2183](https://github.com/Yeraze/meshmonitor/pull/2183))
- **Dependency updates** — Updated mysql2, express-rate-limit, pg, recharts, and GitHub Actions
