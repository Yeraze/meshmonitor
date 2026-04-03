# Homepage Refresh

MeshMonitor's public website ([meshmonitor.org](https://meshmonitor.org)) was refreshed with updated hero content, corrected feature cards, and clearer Quick Start instructions.

## What Changed

### New Hero

The landing page hero was updated to reflect MeshMonitor's self-hosted, privacy-first positioning:

- **Headline**: "Your mesh. Your data."
- **Tagline**: "Self-hosted Meshtastic monitoring with real-time maps, alerts, and full network awareness."
- **Hero image**: A new `main.png` screenshot now appears alongside the hero text on wide viewports.

### Updated Feature Cards

Several feature cards were expanded with more specific detail:

| Card | What was added |
|------|----------------|
| **Interactive Map View** | GeoJSON/KML/KMZ overlay import; polar grid overlay for RF coverage visualization |
| **Comprehensive Analytics** | Reference to chart, gauge, and numeric telemetry display modes |
| **Message Management** | Drag-and-drop channel reordering |
| **Custom Map Tile Servers** | Custom MapLibre style JSON upload for branded or offline-first appearances |
| **Automation & Triggers** | Explicit mention of Geofence Triggers with enter/exit/dwell events and custom Python/Bash scripting |

### New Desktop Application Card

A new feature card was added for the native desktop app:

> "Run MeshMonitor as a native app on Windows or macOS — no server, no Docker, no dependencies. System tray integration keeps your network awareness one click away."

### Card Consolidation

The previous **Automation**, **Geofence Triggers**, and **Custom Scripting** cards were merged into a single **Automation & Triggers** card, reducing the total card count from 17 to 15. The **Responsive Design** card was removed (responsiveness is a baseline expectation rather than a feature).

### Quick Start CORS Fix

The docker-compose snippet in the Quick Start section now includes `ALLOWED_ORIGINS`:

```yaml
environment:
  - MESHTASTIC_NODE_IP=192.168.1.100
  - ALLOWED_ORIGINS=http://localhost:8080  # Required for CORS
```

This prevents CORS errors when the browser and MeshMonitor are on different origins (e.g., accessing from a LAN device).

### Screenshot References

Two broken screenshot references in the "Screenshots" section were corrected:

| Before | After |
|--------|-------|
| Telemetry Dashboard | Message History |
| Device Config | User Management |

### Meta Description

The VitePress `description` field in `.vitepress/config.mts` was updated to match the new tagline, improving search engine result previews.

## Related

- [Desktop Application](device.md) — native Windows/macOS app details
- [Telemetry Widget Display Modes](telemetry-widgets.md) — chart, gauge, and numeric modes
- [Custom Map Tile Servers](maps.md) — tile server configuration and MapLibre style JSON
- [Automation & Triggers](automation.md) — auto-responders, geofence triggers, and scripting
