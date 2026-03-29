# GeoJSON Overlay Layer Support

**Issue:** #2487
**Date:** 2026-03-29

## Overview

Add support for loading GeoJSON files as overlay layers on the map. Users can upload files via the UI or place them in a mounted directory for auto-discovery. Layers support styling via simplestyle-spec properties in the GeoJSON data, per-layer UI overrides, or auto-assigned defaults.

## Storage & Discovery

GeoJSON files are stored in `/data/geojson/`.

**Two intake methods:**

1. **Upload via Map Settings UI** — Multipart file upload. Server validates the file as parseable GeoJSON before storing. Stored to `/data/geojson/<uuid>.geojson` with original filename preserved in metadata.
2. **Auto-discovery** — On startup and when the layers list is requested, scan `/data/geojson/` for `.geojson` and `.json` files not already tracked. Register them with auto-assigned defaults.

**Layer metadata** is stored in `/data/geojson/manifest.json`:

```json
{
  "layers": [
    {
      "id": "uuid-string",
      "name": "Emergency Gathering Points",
      "filename": "emergency-points.geojson",
      "visible": true,
      "style": {
        "color": "#e74c3c",
        "opacity": 0.7,
        "weight": 2,
        "fillOpacity": 0.3
      },
      "createdAt": 1774800000000,
      "updatedAt": 1774800000000
    }
  ]
}
```

Using a manifest file (not database) keeps GeoJSON management self-contained in the `/data/geojson/` directory — easy to back up, migrate, or manage via Docker volumes.

## Styling

Three-tier priority (highest first):

1. **Per-layer UI overrides** — Color, opacity, line weight, fill opacity set in Map Settings
2. **GeoJSON simplestyle-spec properties** — `stroke`, `stroke-width`, `stroke-opacity`, `fill`, `fill-opacity`, `marker-color`, `marker-size` honored from feature `properties`
3. **Auto-assigned defaults** — Color from a rotating palette, 0.7 opacity, 2px line weight, 0.3 fill opacity

When a layer has UI overrides, they apply as the base style. Individual features can still override via simplestyle-spec properties in the GeoJSON data.

## Backend API

All endpoints require authentication. Upload/edit/delete require `settings:write` permission. Read requires `settings:read`.

### Endpoints

**`POST /api/geojson/upload`**
- Multipart form upload (field: `file`)
- Validates file is parseable GeoJSON (FeatureCollection, Feature, or Geometry)
- Max file size: 10MB
- Stores to `/data/geojson/<uuid>.geojson`
- Creates manifest entry with auto-assigned name (from filename) and default style
- Returns: layer metadata object

**`GET /api/geojson/layers`**
- Triggers auto-discovery scan for untracked files in `/data/geojson/`
- Returns: array of layer metadata objects (without GeoJSON data)

**`PUT /api/geojson/layers/:id`**
- Updates layer metadata: name, visible, style overrides
- Returns: updated layer metadata

**`DELETE /api/geojson/layers/:id`**
- Removes manifest entry and deletes the GeoJSON file
- Returns: 204 No Content

**`GET /api/geojson/layers/:id/data`**
- Serves the raw GeoJSON file content
- Returns: GeoJSON with `application/geo+json` content type

### Route File

New file: `src/server/routes/geojsonRoutes.ts`

### Service

New file: `src/server/services/geojsonService.ts` — handles manifest CRUD, file I/O, auto-discovery, validation.

## Frontend Components

### GeoJsonOverlay Component

**File:** `src/components/GeoJsonOverlay.tsx`

Renders inside the existing `MapContainer` in `NodesTab.tsx`. For each visible layer:
- Fetches GeoJSON data from `/api/geojson/layers/:id/data`
- Renders a `<GeoJSON>` component with style function that applies the three-tier styling
- Point features render as `L.circleMarker` with appropriate styling
- Caches fetched data in state to avoid re-fetching on every render

### Map Settings UI

**Location:** Existing Map Settings section in `SettingsTab.tsx` (or its sub-components)

Adds a "GeoJSON Overlays" sub-section with:
- **Upload button** — File input accepting `.geojson`, `.json`
- **Layer list** — Each layer shows:
  - Name (editable text field)
  - Color picker
  - Opacity slider (0-1)
  - Line weight input (1-10)
  - Visibility toggle
  - Delete button (with confirmation)
- **Empty state** — "No GeoJSON layers. Upload a file or place .geojson files in /data/geojson/"

### Map Control Toggles

Added alongside existing polar grid toggle on the map view. One pill-style button per layer:
- Shows layer name (truncated) with colored dot matching layer color
- Click toggles visibility
- Dimmed when layer is hidden
- Only shown for layers that are enabled in settings

## Permissions

- `settings:read` — View layer list, fetch GeoJSON data, see map toggles
- `settings:write` — Upload, edit metadata, delete, toggle visibility in settings

## File Size & Validation

- Maximum upload size: 10MB per file
- Validation: Must parse as valid JSON, must be a GeoJSON object (FeatureCollection, Feature, or bare Geometry)
- No limit on number of layers (practical limit from browser rendering performance)

## Error Handling

- Upload validation failure → 400 with descriptive error message
- File not found (deleted externally) → Auto-remove from manifest on next scan, 404 on direct request
- Manifest corruption → Rebuild from files on disk with default metadata
- Large GeoJSON rendering → Browser-side concern; no server-side mitigation needed

## Testing

- **Backend:** Unit tests for geojsonService (manifest CRUD, validation, auto-discovery) and geojsonRoutes (upload, CRUD, permissions)
- **Frontend:** Component tests for GeoJsonOverlay rendering, Map Settings layer management UI
