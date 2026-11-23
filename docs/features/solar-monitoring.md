# Solar Monitoring

Solar Monitoring overlays the hourly sunlight at each node's location on that node's telemetry graphs, so you can line up battery charging with the weather. The data comes from [Open-Meteo](https://open-meteo.com/) weather forecasts.

## Overview

When Solar Monitoring is on, MeshMonitor:

- groups every node with a known position into grid cells (0.1° ≈ 11 km by default),
- fetches an hourly forecast of shortwave radiation (W/m²) and cloud cover (%) for each cell from Open-Meteo,
- draws that node's sunlight curve behind its telemetry lines on the Node Details graphs and the Telemetry Dashboard.

Each node gets its own curve. Nodes in the same cell share one forecast.

This helps you:

- see whether a battery dip lines up with a cloudy day or a failing panel,
- spot nodes that charge less than their neighbours under the same sky,
- plan visits for days when a remote node will have spare power.

## Configuration

Solar Monitoring lives in **Global Settings → Solar Monitoring** and is admin-only. Tick the checkbox to turn it on, then pick:

| Setting | What it does |
|---------|--------------|
| **Open-Meteo API key** (optional) | Leave blank to use Open-Meteo's free tier: non-commercial use, under 10,000 calls a day, no sign-up. A key is only for paid plans (commercial use or higher limits), from [open-meteo.com/en/pricing](https://open-meteo.com/en/pricing). With a key MeshMonitor uses Open-Meteo's customer API host. The key is stored server-side and only admins can read it. |
| **Grid cell size** | 0.05° (≈ 5.5 km), 0.1° (≈ 11 km, default), 0.25° (≈ 28 km), 0.5° (≈ 55 km) or 1° (≈ 111 km). Nodes in the same cell share one forecast. Larger cells mean fewer calls but coarser weather. |
| **Refresh interval** | 1, 2, 3 (default), 6, 12 or 24 hours. How often each cell's forecast is fetched again. |

Click **Save Settings**. The scheduler runs hourly and fetches only cells older than the refresh interval; **Refresh Now** starts a pass right away.

### Call budget

Open-Meteo counts each location as a call, so the cost is roughly:

```
calls per day = cells × 24 ÷ refresh hours
```

The settings page shows how many nodes were heard in the last 7 days and, for each grid size, how many cells that makes and the calls per day at the refresh interval you picked. The row for the selected grid is highlighted.

Without an API key MeshMonitor keeps under a budget of **9,000 calls a day**, leaving headroom below the free tier's limit. If your choice would need more, a warning appears: only the most recently heard cells (as many as the budget allows) get data. Pick a larger grid, a longer interval, or add a key. MeshMonitor also counts every call against a per-day counter stored in the database, so a restart or a settings save never resets the budget.

## Visualization

The sunlight curve is a translucent yellow area behind the telemetry line, on a hidden right-hand axis. Hover a point to see it in the tooltip, for example **Sunlight: 420 W/m²**. Use the sun button on each graph to show or hide it; the Dashboard remembers your choice per chart.

The curve appears on:

- **Node Details** telemetry graphs (Meshtastic and MeshCore nodes),
- **Telemetry Dashboard** favourite charts.
- **Analysis & Reports → Solar Monitoring Analysis**, under each detected solar node's battery line. Its forecast compares each node's coming days with its own cell's recent average; see [Analysis & Reports](/features/analysis-reports).

A node shows no curve when it has no position, when you cannot see its position, or when its cell has not been fetched yet. A chart's CSV export adds a `Sunlight W/m2` column while the overlay has data.

## Privacy

When Solar Monitoring is on, the **rounded position (the cell centre)** of every node heard in the last 7 days is sent to Open-Meteo. Exact positions are never sent, and private position overrides are never sent. A viewer who cannot see a node's position on the map gets no sunlight curve for that node.

## Attribution

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). MeshMonitor shows this credit under any chart that draws the overlay and in the settings section.

## API Endpoints

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| `GET` | `/api/solar/irradiance?sourceId=&nodeId=&start=&end=` | Same as the node's telemetry | Hourly sunlight and cloud cover for one node's cell. `nodeId` is `!hex` (Meshtastic) or the 64-hex public key (MeshCore); `start`/`end` are Unix seconds, up to 31 days apart. |
| `GET` | `/api/solar/usage` | Admin | Active node count and cells per grid size, for the call estimate. |
| `POST` | `/api/solar/refresh` | Admin | Start one refresh pass and return at once. Cells refreshed within the interval are skipped and the daily budget still applies. |

Example response from `/api/solar/irradiance`:

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "points": [
      { "timestamp": 1704067200, "shortwaveRadiation": 420, "cloudCover": 15 },
      { "timestamp": 1704070800, "shortwaveRadiation": null, "cloudCover": 80 }
    ]
  }
}
```

The v1 API serves the same data; see the [API reference](/development/api-reference).

## Troubleshooting

**No overlay on a graph**

- Check that Solar Monitoring is on and saved in Global Settings.
- Check that the node has a position and that you can see it on the map.
- Wait for the next pass, or click **Refresh Now**.
- On the free tier, check the budget warning: the node's cell may be past the cap.

**429 errors in the server log**

Open-Meteo is rate-limiting you. The pass stops and nothing retries until the next hourly tick. Pick a larger grid or a longer interval, or add an API key.

## Related Documentation

- [Settings](/features/settings)
- [Telemetry Widgets](/features/telemetry-widgets)
- [Analysis & Reports](/features/analysis-reports)
