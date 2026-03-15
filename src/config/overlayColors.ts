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
  snrColors: {
    good: string;    // SNR > 10dB
    medium: string;  // SNR 0 to 10dB
    poor: string;    // SNR < 0dB
    noData: string;  // No SNR data
  };
}

export const darkOverlayColors: OverlayColors = {
  tracerouteForward: '#74c7ec', // Catppuccin Mocha sapphire — unified traceroute color
  tracerouteReturn: '#74c7ec', // Same as forward; direction shown by arrows
  mqttSegment: '#94e2d5',
  neighborLine: '#fab387', // Catppuccin Mocha peach — distinct from hop gradient
  positionHistoryOld: { r: 0, g: 191, b: 255 },
  positionHistoryNew: { r: 255, g: 69, b: 0 },
  hopColors: {
    local: '#22c55e',
    noData: '#9ca3af',
    max: '#FF0000',
    gradient: ['#0000FF', '#3300CC', '#660099', '#990066', '#CC0033', '#FF0000'],
  },
  snrColors: {
    good: '#a6e3a1',    // Catppuccin Mocha green (--ctp-green)
    medium: '#f9e2af',  // Catppuccin Mocha yellow (--ctp-yellow)
    poor: '#f38ba8',    // Catppuccin Mocha red (--ctp-red)
    noData: '#6c7086',  // Catppuccin Mocha overlay0 (--ctp-overlay0)
  },
};

export const lightOverlayColors: OverlayColors = {
  tracerouteForward: '#209fb5', // Catppuccin Latte sapphire — unified traceroute color
  tracerouteReturn: '#209fb5', // Same as forward; direction shown by arrows
  mqttSegment: '#179299',
  neighborLine: '#fe640b', // Catppuccin Latte peach — distinct from hop gradient
  positionHistoryOld: { r: 0, g: 103, b: 165 },
  positionHistoryNew: { r: 196, g: 32, b: 10 },
  hopColors: {
    local: '#15803d',
    noData: '#6b7280',
    max: '#b91c1c',
    gradient: ['#1d4ed8', '#4338ca', '#6d28d9', '#a21caf', '#be123c', '#b91c1c'],
  },
  snrColors: {
    good: '#40a02b',    // Catppuccin Latte green (--ctp-green)
    medium: '#df8e1d',  // Catppuccin Latte yellow (--ctp-yellow)
    poor: '#d20f39',    // Catppuccin Latte red (--ctp-red)
    noData: '#9ca0b0',  // Catppuccin Latte overlay0 (--ctp-overlay0)
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
