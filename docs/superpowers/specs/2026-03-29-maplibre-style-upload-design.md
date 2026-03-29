# Custom MapLibre Style JSON Upload

**Date:** 2026-03-29

## Overview

Allow users to upload or provide URLs for custom MapLibre GL style JSON files, and switch between them via a dropdown control on the map when a vector tileset is active. Styles are managed independently of tilesets — users can swap visual themes without changing tile sources.

## Storage & Management

Style files are stored in `/data/styles/`. A `manifest.json` tracks metadata:

```json
{
  "styles": [
    {
      "id": "uuid-string",
      "name": "Dark Terrain",
      "filename": "uuid.json",
      "sourceType": "upload",
      "sourceUrl": null,
      "createdAt": 1774800000000,
      "updatedAt": 1774800000000
    }
  ]
}
```

**Two intake methods:**

1. **Upload** — User uploads a `.json` style file via Map Settings. Validated and stored to `/data/styles/<uuid>.json`.
2. **URL** — User provides a URL to a hosted style JSON (MapTiler, Protomaps, etc.). The style is fetched server-side and stored locally so it works offline.

## Backend

### Service

New file: `src/server/services/mapStyleService.ts`

Follows the same pattern as `geojsonService.ts`: manifest CRUD, file I/O, validation. Methods:

- `loadManifest(): MapStyleManifest`
- `validateStyle(content: string): boolean` — must have `version: 8`, `sources`, and `layers`
- `addStyle(name: string, content: string, sourceType: 'upload' | 'url', sourceUrl?: string): MapStyle`
- `deleteStyle(id: string): void`
- `updateStyle(id: string, updates: { name?: string }): MapStyle`
- `getStyleData(id: string): string`
- `getStyles(): MapStyle[]`

### Routes

New file: `src/server/routes/mapStyleRoutes.ts`

Mounted at `/api/map-styles/`:

- **`POST /upload`** — `express.raw({ type: '*/*', limit: '10mb' })`, reads `X-Filename` header, validates, stores. Returns 201 with style metadata.
- **`POST /from-url`** — `express.json()`, accepts `{ url: string, name?: string }`, fetches the URL server-side, validates, stores locally. Returns 201 with style metadata.
- **`GET /styles`** — list all styles (metadata only).
- **`PUT /styles/:id`** — update style name. Returns updated metadata.
- **`DELETE /styles/:id`** — remove style and file. Returns 204.
- **`GET /styles/:id/data`** — serve raw style JSON with `application/json` content type.

### Permissions

- Read endpoints: auth-only (no special permission)
- Write endpoints: `requirePermission('settings', 'write')`

## Frontend

### MapStyleManager Component

New file: `src/components/MapStyleManager.tsx`

Lives in Map Settings, after the GeoJSON Overlays section. Provides:

- **Upload button** — file input accepting `.json`
- **URL input** — text field + "Fetch" button to import from URL
- **Style list** — each row shows: editable name, source badge (Upload/URL), delete button
- **Empty state** — "No custom styles. Upload a style JSON or provide a URL."

### Map Style Picker Control

On the map view (alongside GeoJSON layer toggles), when a vector tileset is active:

- **Dropdown/select** showing: "Default" + all uploaded styles
- Selecting a style fetches its JSON from `/api/map-styles/:id/data` and applies it to VectorTileLayer
- "Default" reverts to the hardcoded built-in style
- Hidden when a raster tileset is active (no MapLibre GL in use)

### VectorTileLayer Update

Modify `src/components/VectorTileLayer.tsx`:

- Add optional `styleJson` prop (full MapLibre style object)
- When `styleJson` is provided, use it instead of the hardcoded default style
- **Source patching:** Before applying the style, replace all tile source URLs in `style.sources` with the active tileset's URL. This allows styles designed for one tile source to work with a different one.
- When `styleJson` changes, recreate the MapLibre GL layer with the new style

### State Management

- `activeMapStyle` state in NodesTab (or MapContext): tracks currently selected style ID (null = default)
- Style list fetched on mount via `/api/map-styles/styles`
- Selected style's JSON fetched on demand and cached

## Source Patching

MapLibre style JSON contains a `sources` section referencing specific tile URLs:

```json
{
  "sources": {
    "openmaptiles": {
      "type": "vector",
      "url": "https://some-tile-server/tiles.json"
    }
  }
}
```

When applying a style to a different vector tileset, the client patches all vector source URLs to point at the active tileset's URL. This is done in the VectorTileLayer component before passing the style to MapLibre GL.

## Validation

Style JSON must:
- Parse as valid JSON
- Have `version` field equal to `8` (MapLibre GL spec version)
- Have a `layers` array with at least one entry
- Have a `sources` object

Invalid styles are rejected with a descriptive 400 error.

## Testing

- **Backend:** Unit tests for mapStyleService (manifest CRUD, validation, URL fetch) and mapStyleRoutes (upload, from-url, CRUD, permissions)
- **Frontend:** Component tests for MapStyleManager UI
