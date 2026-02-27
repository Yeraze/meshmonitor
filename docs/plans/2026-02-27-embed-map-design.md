# Embeddable Map Feature Design

**Date:** 2026-02-27
**Status:** Approved

## Overview

Allow MeshMonitor administrators to create embeddable map views that can be included in
external websites via `<iframe>`. Each embed is configured as a "profile" stored in the
database, with a unique URL. The admin configures channels, tileset, default view, and
interactivity options through a Settings UI panel.

## Requirements

- **Audience:** Self-hosters embedding on their own sites
- **Delivery:** iframe to a dedicated embed URL
- **Updates:** Polling (configurable interval, default 30s) — no WebSocket
- **Interactivity:** Configurable per-embed (tooltips, popups, legend, paths, etc.)
- **Config storage:** Server-side profiles in the database
- **Auth:** Anonymous user — no login required. Admin must grant anonymous read access to desired channels.

## Architecture: Separate Vite Entry Point

A second Vite entry point (`embed.html` + `src/embed.tsx`) builds a minimal React app
containing only the map and its dependencies. Express serves this at `/embed/:profileId`.
The embed app fetches config from `/api/embed/:profileId/config`, then renders a
stripped-down Leaflet map.

### Why This Approach

- Small bundle — only map + Leaflet, no full app code
- Clean separation — embed code doesn't bloat the main app
- Shares code with main app (tilesets, types, marker logic)
- Vite supports multi-page apps natively

## Data Model

### New Table: `embed_profiles`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (UUID) | Primary key, used in embed URL |
| `name` | TEXT | Human-readable name |
| `enabled` | BOOLEAN | Whether this embed is active |
| `channels` | TEXT (JSON array) | Channel numbers to show, e.g. `[0, 1]` |
| `tileset` | TEXT | Tileset ID (predefined or custom UUID) |
| `defaultLat` | REAL | Default map center latitude |
| `defaultLng` | REAL | Default map center longitude |
| `defaultZoom` | INTEGER | Default zoom level |
| `showTooltips` | BOOLEAN | Show node name tooltips on hover |
| `showPopups` | BOOLEAN | Show detail popups on click |
| `showLegend` | BOOLEAN | Show the map legend |
| `showPaths` | BOOLEAN | Show connection paths |
| `showNeighborInfo` | BOOLEAN | Show neighbor info overlays |
| `showMqttNodes` | BOOLEAN | Show MQTT-connected nodes |
| `pollIntervalSeconds` | INTEGER | Polling interval (default 30) |
| `allowedOrigins` | TEXT (JSON array) | Origins permitted to embed this |
| `createdAt` | DATETIME | Creation timestamp |
| `updatedAt` | DATETIME | Last update timestamp |

## API Endpoints

### Admin (requireAdmin)

- `GET /api/embed-profiles` — list all profiles
- `POST /api/embed-profiles` — create profile
- `PUT /api/embed-profiles/:id` — update profile
- `DELETE /api/embed-profiles/:id` — delete profile

### Public (no auth)

- `GET /api/embed/:id/config` — returns profile config JSON
- `GET /embed/:id` — serves the embed HTML page

## Security

### CSP / Frame Embedding

Currently blocked by:
- Helmet `frameguard: 'deny'` → `X-Frame-Options: DENY`
- CSP has no `frame-ancestors` directive

**Solution:** A new embed middleware applied to `/embed/:id` and `/api/embed/:id/*` routes:
1. Looks up the embed profile's `allowedOrigins`
2. Sets `Content-Security-Policy: frame-ancestors 'self' <origin1> <origin2> ...`
3. Removes `X-Frame-Options` for these routes only
4. Main app routes remain unchanged (`frameguard: 'deny'`)

### CORS

The embed profile's `allowedOrigins` are merged into the existing CORS origin check for
API calls from within the embed iframe.

### Anonymous Access

The embed relies on the anonymous user having read permissions for the selected channels.
The Settings UI displays a clear notice about this requirement.

No session cookies are needed — `optionalAuth` middleware falls back to the anonymous user.

### Iframe Snippet

The Settings UI shows the copyable iframe code:
```html
<iframe
  src="https://your-meshmonitor.example.com/meshmonitor/embed/abc123"
  width="800"
  height="600"
  frameborder="0"
  allow="fullscreen"
></iframe>
```

## Frontend

### Embed Page

**New files:**
- `embed.html` — minimal HTML entry point
- `src/embed.tsx` — React mount point
- `src/components/EmbedMap.tsx` — embed map component

**Behavior:**
1. Reads `profileId` from URL path
2. Fetches `GET /api/embed/:profileId/config`
3. Renders Leaflet map with specified tileset, center, zoom
4. Polls `GET /api/nodes/active` at configured interval
5. Filters nodes to configured channels
6. Renders markers with configured interactivity (tooltips, popups, etc.)

**Shared code:** `src/config/tilesets.ts`, TypeScript types, marker icon logic.

**Not included:** header, sidebar, tabs, settings, WebSocket, TanStack Query, auth UI.

### Settings UI — Embed Configuration Panel

New admin-only section in SettingsTab with:

1. **Profile list** — table with name, enabled, actions (edit, delete, copy code)
2. **Create/Edit form:**
   - Name, enabled toggle
   - Channel multi-select
   - Tileset picker (existing dropdown)
   - Interactive mini-map for picking default center and zoom
   - Feature toggles (tooltips, popups, legend, paths, neighbor info, MQTT nodes)
   - Poll interval input
   - Allowed origins input
3. **Embed code preview** — read-only `<iframe>` snippet
4. **Security notes** — anonymous permissions reminder, CORS guidance

## Build Changes

In `vite.config.ts`, add second entry point:
```typescript
build: {
  rollupOptions: {
    input: {
      main: resolve(__dirname, 'index.html'),
      embed: resolve(__dirname, 'embed.html'),
    },
  },
}
```

Express serves `embed.html` for `/embed/:id` and `index.html` for all other routes.

## New Files

| File | Purpose |
|------|---------|
| `embed.html` | HTML entry point for embed |
| `src/embed.tsx` | React mount for embed |
| `src/components/EmbedMap.tsx` | Embed map component |
| `src/components/settings/EmbedSettings.tsx` | Settings panel for embed profiles |
| `src/db/schema/embedProfiles.ts` | Drizzle schema |
| `src/db/repositories/embedProfiles.ts` | DB repository |
| `src/server/routes/embedRoutes.ts` | Express routes |
| `src/server/middleware/embedMiddleware.ts` | CSP/CORS middleware |
| `src/server/migrations/078_create_embed_profiles.ts` | DB migration |

## Modified Files

| File | Change |
|------|--------|
| `vite.config.ts` | Add second entry point |
| `src/server/server.ts` | Mount embed routes and middleware |
| `src/services/database.ts` | Register migration, expose repository methods |
| `src/components/SettingsTab.tsx` | Add embed section (admin only) |
| `src/server/middleware/dynamicCsp.ts` | Allow embed routes to override CSP |
