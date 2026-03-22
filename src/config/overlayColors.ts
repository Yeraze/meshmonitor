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
  polarGrid: {
    rings: string;
    sectors: string;
    cardinalSectors: string;
    labels: string;
  };
}

export const darkOverlayColors: OverlayColors = {
  tracerouteForward: '#f5c2e7', // Catppuccin Mocha pink — distinct from hop gradient and MQTT
  tracerouteReturn: '#f5c2e7', // Same as forward; direction shown by arrows
  mqttSegment: '#b4befe',      // Catppuccin Mocha lavender — distinct from traceroute pink
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
  polarGrid: {
    rings: 'rgba(0, 200, 255, 0.3)',
    sectors: 'rgba(0, 200, 255, 0.15)',
    cardinalSectors: 'rgba(0, 200, 255, 0.3)',
    labels: 'rgba(0, 200, 255, 0.7)',
  },
};

export const lightOverlayColors: OverlayColors = {
  tracerouteForward: '#ea76cb', // Catppuccin Latte pink — distinct from hop gradient and MQTT
  tracerouteReturn: '#ea76cb', // Same as forward; direction shown by arrows
  mqttSegment: '#7287fd',      // Catppuccin Latte lavender — distinct from traceroute pink
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
  polarGrid: {
    rings: 'rgba(0, 80, 130, 0.3)',
    sectors: 'rgba(0, 80, 130, 0.15)',
    cardinalSectors: 'rgba(0, 80, 130, 0.3)',
    labels: 'rgba(0, 80, 130, 0.7)',
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
