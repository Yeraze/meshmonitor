/**
 * Pure styling for cross-source "heard here" map edges (#5561). One place so
 * the 2D layer, the 3D lines and the legend text agree.
 *
 * Three looks, all distinct from traceroute segments and neighbor links:
 *  - RF, sent by the source: solid.
 *  - MQTT gateway heard it over RF: long dashes, second colour.
 *  - Likely relay (inferred): dotted.
 * Width grows with the hearing count (log scale); opacity fades with age.
 */
import type { CrossSourceLinkDto, TracerouteConfirmedLinkDto, TracerouteConfirmedTransport } from '../types/crossSourceLinks.js';

export const CROSS_SOURCE_LINK_COLOR_RF = '#e11d8f';
export const CROSS_SOURCE_LINK_COLOR_GATEWAY = '#8b5cf6';

export interface CrossSourceLinkStyle {
  color: string;
  weight: number;
  opacity: number;
  /** Leaflet dashArray, or undefined for a solid line. */
  dashArray?: string;
  /** MapLibre dash pattern (in line widths), or undefined for a solid line. */
  dash3d?: number[];
}

export function crossSourceLinkStyle(
  link: Pick<CrossSourceLinkDto, 'kind' | 'transportClass' | 'count' | 'lastHeardAt'>,
  nowMs: number,
  windowMs: number,
): CrossSourceLinkStyle {
  const color = link.transportClass === 'mqtt_gateway' ? CROSS_SOURCE_LINK_COLOR_GATEWAY : CROSS_SOURCE_LINK_COLOR_RF;
  // 1 hearing -> 2px, 10 -> 3.5px, 100 -> 5px; capped.
  const weight = Math.min(6, 2 + 1.5 * Math.log10(Math.max(1, link.count)));
  // Fresh = 0.9, at the edge of the window = 0.35.
  const age = Math.max(0, nowMs - link.lastHeardAt);
  const fraction = windowMs > 0 ? Math.min(1, age / windowMs) : 0;
  const opacity = 0.9 - 0.55 * fraction;

  if (link.kind === 'relay') return { color, weight, opacity, dashArray: '2 7', dash3d: [0.6, 2] };
  if (link.transportClass === 'mqtt_gateway') return { color, weight, opacity, dashArray: '10 6', dash3d: [3, 2] };
  return { color, weight, opacity };
}

// ---------------------------------------------------------------------------
// Traceroute-confirmed reciprocal links (#5580)
// ---------------------------------------------------------------------------

/**
 * One colour per transport class. Chosen apart from the two "heard here"
 * colours above, so a confirmed link never reads as a one-way edge.
 */
export const TRACEROUTE_CONFIRMED_LINK_COLORS: Record<TracerouteConfirmedTransport, string> = {
  rf: '#0d9488',
  mqtt: '#d97706',
  udp: '#2563eb',
};

/**
 * Where the two arrowheads sit along the line (0 = our radio, 1 = the
 * neighbour). One near each end, each pointing outward: a double-headed line.
 */
export const TRACEROUTE_CONFIRMED_ARROW_FRACTIONS = { towardNeighbor: 0.8, towardLocal: 0.2 } as const;

export interface TracerouteConfirmedLinkStyle extends CrossSourceLinkStyle {
  /** Always true: the 2D layer draws an arrowhead at each end. */
  doubleHeaded: true;
}

/**
 * The look of a traceroute-confirmed reciprocal link: a dash-dot line with an
 * arrowhead at each end. Dash-dot is used by no other map line (one-way edges
 * are solid, long-dashed or dotted), so the two layers stay apart even in the
 * 3D view, which draws no arrowheads. Width grows with the number of
 * confirming runs; opacity fades with the age of the latest one.
 */
export function tracerouteConfirmedLinkStyle(
  link: Pick<TracerouteConfirmedLinkDto, 'transportClass' | 'count' | 'lastConfirmedAt'>,
  nowMs: number,
  windowMs: number,
): TracerouteConfirmedLinkStyle {
  const color = TRACEROUTE_CONFIRMED_LINK_COLORS[link.transportClass] ?? TRACEROUTE_CONFIRMED_LINK_COLORS.rf;
  // 1 run -> 2.5px, 10 -> 4px; capped.
  const weight = Math.min(6, 2.5 + 1.5 * Math.log10(Math.max(1, link.count)));
  const age = Math.max(0, nowMs - link.lastConfirmedAt);
  const fraction = windowMs > 0 ? Math.min(1, age / windowMs) : 0;
  const opacity = 0.95 - 0.5 * fraction;
  return { color, weight, opacity, dashArray: '12 5 2 5', dash3d: [4, 1.5, 0.6, 1.5], doubleHeaded: true };
}

