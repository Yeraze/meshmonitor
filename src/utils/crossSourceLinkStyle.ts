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
import type { CrossSourceLinkDto } from '../types/crossSourceLinks.js';

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
