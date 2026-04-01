/**
 * Tile Style Generator
 *
 * Generates a default MapLibre GL v8 style.json from a TileJSON response.
 * This is a pure utility module — no disk I/O, no HTTP calls.
 */

// ---------------------------------------------------------------------------
// TileJSON types (subset of TileJSON 2.x spec)
// ---------------------------------------------------------------------------

export interface VectorLayer {
  id: string;
  description?: string;
  minzoom?: number;
  maxzoom?: number;
  geometry_type?: 'polygon' | 'line' | 'point' | 'unknown' | string;
  fields?: Record<string, string>;
}

export interface TileJsonResponse {
  tilejson?: string;
  name?: string;
  description?: string;
  attribution?: string;
  minzoom?: number;
  maxzoom?: number;
  bounds?: [number, number, number, number];
  center?: [number, number, number];
  tiles: string[];
  vector_layers?: VectorLayer[];
}

// ---------------------------------------------------------------------------
// Default color palette per geometry type
// ---------------------------------------------------------------------------

const LAYER_COLORS: Record<string, { fill: string; line: string; circle: string }> = {
  water:            { fill: '#a0c8f0', line: '#7aabdc', circle: '#a0c8f0' },
  waterway:         { fill: '#a0c8f0', line: '#7aabdc', circle: '#7aabdc' },
  landuse:          { fill: '#d4e8c0', line: '#b0cc98', circle: '#d4e8c0' },
  landcover:        { fill: '#c8e0b0', line: '#a8c890', circle: '#c8e0b0' },
  park:             { fill: '#b8d8a0', line: '#90b878', circle: '#b8d8a0' },
  building:         { fill: '#d8d0c8', line: '#b8a898', circle: '#d8d0c8' },
  transportation:   { fill: '#f0e8d0', line: '#e0c880', circle: '#e0c880' },
  transportation_name: { fill: '#f0e8d0', line: '#e0c880', circle: '#e0c880' },
  boundary:         { fill: '#e0d0f0', line: '#c0a8dc', circle: '#c0a8dc' },
  place:            { fill: '#f8f0e0', line: '#d8c8a8', circle: '#f8c060' },
  poi:              { fill: '#f0d0e8', line: '#d0a8c8', circle: '#e080c0' },
  aeroway:          { fill: '#e8e8f0', line: '#c0c0d8', circle: '#c0c0d8' },
  water_name:       { fill: '#a0c8f0', line: '#7aabdc', circle: '#7aabdc' },
};

const DEFAULT_COLOR = { fill: '#d8d8d8', line: '#b0b0b0', circle: '#888888' };

function colorForLayer(layerId: string): { fill: string; line: string; circle: string } {
  // Exact match first, then prefix match
  if (LAYER_COLORS[layerId]) return LAYER_COLORS[layerId];
  for (const key of Object.keys(LAYER_COLORS)) {
    if (layerId.startsWith(key) || key.startsWith(layerId)) return LAYER_COLORS[key];
  }
  return DEFAULT_COLOR;
}

// ---------------------------------------------------------------------------
// Layer builder helpers
// ---------------------------------------------------------------------------

function makeFillLayer(sourceId: string, layerId: string, color: string, opacity = 0.5) {
  return {
    id: `${layerId}-fill`,
    type: 'fill',
    source: sourceId,
    'source-layer': layerId,
    paint: {
      'fill-color': color,
      'fill-opacity': opacity,
    },
  };
}

function makeLineLayer(sourceId: string, layerId: string, color: string, width = 1) {
  return {
    id: `${layerId}-line`,
    type: 'line',
    source: sourceId,
    'source-layer': layerId,
    paint: {
      'line-color': color,
      'line-width': width,
    },
  };
}

function makeCircleLayer(sourceId: string, layerId: string, color: string, radius = 4) {
  return {
    id: `${layerId}-circle`,
    type: 'circle',
    source: sourceId,
    'source-layer': layerId,
    paint: {
      'circle-color': color,
      'circle-radius': radius,
    },
  };
}

/**
 * Build MapLibre GL layers for a single vector tile source-layer.
 * Selects layer types based on the `geometry_type` hint in TileJSON when available.
 * Falls back to emitting fill + line layers for unknown geometry types.
 */
function buildLayersForVectorLayer(sourceId: string, vl: VectorLayer): object[] {
  const colors = colorForLayer(vl.id);
  const geom = (vl.geometry_type ?? 'unknown').toLowerCase();

  if (geom === 'point') {
    return [makeCircleLayer(sourceId, vl.id, colors.circle)];
  }
  if (geom === 'line') {
    return [makeLineLayer(sourceId, vl.id, colors.line)];
  }
  if (geom === 'polygon') {
    return [makeFillLayer(sourceId, vl.id, colors.fill), makeLineLayer(sourceId, vl.id, colors.line, 0.5)];
  }

  // Unknown geometry — emit fill + line as a safe default
  return [makeFillLayer(sourceId, vl.id, colors.fill), makeLineLayer(sourceId, vl.id, colors.line, 0.5)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateStyleOptions {
  /** Human-readable name stored in the style's `name` property */
  name?: string;
  /** Source ID to use in the style's sources and layers (default: "custom") */
  sourceId?: string;
}

/**
 * Generate a default MapLibre GL v8 style.json from a parsed TileJSON object.
 *
 * @param tileJson   Parsed TileJSON from the tileserver
 * @param tileJsonUrl  Original URL used to fetch the TileJSON (not stored, used for tile URL resolution)
 * @param options    Optional overrides
 * @returns          A valid MapLibre GL style object
 * @throws           If the TileJSON is missing required fields (`tiles`, `vector_layers`)
 */
export function generateStyleFromTileJson(
  tileJson: TileJsonResponse,
  options: GenerateStyleOptions = {}
): object {
  const sourceId = options.sourceId ?? 'custom';
  const styleName = options.name ?? tileJson.name ?? 'Generated Style';

  const vectorLayers = tileJson.vector_layers ?? [];

  // Build all MapLibre layers
  const layers: object[] = [];
  for (const vl of vectorLayers) {
    layers.push(...buildLayersForVectorLayer(sourceId, vl));
  }

  const style: Record<string, unknown> = {
    version: 8,
    name: styleName,
    sources: {
      [sourceId]: {
        type: 'vector',
        tiles: tileJson.tiles,
        ...(tileJson.minzoom !== undefined ? { minzoom: tileJson.minzoom } : {}),
        ...(tileJson.maxzoom !== undefined ? { maxzoom: tileJson.maxzoom } : {}),
        ...(tileJson.attribution ? { attribution: tileJson.attribution } : {}),
      },
    },
    layers,
  };

  return style;
}
