export type OverlayScheme = 'light' | 'dark';

export interface OverlayColors {
  tracerouteForward: string;
  tracerouteReturn: string;
  mqttSegment: string;
  neighborLine: string;
  positionHistoryOld: { r: number; g: number; b: number };
  positionHistoryNew: { r: number; g: number; b: number };
  hopColors: {
    local: string;
    noData: string;
    max: string;
    gradient: string[];
  };
}

export const darkOverlayColors: OverlayColors = {
  tracerouteForward: '#89b4fa',
  tracerouteReturn: '#f38ba8',
  mqttSegment: '#9399b2',
  neighborLine: '#cba6f7',
  positionHistoryOld: { r: 0, g: 191, b: 255 },
  positionHistoryNew: { r: 255, g: 69, b: 0 },
  hopColors: {
    local: '#22c55e',
    noData: '#9ca3af',
    max: '#FF0000',
    gradient: ['#0000FF', '#3300CC', '#660099', '#990066', '#CC0033', '#FF0000'],
  },
};

export const lightOverlayColors: OverlayColors = {
  tracerouteForward: '#1e66f5',
  tracerouteReturn: '#d20f39',
  mqttSegment: '#7c7f93',
  neighborLine: '#8839ef',
  positionHistoryOld: { r: 0, g: 103, b: 165 },
  positionHistoryNew: { r: 196, g: 32, b: 10 },
  hopColors: {
    local: '#15803d',
    noData: '#6b7280',
    max: '#b91c1c',
    gradient: ['#1d4ed8', '#4338ca', '#6d28d9', '#a21caf', '#be123c', '#b91c1c'],
  },
};

export function getOverlayColors(scheme: OverlayScheme): OverlayColors {
  return scheme === 'light' ? lightOverlayColors : darkOverlayColors;
}

/** Maps each built-in tileset ID to its overlay scheme */
export const tilesetSchemeMap: Record<string, OverlayScheme> = {
  osm: 'light',
  osmHot: 'light',
  cartoDark: 'dark',
  cartoLight: 'light',
  openTopo: 'light',
  esriSatellite: 'dark',
};

/** Get the overlay scheme for a tileset ID. Custom tilesets default to 'dark'. */
export function getSchemeForTileset(tilesetId: string, customOverlayScheme?: OverlayScheme): OverlayScheme {
  if (customOverlayScheme) return customOverlayScheme;
  return tilesetSchemeMap[tilesetId] ?? 'dark';
}
