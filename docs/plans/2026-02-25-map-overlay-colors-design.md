# Map Overlay Color Schemes for Light/Dark Tilesets (#2020)

## Problem

All map overlay colors (route segments, traceroutes, neighbor lines, position history) use Catppuccin Mocha dark-theme colors. These look great on dark tilesets (CARTO Dark, Satellite) but wash out on light tilesets (OSM, CARTO Light, OpenTopo), making routes and connections hard to see.

## Solution

Define two overlay color schemes — Dark Mode (current colors, for dark maps) and Light Mode (deeper, more saturated colors for light maps). Each built-in tileset maps to the appropriate scheme. Custom tile servers get a new `overlayScheme` field (default: `'dark'`). Switching tilesets auto-selects the correct scheme.

## Color Schemes

### Dark Mode Overlays (CARTO Dark, Satellite)

Current colors, unchanged:

| Element | Color | Source |
|---------|-------|--------|
| Traceroute forward | `#89b4fa` (Catppuccin blue) | useTraceroutePaths.tsx |
| Traceroute return | `#f38ba8` (Catppuccin red) | useTraceroutePaths.tsx |
| MQTT segment | `#9399b2` (Catppuccin overlay2) | useTraceroutePaths.tsx |
| Neighbor line | `#cba6f7` (Catppuccin mauve) | NodesTab.tsx |
| Position history start | `#00bfff` | NodesTab.tsx |
| Position history end | `#ff4500` | NodesTab.tsx |
| Hop markers | Existing palette | mapIcons.ts |

### Light Mode Overlays (OSM, OSM HOT, CARTO Light, OpenTopo)

Deeper, more saturated variants for contrast on pale backgrounds:

| Element | Color | Notes |
|---------|-------|-------|
| Traceroute forward | `#1e66f5` | Catppuccin Latte blue |
| Traceroute return | `#d20f39` | Catppuccin Latte red |
| MQTT segment | `#7c7f93` | Catppuccin Latte overlay2 |
| Neighbor line | `#8839ef` | Catppuccin Latte mauve |
| Position history start | `#0067a5` | Darker cyan-blue |
| Position history end | `#c4200a` | Deeper red-orange |
| Hop markers | Darker saturated variants | Adjusted for contrast |

## Tileset Mapping

| Tileset Key | Scheme |
|-------------|--------|
| `osm` | Light |
| `osmHot` | Light |
| `cartoDark` | Dark |
| `cartoLight` | Light |
| `openTopo` | Light |
| `esriSatellite` | Dark |

## Architecture

### New File: `src/config/overlayColors.ts`

Central color config exporting:
- `type OverlayScheme = 'light' | 'dark'`
- `darkOverlayColors` and `lightOverlayColors` objects
- `getOverlayColors(scheme: OverlayScheme)` helper
- `tilesetSchemeMap` linking tileset keys to schemes

### Custom Tile Servers

Add `overlayScheme: 'light' | 'dark'` field to the custom tileset interface. Default to `'dark'`. Exposed in `CustomTilesetManager.tsx` as a toggle/select.

### Auto-Switching

`TilesetSelector.tsx` already handles tileset changes. On tileset switch, look up the scheme from `tilesetSchemeMap` (for built-ins) or `customTileset.overlayScheme` (for custom). Store the active scheme in `SettingsContext` so all overlay consumers can read it.

### Consumers

Components that need to read the active scheme and use `getOverlayColors()`:
- `useTraceroutePaths.tsx` — traceroute & MQTT colors
- `NodesTab.tsx` — neighbor lines, position history
- `mapIcons.ts` — hop count marker colors
- `mapHelpers.tsx` — color gradient generation

## Files Modified

- **Create**: `src/config/overlayColors.ts`
- **Modify**: `src/config/tilesets.ts` — add scheme mapping
- **Modify**: `src/contexts/SettingsContext.tsx` — store active overlay scheme
- **Modify**: `src/hooks/useTraceroutePaths.tsx` — use scheme-aware colors
- **Modify**: `src/components/NodesTab.tsx` — use scheme-aware colors
- **Modify**: `src/utils/mapIcons.ts` — use scheme-aware hop colors
- **Modify**: `src/utils/mapHelpers.tsx` — use scheme-aware gradient
- **Modify**: `src/components/TilesetSelector.tsx` — auto-switch scheme on tileset change
- **Modify**: `src/components/CustomTilesetManager.tsx` — add overlayScheme field
- **Modify**: `public/locales/en.json` — i18n for overlay scheme label
