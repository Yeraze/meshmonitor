---
id: news-2026-05-23-offline-emergency-kit
title: Build a MeshMonitor Offline Emergency Kit — Tiles, Compose, Hardware
date: '2026-05-23T14:00:00Z'
category: guide
priority: normal
---
The [Hurricane Preparedness guide](/blog/2026-05-23-hurricane-preparedness) covers how to *operate* MeshMonitor through a storm. This one covers how to *build the box* you'll be operating from — a self-contained kit that boots cold, serves its own map tiles, and never reaches for the internet.

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

MeshMonitor's map points at standard XYZ tile endpoints — vector (`.pbf`) or raster (`.png`). See [Custom Tile Servers](/configuration/custom-tile-servers) for the full configuration story; the offline-kit recipe is below.

### TileServer GL + MBTiles

[TileServer GL](https://tileserver.readthedocs.io/) serves XYZ tiles from a single MBTiles file. Grab a regional MBTiles extract (Geofabrik, or build one with [planetiler](https://github.com/onthegomap/planetiler)) and run:

```bash
docker run --rm -it -v $(pwd)/tiles:/data -p 8080:8080 \
  maptiler/tileserver-gl --file /data/florida.mbtiles
```

Once the container is up, open MeshMonitor's **Settings → Map** and point the tile server URL at:

```
http://<host>:8080/styles/basic/{z}/{x}/{y}.png
```

(Substitute whatever style your MBTiles exposes — `tileserver-gl` lists them at `http://<host>:8080/`.) The MeshMonitor map config lives in the database, not in env vars, so the URL you set in the UI persists across restarts.

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
      - "8081:8080"      # MeshMonitor UI
      - "1883:1883"      # Embedded MQTT broker (v4.6.0+), if you enable it in Settings
    volumes:
      - ./meshmonitor-data:/data
    devices:
      # Pass through your serial-attached node (adjust path for your hardware)
      - /dev/ttyUSB0:/dev/ttyUSB0

  tiles:
    image: maptiler/tileserver-gl
    restart: unless-stopped
    command: ["--file", "/data/florida.mbtiles"]
    volumes:
      - ./tiles:/data:ro
    ports:
      - "8080:8080"
```

Drop your `.mbtiles` file in `./tiles/`, `docker compose up -d`, then open MeshMonitor and configure:

- **Settings → Map** → tile server URL → `http://<host>:8080/styles/basic/{z}/{x}/{y}.png`
- **Sources** → add your local Meshtastic/MeshCore source
- **Settings → MQTT Broker** → enable the embedded broker (v4.6.0+) if you want it; the `1883` port mapping above only matters once you turn it on

Both the tile URL and broker config persist in MeshMonitor's database — no env-var ceremony, no compose rewrites when you change them. Total cold-boot footprint: ~250 MB RAM, ~2 GB disk before tiles.

## Hardware

### The host computer

| Tier | Hardware | Idle draw | Notes |
|---|---|---|---|
| **Minimum** | [Raspberry Pi 4 (4 GB)](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/) | ~3 W | Works fine for one node, light tile traffic |
| **Recommended** | [Raspberry Pi 5 (8 GB)](https://www.raspberrypi.com/products/raspberry-pi-5/) + [NVMe HAT](https://www.raspberrypi.com/products/m2-hat-plus/) | ~5 W | Headroom for MQTT broker, multiple sources, larger tile cache |
| **Heavy** | Mini-PC (N100 / N305, e.g. [Beelink S12](https://www.bee-link.com/products/beelink-mini-s12-pro-n100)) | ~10 W | Native x86, faster tile renders, more storage, runs the whole stack with room to spare |

Avoid SD-card-only setups for long-running kits. SD cards fail under sustained write load — SQLite + telemetry will chew through a consumer card in months. **NVMe or USB SSD** for the data volume is worth the few extra dollars.

### The node

Pick whichever protocol your local mesh actually runs:

- **Meshtastic** — [Heltec V3](https://heltec.org/project/wifi-lora-32-v3/) (cheap, ubiquitous), [RAK WisBlock 4631](https://store.rakwireless.com/products/wisblock-meshtastic-starter-kit) (better antenna, expandable), [LILYGO T-Beam](https://www.lilygo.cc/products/t-beam-v1-1-esp32-lora-module) (built-in GPS + 18650).
- **MeshCore** — RAK 4631 with [MeshCore](https://meshcore.co.uk) firmware, or a Solo board.
- **Both** — MeshMonitor handles multiple sources cleanly since v4.0 (MeshCore added as a first-class source in v4.5); you can run one of each on USB and treat them as independent sources in the UI.

Whichever you pick, **the antenna matters more than the radio**. A $20 fiberglass collinear on a mast beats a $200 board with the stock rubber-duck whip every time.

### Power

| Component | Typical draw | 24h energy |
|---|---|---|
| Pi 5 + NVMe | ~5 W | ~120 Wh |
| USB-attached node | ~0.5 W | ~12 Wh |
| 7" touchscreen (optional) | ~3 W | ~72 Wh |

Round up for charging losses and call it **~250 Wh/day** for a Pi + node + screen.

- **Bench / RV** — [Bluetti EB3A](https://www.bluettipower.com/products/bluetti-eb3a-portable-power-station) (268 Wh) gets you ~1 day; [Jackery 500](https://www.jackery.com/products/explorer-500w-portable-power-station)/[Bluetti AC50S](https://www.bluetti.com/products/bluetti-ac50s-500wh-300w-portable-power-station) (~500 Wh) gets you ~2.
- **Field-portable** — 20 Ah USB-PD power bank → ~70 Wh, half a day headless.
- **Indefinite** — 100 W solar panel + a 500 Wh battery in Florida sun keeps the kit running through the season; sized down to ~50 W in northern latitudes.

A **[PoE+ HAT](https://www.raspberrypi.com/products/poe-plus-hat/) on the Pi** is genuinely useful if your kit lives in a closet — one cable to a PoE switch backed by a UPS, no separate power brick, no wall-wart to lose.

### Display (optional)

A headless kit accessed from a phone is the lightest option. If you want a glass-in-the-room dashboard, the official [7" Raspberry Pi Touch Display 2](https://www.raspberrypi.com/products/touch-display-2/) or a generic HDMI display + Chromium kiosk mode pointed at `http://localhost:8081` works well. Budget another ~3 W.

## Component reference

Visual reference for the hardware called out above — click through for the canonical product pages.

### Host computer

- [![Raspberry Pi 4 Model B](/images/blog/2026-05-23/raspberry-pi-4.png)](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/) — Raspberry Pi 4 Model B (4 GB)
- [![Raspberry Pi 5](/images/blog/2026-05-23/raspberry-pi-5.png)](https://www.raspberrypi.com/products/raspberry-pi-5/) — Raspberry Pi 5 (8 GB)
- [![Raspberry Pi M.2 HAT+](/images/blog/2026-05-23/pi-m2-nvme-hat.jpg)](https://www.raspberrypi.com/products/m2-hat-plus/) — Raspberry Pi M.2 HAT+ (NVMe)
- [![Beelink Mini S12 Pro](/images/blog/2026-05-23/beelink-s12.jpg)](https://www.bee-link.com/products/beelink-mini-s12-pro-n100) — Beelink Mini S12 Pro (N100)

### LoRa nodes

- [![Heltec WiFi LoRa 32 V3](/images/blog/2026-05-23/heltec-v3.png)](https://heltec.org/project/wifi-lora-32-v3/) — Heltec WiFi LoRa 32 V3
- [![RAK WisBlock Meshtastic Starter Kit (RAK4631)](/images/blog/2026-05-23/rak-4631.png)](https://store.rakwireless.com/products/wisblock-meshtastic-starter-kit) — RAK WisBlock Meshtastic Starter Kit (RAK4631)
- [![LILYGO T-Beam](/images/blog/2026-05-23/lilygo-t-beam.jpg)](https://www.lilygo.cc/products/t-beam-v1-1-esp32-lora-module) — LILYGO T-Beam

### Power

- [![Bluetti EB3A](/images/blog/2026-05-23/bluetti-eb3a.jpg)](https://www.bluettipower.com/products/bluetti-eb3a-portable-power-station) — Bluetti EB3A (268 Wh)
- [![Jackery Explorer 500](/images/blog/2026-05-23/jackery-explorer-500.png)](https://www.jackery.com/products/explorer-500w-portable-power-station) — Jackery Explorer 500
- [![Bluetti AC50S](/images/blog/2026-05-23/bluetti-ac50s.png)](https://www.bluetti.com/products/bluetti-ac50s-500wh-300w-portable-power-station) — Bluetti AC50S (500 Wh)
- [![Raspberry Pi PoE+ HAT](/images/blog/2026-05-23/pi-poe-plus-hat.jpg)](https://www.raspberrypi.com/products/poe-plus-hat/) — Raspberry Pi PoE+ HAT

### Display

- [![Raspberry Pi Touch Display 2](/images/blog/2026-05-23/pi-touch-display-2.jpg)](https://www.raspberrypi.com/products/touch-display-2/) — Raspberry Pi Touch Display 2 (7")

## Pre-flight checklist

Before you call the kit "done":

- [ ] Unplug your WAN. Reload MeshMonitor. Map tiles still render?
- [ ] Reboot the host. Does everything come back up without manual intervention?
- [ ] Power-cycle from battery only. Does it survive the brownout?
- [ ] Verify the node enumerates on the same `/dev/tty*` path after reboot (use a `udev` rule by serial if not).
- [ ] Snapshot `./meshmonitor-data` somewhere off-kit — your config is the most expensive part to lose.

## Further reading

- [MeshMonitor in a Hurricane](/blog/2026-05-23-hurricane-preparedness) — operating the kit through a real event
- [Embedded MQTT broker + bidirectional bridges](/blog/2026-05-17-embedded-mqtt-broker)
- [Firmware management](/blog/2026-03-03-firmware-management)
