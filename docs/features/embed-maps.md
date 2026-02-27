# Embed Maps

MeshMonitor can generate embeddable map widgets that display your mesh network on external websites. Each embed profile controls which channels, map settings, and visual features are shown, and the profile ID acts as the access token — no login required for viewers.

## Overview

Embed Maps let you share a live, read-only view of your mesh network on any website using a standard `<iframe>`. Each embed profile is an independent configuration that controls:

- **Channel filtering** — choose which channels to display
- **Map tileset** — any built-in or custom tileset
- **Default center and zoom** — where the map opens
- **Visual features** — tooltips, popups, legend, traceroute paths, neighbor info lines
- **MQTT filtering** — optionally hide MQTT-relayed nodes
- **Polling interval** — how often the embed refreshes data
- **Allowed origins** — which domains can embed the map (enforced via CSP `frame-ancestors`)

You can create multiple profiles to serve different audiences — for example, one public-facing profile showing all channels and another restricted to a single channel for a community group.

## Creating an Embed Profile

1. Navigate to **Settings** > **Embed Maps**
2. Click **Create Embed Profile**
3. Fill in the profile settings (see [Profile Settings](#profile-settings) below)
4. Click **Save**

When creating a new profile, MeshMonitor automatically computes the map center from your active nodes so the default view covers your network.

## Profile Settings

### General

| Setting | Description | Default |
|---------|-------------|---------|
| **Name** | Internal label for this profile (not shown to viewers) | — |
| **Enabled** | Whether the embed is active; disabled profiles return 404 | `true` |

### Channels

Select which Meshtastic channels to include. Only nodes on the selected channels appear on the embedded map. Channel 0 (Primary) is selected by default.

### Map Defaults

| Setting | Description | Default |
|---------|-------------|---------|
| **Tileset** | Map tile layer (OpenStreetMap, Satellite, Dark, etc.) | OpenStreetMap |
| **Default Latitude** | Initial map center latitude | Computed from active nodes |
| **Default Longitude** | Initial map center longitude | Computed from active nodes |
| **Default Zoom** | Initial zoom level (1–18) | Computed from node spread |

Use the interactive map picker in the settings form to visually set the center and zoom — click to place the center point, and zoom in/out to set the default zoom level.

### Display Options

| Setting | Description | Default |
|---------|-------------|---------|
| **Show Tooltips** | Display node name on hover | `true` |
| **Show Popups** | Show detailed info popup on click | `true` |
| **Show Legend** | Display the hop-count color legend | `true` |
| **Show Paths** | Draw traceroute path lines between nodes | `false` |
| **Show Neighbor Info** | Draw neighbor connection lines | `false` |
| **Show MQTT Nodes** | Include nodes received via MQTT | `true` |

### Polling

| Setting | Description | Default |
|---------|-------------|---------|
| **Poll Interval** | Seconds between data refreshes (minimum 10) | `30` |

### Allowed Origins

A list of domains permitted to embed this map. This controls the CSP `frame-ancestors` directive sent with embed responses.

**Examples:**
- `https://example.com` — allow only this specific origin
- `https://*.example.com` — allow all subdomains
- `*` — allow any origin (not recommended for production)

If no origins are specified, only the MeshMonitor host itself (`'self'`) can embed the map.

## Embedding on Your Website

After saving a profile, click the **Copy Embed Code** button to copy a ready-to-use HTML snippet:

```html
<iframe
  src="https://your-meshmonitor.example.com/meshmonitor/embed/PROFILE_ID/embed.html"
  width="800"
  height="600"
  style="border: none;"
  allow="geolocation"
></iframe>
```

Replace the URL with your actual MeshMonitor URL and the profile ID. Adjust `width` and `height` to fit your site layout — the map is fully responsive and fills the iframe.

::: tip Responsive Sizing
For a responsive embed, use percentage-based or viewport-based sizing:
```html
<iframe
  src="https://your-meshmonitor.example.com/meshmonitor/embed/PROFILE_ID/embed.html"
  style="border: none; width: 100%; height: 500px;"
  allow="geolocation"
></iframe>
```
:::

## Map Features

### Hop-Colored Markers

Each node is displayed with a color-coded marker indicating its hop count from your gateway:

| Hops | Color | Meaning |
|------|-------|---------|
| 0 | Green | Direct / local node |
| 1 | Blue | 1 hop away |
| 2 | Cyan | 2 hops |
| 3 | Yellow | 3 hops |
| 4 | Orange | 4 hops |
| 5 | Red-orange | 5 hops |
| 6 | Red | 6 hops |
| Unknown | Gray | Hop count unavailable |

Router nodes display a tower icon; all other roles use a pin marker.

### Node Popups

When **Show Popups** is enabled, clicking a node marker opens a detailed popup showing:

- **Node ID** — hexadecimal identifier
- **Role** — Client, Router, Router Client, etc.
- **Hardware** — device model name
- **Hops** — hop count from gateway
- **Altitude** — if position data includes elevation
- **SNR** — signal-to-noise ratio
- **Channel** — channel number
- **Last Heard** — timestamp of last communication

The popup uses a dark theme matching MeshMonitor's Catppuccin styling.

### Neighbor Info Lines

When **Show Neighbor Info** is enabled, dashed orange lines connect nodes that report each other as neighbors. Both nodes must pass the profile's channel and MQTT filters to appear.

### Traceroute Paths

When **Show Paths** is enabled, solid purple lines show traceroute path segments between nodes. MeshMonitor decomposes multi-hop traceroutes into individual point-to-point segments and deduplicates them, keeping the most recent instance. Only traceroutes from the last 24 hours are displayed.

### Hop Count Legend

When **Show Legend** is enabled, a color legend appears in the bottom-right corner of the map showing the hop-count color scale.

## Security

### Profile ID as Token

The embed profile's UUID acts as the authorization token. Anyone with the profile ID can access the filtered node data through the public embed endpoints. Treat profile IDs like API keys:

- Do not share profile IDs beyond their intended audience
- Disable or delete profiles you no longer need
- Use **Allowed Origins** to restrict which sites can embed the map

### Content Security Policy

Each embed response includes a CSP header with a `frame-ancestors` directive built from the profile's allowed origins. This prevents unauthorized sites from embedding your map even if they obtain the profile ID.

### Data Exposure

The embed endpoints only return public-safe fields needed for map display:

- Node name, short name, hardware model
- Position (latitude, longitude, altitude)
- Last heard timestamp, SNR, hop count, role, channel
- Neighbor info connections and traceroute segments

Sensitive data such as node IP addresses, MQTT configuration, encryption keys, and user accounts are never exposed through embed endpoints.

### No Session Required

Embed endpoints operate outside the authenticated API. They bypass CSRF protection and rate limiting since the profile ID itself controls access. The embed CSP middleware validates the profile exists and is enabled before serving any data.

## Troubleshooting

### Embed Shows "Profile Not Found"

- Verify the profile is **Enabled** in Settings > Embed Maps
- Check that the profile ID in the iframe URL matches exactly
- Ensure MeshMonitor is accessible from the embedding site's network

### Map Appears but No Nodes

- Check that the profile's **Channels** include channels with active nodes
- Verify nodes have valid GPS positions (latitude and longitude)
- If **Show MQTT Nodes** is off, MQTT-relayed nodes are filtered out
- Confirm nodes have been heard within the last 7 days

### Embed Blocked by Browser

- Add the embedding site's origin to the profile's **Allowed Origins**
- Origins must include the protocol (e.g., `https://example.com`, not just `example.com`)
- Check the browser console for CSP `frame-ancestors` violations

### No Traceroute Lines Visible

- Ensure **Show Paths** is enabled in the profile settings
- Traceroutes must exist in the database (nodes need to have run traceroutes)
- Only traceroutes from the last 24 hours are shown
- Both endpoints of each segment must be visible nodes (matching channel/MQTT filters)

### No Neighbor Info Lines

- Ensure **Show Neighbor Info** is enabled in the profile settings
- Neighbor info requires nodes to broadcast neighbor reports
- Both nodes in a neighbor pair must pass the profile's filters

## Related Documentation

- [Interactive Maps](/features/maps) — main MeshMonitor map features and tilesets
- [Custom Tile Servers](/configuration/custom-tile-servers) — self-hosted tile server setup
- [Settings](/features/settings) — general MeshMonitor settings
- [Security Features](/features/security) — node security indicators
