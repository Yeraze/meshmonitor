---
id: news-2026-05-23-offline-emergency-kit
title: Build a MeshMonitor Offline Emergency Kit — Tiles, Compose, Hardware
date: '2026-05-23T14:00:00Z'
category: guide
priority: normal
---
The [Hurricane Preparedness guide](./2026-05-23-hurricane-preparedness.md) covers how to *operate* MeshMonitor through a storm. This one covers how to *build the box* you'll be operating from — a self-contained kit that boots cold, serves its own map tiles, and never reaches for the internet.

The target deployment: a single small computer, a LoRa node, a battery, and a map of your region pre-loaded to disk. Everything below assumes you want zero external dependencies once the grid is down.

## The pieces

| Component | Purpose |
|---|---|
| MeshMonitor | Dashboard, persistence, embedded MQTT broker (v4.6.0+) |
| Local tile server | Renders the map without `tile.openstreetmap.org` |
| LoRa node | Your physical link into the mesh (Meshtastic, MeshCore, or both) |
| Host computer | Runs the above; sized for your battery budget |
| Power | Determines how long the kit survives without grid power |

## Local map tiles

MeshMonitor's map will happily point at any XYZ raster or PMTiles endpoint. Two pragmatic options:

### Option A — PMTiles (simplest)

[PMTiles](https://protomaps.com/docs/pmtiles) is a single-file format you serve with plain HTTP. No tile-rendering service to manage.

```bash
# Install the pmtiles CLI (one-time)
brew install protomaps/tap/pmtiles    # macOS
# or download a release binary from github.com/protomaps/go-pmtiles

# Grab a regional extract from Protomaps' build server
# (replace bbox with your region — this is roughly Florida)
pmtiles extract \
  https://build.protomaps.com/20260501.pmtiles \
  florida.pmtiles \
  --bbox=-87.7,24.4,-79.9,31.1
```

Resulting file size depends on the region — a single US state is typically **150–600 MB**. A whole country is multi-GB; size it for the SD card you actually have.

Serve it with anything that supports HTTP range requests (Caddy, nginx, even `python -m http.server` in a pinch):

```yaml
# in your docker-compose.yml
tiles:
  image: caddy:2
  restart: unless-stopped
  volumes:
    - ./tiles:/srv:ro
    - ./Caddyfile:/etc/caddy/Caddyfile:ro
  ports:
    - "8080:80"
```

```caddy
# Caddyfile
:80 {
  root * /srv
  file_server browse
  header Access-Control-Allow-Origin *
  header Cache-Control "public, max-age=2592000, immutable"
}
```

### Option B — TileServer GL (raster XYZ)

If you prefer classic XYZ raster tiles (more universally supported by older Leaflet setups), use [TileServer GL](https://tileserver.readthedocs.io/) with an MBTiles file:

```bash
# Download a regional MBTiles extract from Geofabrik or build with planetiler
docker run --rm -it -v $(pwd)/tiles:/data -p 8080:8080 \
  maptiler/tileserver-gl --file /data/florida.mbtiles
```

Point MeshMonitor's map base URL at `http://<host>:8080/styles/basic/{z}/{x}/{y}.png` (or whatever style your MBTiles exposes).

**Sizing rule of thumb:** zoom 0–12 for an entire US state fits in ~1 GB; add zoom 13–14 only for the neighborhoods you actually care about — every additional zoom level roughly quadruples size.

## A prebuilt docker-compose

Drop this on your kit machine and `docker compose up -d`:

```yaml
# docker-compose.yml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    restart: unless-stopped
    ports:
      - "8081:8080"
    volumes:
      - ./meshmonitor-data:/data
    environment:
      # Point MeshMonitor at the local tile server
      MAP_TILE_URL: "http://localhost:8080/florida.pmtiles"
      # Embedded MQTT broker (v4.6.0+) — your mesh's home base, no external broker
      MQTT_BROKER_ENABLED: "true"
      MQTT_BROKER_PORT: "1883"
    devices:
      # Pass through your serial-attached node (adjust path for your hardware)
      - /dev/ttyUSB0:/dev/ttyUSB0

  tiles:
    image: caddy:2
    restart: unless-stopped
    volumes:
      - ./tiles:/srv:ro
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    ports:
      - "8080:80"
```

Drop your `.pmtiles` file in `./tiles/`, your Caddyfile next to the compose file, and you're done. Total cold-boot footprint: ~250 MB RAM, ~2 GB disk before tiles.

> Confirm the exact `MAP_TILE_URL` (and any related) env-var names against your installed MeshMonitor version — the variable name has shifted across releases. `docker exec meshmonitor env | grep -i tile` is the fastest check.

## Hardware

### The host computer

| Tier | Hardware | Idle draw | Notes |
|---|---|---|---|
| **Minimum** | Raspberry Pi 4 (4 GB) | ~3 W | Works fine for one node, light tile traffic |
| **Recommended** | Raspberry Pi 5 (8 GB) + NVMe HAT | ~5 W | Headroom for MQTT broker, multiple sources, larger tile cache |
| **Heavy** | Mini-PC (N100 / N305, e.g. Beelink S12) | ~10 W | Native x86, faster tile renders, more storage, runs the whole stack with room to spare |

Avoid SD-card-only setups for long-running kits. SD cards fail under sustained write load — SQLite + telemetry will chew through a consumer card in months. **NVMe or USB SSD** for the data volume is worth the few extra dollars.

### The node

Pick whichever protocol your local mesh actually runs:

- **Meshtastic** — Heltec V3 (cheap, ubiquitous), RAK WisBlock 4631 (better antenna, expandable), LILYGO T-Beam (built-in GPS + 18650).
- **MeshCore** — RAK 4631 with MeshCore firmware, or a Solo board.
- **Both** — MeshMonitor handles multiple sources cleanly since v4.5; you can run one of each on USB and treat them as independent sources in the UI.

Whichever you pick, **the antenna matters more than the radio**. A $20 fiberglass collinear on a mast beats a $200 board with the stock rubber-duck whip every time.

### Power

| Component | Typical draw | 24h energy |
|---|---|---|
| Pi 5 + NVMe | ~5 W | ~120 Wh |
| USB-attached node | ~0.5 W | ~12 Wh |
| 7" touchscreen (optional) | ~3 W | ~72 Wh |

Round up for charging losses and call it **~250 Wh/day** for a Pi + node + screen.

- **Bench / RV** — Bluetti EB3A (268 Wh) gets you ~1 day; Jackery 500/Bluetti AC50S (~500 Wh) gets you ~2.
- **Field-portable** — 20 Ah USB-PD power bank → ~70 Wh, half a day headless.
- **Indefinite** — 100 W solar panel + a 500 Wh battery in Florida sun keeps the kit running through the season; sized down to ~50 W in northern latitudes.

A **PoE+ HAT on the Pi** is genuinely useful if your kit lives in a closet — one cable to a PoE switch backed by a UPS, no separate power brick, no wall-wart to lose.

### Display (optional)

A headless kit accessed from a phone is the lightest option. If you want a glass-in-the-room dashboard, the official 7" Raspberry Pi Touch Display 2 or a generic HDMI display + Chromium kiosk mode pointed at `http://localhost:8081` works well. Budget another ~3 W.

## Pre-flight checklist

Before you call the kit "done":

- [ ] Unplug your WAN. Reload MeshMonitor. Map tiles still render?
- [ ] Reboot the host. Does everything come back up without manual intervention?
- [ ] Power-cycle from battery only. Does it survive the brownout?
- [ ] Verify the node enumerates on the same `/dev/tty*` path after reboot (use a `udev` rule by serial if not).
- [ ] Snapshot `./meshmonitor-data` somewhere off-kit — your config is the most expensive part to lose.

## Further reading

- [MeshMonitor in a Hurricane](./2026-05-23-hurricane-preparedness.md) — operating the kit through a real event
- [Embedded MQTT broker + bidirectional bridges](/blog/2026-05-17-embedded-mqtt-broker)
- [Firmware management](/blog/2026-03-03-firmware-management)
