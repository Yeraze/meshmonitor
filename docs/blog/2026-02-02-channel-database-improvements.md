---
id: news-2026-02-02-channel-database-improvements
title: 'Channel Database: Priority Ordering & Name Validation'
date: '2026-02-02T18:00:00Z'
category: feature
priority: normal
minVersion: 3.4.4
---
MeshMonitor v3.4.4 enhances the **Channel Database** feature with priority-based ordering and name validation for server-side decryption.

## Drag-and-Drop Priority Ordering

Channel Database entries can now be reordered using **drag-and-drop**. This controls the decryption priority - when multiple channels could potentially decrypt a packet, only the **first matching channel** in sort order will be used.

### Why This Matters

- If multiple channels share the same PSK, the order determines which channel name is associated with decrypted packets
- Higher-priority channels (earlier in the list) are tried first during decryption
- Reduces unnecessary decryption attempts by trying likely channels first

## Enforce Name Validation

A new **Enforce Name Validation** option ensures that a channel only decrypts packets that have a matching channel hash. This is useful when:

- Multiple channels share the same PSK (e.g., default keys)
- You want packets attributed to the correct channel name
- You're monitoring networks where channel naming conventions matter

**Note:** If the sending device doesn't include channel hash information in packets, enabling this option may prevent decryption even with a valid PSK.

[Read more about Channel Database](https://meshmonitor.org/features/channel-database)
