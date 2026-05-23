---
id: news-2026-05-23-hurricane-preparedness
title: MeshMonitor in a Hurricane — Off-Grid Comms, Power Outages, and Mesh Resilience
date: '2026-05-23T12:00:00Z'
category: guide
priority: normal
---
Hurricane season is the moment a Meshtastic deployment stops being a hobby and starts being infrastructure. When the power flickers, cell towers saturate, and your ISP's upstream goes dark, the mesh you spent months tuning becomes the thing your neighborhood actually relies on. This article walks through how to use MeshMonitor before, during, and after a storm — keeping situational awareness on your nodes when everything else is failing around them.

> **TODO (Randall):** Open with a real story or a specific storm — anchors the article better than a generic intro.

## Before the storm — preparedness

A hurricane is the worst time to discover that half your nodes have stale firmware, your MQTT bridge has been silently dropping packets for a week, or your battery-backed gateway has been running off mains the whole time without you noticing.

### Audit your nodes

- **Firmware health** — Settings → Firmware Updates (admin-gated). Bring any straggler nodes up to a known-good version *now*, not during landfall.
- **Battery telemetry** — Sort the node list by `battery` ascending. Anything below ~80% going into the storm is a node that may not survive a multi-day outage.
- **Last-seen sweep** — Filter for nodes whose `lastHeard` is older than 24h. A node you can't see today is a node that isn't coming back tomorrow.

### Test your fallback paths

- **MQTT bridge filters** — Confirm your bounding-box filter is still scoped to your region so you don't drown in nationwide traffic when public brokers spike during the event.
- **Power-loss notifications** — Configure push notifications for the channels you actually need (battery low, node offline, gateway disconnected). Don't subscribe to everything — alert fatigue during a storm is real.
- **Local-only mode** — Make sure MeshMonitor still works with no upstream MQTT. Pull the WAN cable, refresh the dashboard, verify ingestion from RF-only sources.

> **TODO (Randall):** Add a screenshot of the firmware-health table here.

## During the storm — situational awareness

### Watching nodes through power outages

When the grid goes down, your nodes start running off whatever battery + solar + UPS situation each site has. MeshMonitor's per-node telemetry chart is the single best way to track this in real time:

- **Voltage trend, not just battery percentage** — battery `%` is a derived value and lies near the endpoints; raw voltage tells the truth.
- **Temperature** — a gateway in a hot attic with no AC will start throttling or shutting down well before its battery is the limit.
- **Channel utilization** — spikes here usually mean the mesh is being flooded (panicked neighbors, retries, MQTT downlink). Worth knowing before it eats your airtime.

### Off-grid messaging

The mesh keeps working when LTE is saturated and your fiber is cut. A few practical patterns:

- **A "storm" channel** — pre-share a PSK with your immediate neighbors so you have a low-traffic channel that isn't drowning in public-channel noise.
- **Position beacons cranked down** — during the storm, bump position broadcast intervals up (less frequent) to save airtime and battery on every node in range.
- **Auto-ack on critical channels** — so you actually know whether your "is everyone okay?" message got delivered, instead of guessing.

> **TODO (Randall):** Concrete recommendations for beacon intervals during emergencies?

### Geofencing for damage reports

The geofence-trigger system can be repurposed during a storm: define a polygon over the worst-hit area, and have any node entering or reporting from inside it raise an alert. Useful for SAR coordination, or just knowing which neighbors are mobile post-landfall.

## After the storm — recovery

### Triage your fleet

- **Sort by `lastHeard` descending** — nodes that came back first are likely on generator power or never lost it. Nodes still missing 48h later may be physically damaged.
- **Telemetry gaps** — the database refactor in 4.0 makes it easy to query "show me every node that has a gap > 6h in the last 72h." That's your damage map.
- **Position drift** — a node whose reported position has drifted significantly post-storm may have physically moved (debris, flooding, someone walked off with it).

### Restore upstream bridges carefully

When public MQTT brokers come back online post-storm, they're going to be *noisy*. Re-enable bridges one at a time, verify the bounding-box and portnum filters are still doing their job, and watch your ingest rate before turning on the firehose.

> **TODO (Randall):** Anything about coordinating with regional Meshtastic groups for shared situational awareness?

## What MeshMonitor doesn't do (yet)

Be honest about the gaps:

- No built-in emergency-services integration. The mesh is *your* mesh; it's not talking to 911 or the NWS.
- No automatic battery-runtime estimation per node — you have to eyeball voltage curves.
- Push notifications depend on your phone having a network — useful at the start of an event, less useful at hour 36 of an outage.

> **TODO (Randall):** Anything else from your real-world experience that should go here?

## Further reading

- [Offline Emergency Kit — Tiles, Compose, Hardware](/blog/2026-05-23-offline-emergency-kit) — the companion piece on *building* the box this article assumes you're running.
- [Embedded MQTT broker + bidirectional bridges](/blog/2026-05-17-embedded-mqtt-broker)
- [Geofence triggers](/blog/2026-01-28-geofence-triggers)
- [Auto-ack](/blog/2026-02-08-autoack-mfa)
- [Firmware management](/blog/2026-03-03-firmware-management)
