---
id: news-2026-03-15-distance-delete-traceroute
title: MeshMonitor v3.9.4 - Auto Delete by Distance & Traceroute Improvements
date: '2026-03-15T18:00:00Z'
category: feature
priority: important
minVersion: 3.9.4
---
MeshMonitor v3.9.4 introduces **Auto Delete by Distance**, a new automation feature that automatically removes nodes beyond a configurable distance threshold from your home coordinate.

## Auto Delete by Distance

Keep your node database focused on your local mesh by automatically purging distant nodes that are unlikely to be relevant.

### Key Features

- **Home coordinate** — Set your location manually or use your connected node's position
- **Distance threshold** — Configure the maximum distance (in km or miles) to keep nodes
- **Configurable interval** — Run cleanup every 6, 12, 24, or 48 hours
- **Protected nodes** — Favorited nodes and your local node are never deleted
- **Activity log** — Track what was deleted and when
- **Run Now** — Trigger an immediate cleanup from the Automation tab

Find it in **Automation > Auto Delete by Distance**.

## Auto Traceroute Improvements

- **Retraceroute After** now accepts **0 hours**, meaning nodes are always eligible for retraceroute on every cycle ([#2269](https://github.com/Yeraze/meshmonitor/issues/2269))
- **Minimum interval** raised to **3 minutes** to prevent excessive mesh traffic

## Bug Fixes

- **Multi-database parity** — Implemented missing PostgreSQL/MySQL methods for full feature parity across all backends ([#2267](https://github.com/Yeraze/meshmonitor/pull/2267))
- **Auto-key repair** — Fixed state tracking on PostgreSQL/MySQL and improved device DB awareness ([#2264](https://github.com/Yeraze/meshmonitor/pull/2264))
- **Translation updates** — Updated Spanish translations ([#2271](https://github.com/Yeraze/meshmonitor/pull/2271))
