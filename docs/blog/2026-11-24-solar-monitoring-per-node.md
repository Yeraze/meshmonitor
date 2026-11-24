---
id: news-2026-11-24-solar-monitoring-per-node
title: 'Solar Monitoring Rebuilt: Sunlight and Weather for Every Node'
date: '2026-11-24T18:00:00Z'
category: feature
priority: high
minVersion: 4.18.1
tags: [solar, telemetry, open-meteo, upgrade]
---

Solar Monitoring has been rebuilt. It used to draw one solar estimate for the whole mesh, from one location you typed in. Now **every node gets its own sunlight curve**, at its own position, with real cloud cover, and its charts show times in the **node's own time zone**.

This post covers what changed, what you'll see, and what to do when you upgrade. Read the [upgrade checklist](#upgrade-checklist) before you update: the old settings are gone, and the old solar API routes have moved.

## Why we changed it

The old feature used [forecast.solar](https://forecast.solar). You entered one latitude, longitude, tilt and azimuth, and MeshMonitor drew that one panel's expected output behind every node's graphs. That worked for a single site. On a mesh spread over a region it showed the same curve for a node in the sun and a node under a storm 80 km away. It also had a timezone bug ([#6523](https://github.com/Yeraze/meshmonitor/issues/6523)): forecast.solar returned local times that MeshMonitor read as UTC, so the curve sat hours off from the battery line.

We care about **trends**: did this battery dip because it was cloudy, or because the panel is failing? For that, local weather beats precise panel wattage.

## What's new

### A sunlight curve per node, from Open-Meteo

MeshMonitor now gets hourly **shortwave radiation (W/m²)** and **cloud cover (%)** from [Open-Meteo](https://open-meteo.com/) for each node's location. It draws that curve as a soft yellow area behind the node's telemetry lines:

- on the **Node Details** telemetry graphs (Meshtastic and MeshCore),
- on **Telemetry Dashboard** favourite charts,
- in **Analysis & Reports → Solar Monitoring Analysis**, under each solar node's battery line.

Hover a point to read the value, for example **Sunlight: 420 W/m²**. A sun button on each chart hides or shows the curve. CSV exports gain a `Sunlight W/m2` column.

All nodes share one baseline panel model. MeshMonitor no longer asks for tilt, direction or panel size, because the curve shows when and how much sun reached the node, not how many watts a given panel made.

### Grid cells keep the call count down

MeshMonitor rounds each node's position to a **grid cell** and fetches one forecast per cell. Nodes in the same cell share it. MeshMonitor fetches only for nodes heard in the last 7 days, on every source.

Open-Meteo's free tier allows non-commercial use under **10,000 calls a day**, and each cell counts as one call. The cost is:

```
calls per day = cells × 24 ÷ refresh hours
```

The settings page counts your active nodes and shows, for each grid size, how many cells that makes and the calls per day at your refresh interval. Pick the pair that fits your mesh. At the default 3-hour refresh, MeshMonitor's 9,000-call budget (below) covers about 1,100 cells.

Without an API key, MeshMonitor stays under **9,000 calls a day**. It keeps that count in the database, so a restart or a settings save never resets it. If your settings would need more, the page warns you and only the most recently heard cells get data.

![Solar Monitoring settings with API key, grid size, refresh interval and calls-per-day table](/images/features/6523-solar-settings.png)

### A per-node Analysis forecast

The **Solar Monitoring Analysis** report now forecasts each solar node from its own cell. It compares the next days' sunlight with that cell's recent average, flags **Low** days, and simulates the node's battery with its measured charge and drain rates. A node needs 3 days of stored sunlight before it gets a forecast.

![Solar Monitoring Analysis report with per-node sunlight under the battery line](/images/features/6523-solar-report.png)

### Charts in the node's time zone

Sunrise should line up with the node's morning, not yours. Telemetry charts now show times in the **node's** time zone, and a caption names it, for example *Times in America/New_York (from position)*. MeshMonitor picks the zone in this order:

1. **Override**: a zone set by hand for that node.
2. **From position**: looked up on the server from the node's position. No outside service is involved.
3. **Server**: the container's `TZ`, for a node with no position and no override.

A user with `nodes:write` can pin a node to a zone from the **Timezone override** list in its telemetry panel. Use it for a node with no GPS or one that sits near a zone border.

This applies to the Node Details graphs, Dashboard favourites, Unified Telemetry, the packet-rate and transport graphs, and MeshCore traceroute SNR charts. CSV exports keep UTC timestamps.

![Node telemetry panel with the time zone caption and override list](/images/features/6523-tz-node-panel.png)

## Privacy

When Solar Monitoring is on, MeshMonitor sends Open-Meteo the **centre of each grid cell**, never a node's exact position, and never a private Position Override. A viewer who can't see a node's position on the map gets no sunlight curve for it, and sees the server's time zone instead of the node's. The timezone lookup runs on your server.

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). MeshMonitor shows the credit under each chart that draws the curve.

## Upgrade checklist

**1. Review Global Settings → Solar Monitoring (admin only).**
Latitude, longitude, azimuth and declination are gone; MeshMonitor ignores any old values. Your **on/off toggle carries over**. If Solar Monitoring was on, MeshMonitor starts fetching from Open-Meteo within the hour. Before then, check:

- **Grid cell size**: 0.05°, 0.1° (default), 0.25°, 0.5° or 1°.
- **Refresh interval**: 1, 2, 3 (default), 6, 12 or 24 hours.
- **The calls-per-day table**: a warning means some cells won't get data. Pick a larger grid or a longer interval.

Click **Refresh Now** if you don't want to wait for the hourly pass.

**2. Decide whether you need an API key.**
Leave the key blank to use the free tier. It needs no sign-up, but it is for **non-commercial use only**. If you run MeshMonitor commercially, or need more than the free limits, buy a plan at [open-meteo.com/en/pricing](https://open-meteo.com/en/pricing) and paste the key in. Only admins can read it.

**3. Expect your old solar history to vanish.**
The upgrade deletes the stored forecast.solar estimates. They were tied to one location, and those rows sat hours off because of the timezone bug. Per-node history builds up from the first Open-Meteo pass, and the Analysis forecast appears once a node's cell has 3 days stored.

**4. Make sure the server can reach `api.open-meteo.com`.**
On a paid key it uses `customer-api.open-meteo.com` instead. If the container sits behind a firewall, allow outbound HTTPS to those hosts. `api.forecast.solar` is no longer used.

**5. Give positionless nodes a zone, if you care.**
A node with no position shows charts in the container's `TZ`. Set the container's `TZ` to your main zone, or pin those nodes with the Timezone override.

**6. Update scripts that use the solar API.** These are breaking changes:

| Old | New |
|-----|-----|
| `GET /api/v1/solar` and `GET /api/v1/solar/range` | `GET /api/v1/sources/:sourceId/solar` (per node) |
| `GET /api/solar/estimates`, `/api/solar/estimates/range` | `GET /api/solar/irradiance?sourceId=&nodeId=&start=&end=` |
| `POST /api/solar/trigger` | `POST /api/solar/refresh` (admin) |
| `GET /api/analysis/solar-forecast` | Unchanged path; the response is now per node |

New: `GET /api/solar/usage` (admin) returns the active node and cell counts, and `GET /api/nodes/timezone?sourceId=&nodeId=` / `PUT /api/nodes/timezone` with `{ sourceId, nodeId, timeZone }` read and set a node's zone.

## Troubleshooting

- **No curve on a graph**: check that Solar Monitoring is on, the node has a position you can see on the map, and its cell has been fetched (or click **Refresh Now**). On the free tier, check for the budget warning.
- **`429` in the server log**: Open-Meteo is rate-limiting you. The pass stops until the next hourly tick. Use a larger grid, a longer interval, or a key.
- **Wrong time zone on a chart**: read the caption. *(server)* means the node has no position you can see; set an override.

Full details are in the [Solar Monitoring guide](/features/solar-monitoring) and the [Node Time Zone](/features/telemetry-widgets#node-time-zone) section.
