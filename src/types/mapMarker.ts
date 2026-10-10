/**
 * Local map markers (issue #5686): planning notes on the map that are stored
 * in MeshMonitor and NEVER transmitted. Shared by the server (validation) and
 * the client (editor, layer).
 */

/** Glyphs a marker can use. Keys, not markup; the layer maps each to an icon. */
export const MAP_MARKER_ICONS = ['pin', 'star', 'target', 'antenna', 'home', 'warning'] as const;
export type MapMarkerIcon = (typeof MAP_MARKER_ICONS)[number];

/**
 * Colours a marker can use. Keys, not CSS: each maps to a `--color-*` theme
 * token in MapMarkersLayer so markers follow the light/dark theme.
 */
export const MAP_MARKER_COLORS = ['accent', 'success', 'warning', 'error', 'info', 'muted'] as const;
export type MapMarkerColor = (typeof MAP_MARKER_COLORS)[number];

export const MAP_MARKER_LABEL_MAX = 64;
export const MAP_MARKER_DESCRIPTION_MAX = 2000;
/**
 * Markers per source. A site survey wants a few hundred; the cap keeps one
 * source from growing a map layer (and its GET) without bound.
 */
export const MAP_MARKERS_PER_SOURCE_MAX = 1000;

export interface MapMarker {
  id: number;
  sourceId: string;
  label: string;
  description: string | null;
  latitude: number;
  longitude: number;
  altitude: number | null;
  icon: MapMarkerIcon;
  color: MapMarkerColor;
  createdByUserId: number | null;
  /** ms since epoch */
  createdAt: number;
  /** ms since epoch */
  updatedAt: number;
}

/** Fields a client sends to create or edit a marker. */
export interface MapMarkerInput {
  label: string;
  description?: string | null;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  icon?: MapMarkerIcon;
  color?: MapMarkerColor;
}

/**
 * Check and normalise a marker body. Returns the clean input, or the first
 * problem as `{ error }` so a route can answer 400 with it.
 */
export function parseMapMarkerInput(body: unknown): { value: Required<MapMarkerInput> } | { error: string; code: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const label = typeof b.label === 'string' ? b.label.trim() : '';
  if (!label) return { error: 'label is required', code: 'INVALID_LABEL' };
  if (label.length > MAP_MARKER_LABEL_MAX) return { error: `label must be ${MAP_MARKER_LABEL_MAX} characters or fewer`, code: 'INVALID_LABEL' };

  let description: string | null = null;
  if (b.description != null && b.description !== '') {
    if (typeof b.description !== 'string') return { error: 'description must be text', code: 'INVALID_DESCRIPTION' };
    description = b.description.trim() || null;
    if (description && description.length > MAP_MARKER_DESCRIPTION_MAX) {
      return { error: `description must be ${MAP_MARKER_DESCRIPTION_MAX} characters or fewer`, code: 'INVALID_DESCRIPTION' };
    }
  }

  const latitude = Number(b.latitude);
  const longitude = Number(b.longitude);
  if (b.latitude === '' || b.latitude == null || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { error: 'latitude must be between -90 and 90', code: 'INVALID_POSITION' };
  }
  if (b.longitude === '' || b.longitude == null || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { error: 'longitude must be between -180 and 180', code: 'INVALID_POSITION' };
  }

  let altitude: number | null = null;
  if (b.altitude != null && b.altitude !== '') {
    altitude = Number(b.altitude);
    if (!Number.isFinite(altitude) || altitude < -1000 || altitude > 100000) {
      return { error: 'altitude must be between -1000 and 100000 metres', code: 'INVALID_ALTITUDE' };
    }
  }

  const icon = (b.icon ?? 'pin') as MapMarkerIcon;
  if (!MAP_MARKER_ICONS.includes(icon)) return { error: `icon must be one of ${MAP_MARKER_ICONS.join(', ')}`, code: 'INVALID_ICON' };
  const color = (b.color ?? 'accent') as MapMarkerColor;
  if (!MAP_MARKER_COLORS.includes(color)) return { error: `color must be one of ${MAP_MARKER_COLORS.join(', ')}`, code: 'INVALID_COLOR' };

  return { value: { label, description, latitude, longitude, altitude, icon, color } };
}
