---
id: news-2026-02-25-auto-favorite
title: MeshMonitor v3.7.0 - Auto Favorite for Zero-Cost Hop Routing
date: '2026-02-25T18:00:00Z'
category: feature
priority: important
minVersion: 3.7.0
---
MeshMonitor v3.7.0 introduces **Auto Favorite**, a new automation feature that automatically favorites eligible nearby nodes for [zero-cost hop routing](https://meshtastic.org/blog/zero-cost-hops-favorite-routers/) on Meshtastic firmware 2.7+.

## Auto Favorite

When enabled on a **Router**, **Router Late**, or **Client Base** node, MeshMonitor automatically detects nearby 0-hop nodes and favorites them on your device — preserving hop counts across your mesh infrastructure without manual configuration.

### How It Works

- **Event-driven**: Eligible nodes are favorited as soon as they are detected (on NodeInfo updates)
- **Periodic cleanup**: A sweep runs every 60 minutes to unfavorite nodes that have gone stale, moved out of range, or changed roles
- **Manual favorites are never touched** — only auto-managed nodes are swept

### Eligibility Rules

| Your Node Role | Auto-Favorites |
|---|---|
| Client Base | All 0-hop nodes (any role) |
| Router / Router Late | 0-hop Router, Router Late, and Client Base nodes |

### Configuration

Find **Auto Favorite** in the **Automation** tab. Configure the staleness threshold (default 72 hours) — nodes not heard from within this period are automatically unfavorited. The UI shows warnings if your firmware or node role doesn't support the feature.

[Read more about zero-cost hops](https://meshtastic.org/blog/zero-cost-hops-favorite-routers/)

## Other Improvements

- **Position precision accuracy estimates** — Channel UI now shows estimated accuracy for position precision settings ([#2008](https://github.com/Yeraze/meshmonitor/pull/2008))
- **Location indicators on all channels** — All location-enabled channels now show location sharing indicators ([#2007](https://github.com/Yeraze/meshmonitor/pull/2007))
- **Packet routes fix** — Packet routes now use async DB methods for PostgreSQL/MySQL compatibility ([#2016](https://github.com/Yeraze/meshmonitor/pull/2016))
- **Duplicate chat messages fix** — Prevented duplicate outgoing messages in chat ([#2015](https://github.com/Yeraze/meshmonitor/pull/2015))
- **Map position updates** — Fixed position updates for mobile/tracker nodes and a WebSocket position bug ([#2014](https://github.com/Yeraze/meshmonitor/pull/2014))
- **Homoglyph byte count** — Corrected optimized byte count display when homoglyph setting is enabled ([#2009](https://github.com/Yeraze/meshmonitor/pull/2009))
- **Dependency updates** — Updated production dependencies ([#1992](https://github.com/Yeraze/meshmonitor/pull/1992))
