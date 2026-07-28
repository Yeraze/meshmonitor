/**
 * Pure SVG string builders for node role glyphs. **Leaflet-free on purpose** —
 * `markerIcons.ts` re-exports these for map callers, and off-map surfaces
 * (the Node Details traceroute strip) import them directly so they don't pull
 * Leaflet into a non-map bundle/test. Do not add a Leaflet import here.
 */

import { categoryGlyphFamily, type NodeTypeCategory } from './nodeTypeCategory';

/**
 * Inner SVG markup for a node-type role glyph, drawn inside the 48×48 viewBox
 * over a white background circle (issue #3546). Returns '' for 'standard' so
 * callers fall back to the default pin/circle. `color` is the hop color so the
 * glyph stays consistent with the marker's stroke.
 *
 * Meshtastic role categories (issue #3610) reuse the MeshCore glyph silhouettes
 * via {@link categoryGlyphFamily} (a ROUTER draws as a repeater tower, etc.).
 */
/**
 * The repeater/router tower silhouette (tower + signal waves), shared by the
 * `'repeater'` glyph family and the ROUTER_LATE variant (issue #4295). Drawn in
 * the 48×48 role-glyph viewBox.
 */
function repeaterTowerSvg(color: string): string {
  return `
        <rect x="19" y="32" width="10" height="12" fill="#555" />
        <rect x="21" y="16" width="6" height="16" fill="#555" />
        <rect x="22.5" y="4" width="3" height="12" fill="#555" />
        <circle cx="24" cy="4" r="3" fill="${color}" />
        <path d="M 16 20 C 12 20 8 23 8 26" stroke="${color}" stroke-width="3" fill="none" />
        <path d="M 18 24 C 15 24 12 25 12 26" stroke="${color}" stroke-width="3" fill="none" />
        <path d="M 32 20 C 36 20 40 23 40 26" stroke="${color}" stroke-width="3" fill="none" />
        <path d="M 30 24 C 33 24 36 25 36 26" stroke="${color}" stroke-width="3" fill="none" />`;
}

/**
 * "Unmessageable" corner badge: the lucide `Ban` mark (the same icon the
 * NodesTab list uses for the `blocked` state) drawn on a white disc so it reads
 * over any hop color. Signals a node that reports itself as unable to receive
 * direct messages (issue #4295, deferred from #3684). Muted red keeps the
 * "no" semantic without matching the 6+-hop marker red exactly.
 */
export function unmessageableBadgeSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="12" cy="12" r="11" fill="white" fill-opacity="0.95" />`
    + `<circle cx="12" cy="12" r="9" fill="none" stroke="#d64545" stroke-width="2" />`
    + `<path d="M 5.6 5.6 L 18.4 18.4" stroke="#d64545" stroke-width="2" stroke-linecap="round" />`
    + `</svg>`;
}

export function roleGlyphInnerSvg(category: NodeTypeCategory, color: string): string {
  // ROUTER_LATE shares the repeater-tower silhouette (it IS infrastructure) but
  // gets a small clock badge marking its delayed / lower-priority rebroadcast
  // window, so it reads distinctly from a plain ROUTER (issue #4295). The badge
  // sits in the lower-left, clear of the tower base and the right-side waves.
  if (category === 'mtRouterLate') {
    return repeaterTowerSvg(color)
      + `\n        <circle cx="13" cy="34" r="6.5" fill="white" stroke="${color}" stroke-width="2" />`
      + `\n        <path d="M 13 34 L 13 30" stroke="${color}" stroke-width="1.6" stroke-linecap="round" />`
      + `\n        <path d="M 13 34 L 15.6 35.6" stroke="${color}" stroke-width="1.6" stroke-linecap="round" />`;
  }
  switch (categoryGlyphFamily(category)) {
    case 'repeater':
      // Tower with signal waves — the existing router silhouette, overflows
      // the circle so backbone nodes read at a glance.
      return repeaterTowerSvg(color);
    case 'roomServer':
      // Stacked server rack with status LEDs.
      return `
        <rect x="15" y="14" width="18" height="7" rx="1.5" fill="${color}" />
        <rect x="15" y="23" width="18" height="7" rx="1.5" fill="${color}" />
        <circle cx="19" cy="17.5" r="1.4" fill="white" />
        <circle cx="19" cy="26.5" r="1.4" fill="white" />
        <rect x="23" y="16.5" width="7" height="2" rx="1" fill="white" />
        <rect x="23" y="25.5" width="7" height="2" rx="1" fill="white" />`;
    case 'sensor':
      // Broadcasting dot with concentric waves.
      return `
        <circle cx="24" cy="24" r="3" fill="${color}" />
        <path d="M 18 24 A 6 6 0 0 1 30 24" stroke="${color}" stroke-width="2" fill="none" />
        <path d="M 14 24 A 10 10 0 0 1 34 24" stroke="${color}" stroke-width="2" fill="none" />
        <path d="M 30 24 A 6 6 0 0 1 18 24" stroke="${color}" stroke-width="2" fill="none" />
        <path d="M 34 24 A 10 10 0 0 1 14 24" stroke="${color}" stroke-width="2" fill="none" />`;
    case 'companion':
      // Person silhouette (handheld/end-user node).
      return `
        <circle cx="24" cy="18" r="4.5" fill="${color}" />
        <path d="M 15 33 C 15 25 33 25 33 33 Z" fill="${color}" />`;
    default:
      return '';
  }
}

/**
 * Standalone role-glyph marker: the node-type glyph ({@link roleGlyphInnerSvg})
 * drawn over a white background circle, as a complete `<svg>` string sized to
 * `size`px. Used by maps that render their own markers (e.g. the MeshCore
 * source map) and by the legend swatches, so the glyph stays identical to the
 * one `createNodeIcon`'s official style produces. Returns '' for 'standard'
 * (and unknown categories) so callers fall back to their default marker.
 */
export function roleGlyphMarkerSvg(
  category: NodeTypeCategory,
  color: string,
  size = 24,
): string {
  const inner = roleGlyphInnerSvg(category, color);
  if (!inner) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="2" />`
    + `${inner}</svg>`;
}

/**
 * Get color based on hop count
 * Uses a blue-to-red gradient (through purple/magenta)
 * 0 hops: Green (#22c55e) - Direct connection (local node)
 * 1 hop: Blue (#0000FF)
 * 2 hops: Blue-Purple (#3300CC)
 * 3 hops: Purple (#660099)
 * 4 hops: Red-Purple (#990066)
 * 5 hops: Red-Magenta (#CC0033)
 * 6+ hops: Red (#FF0000)
 * 999 hops: Grey (#9ca3af) - No hop data
 */
export function getHopColor(
  hops: number,
  hopColors?: { local: string; noData: string; max: string; gradient: string[] },
): string {
  const colors = hopColors ?? {
    local: '#22c55e',
    noData: '#9ca3af',
    max: '#FF0000',
    gradient: ['#0000FF', '#3300CC', '#660099', '#990066', '#CC0033', '#FF0000'],
  };

  if (hops === 0) {
    return colors.local;
  } else if (hops === 999) {
    return colors.noData;
  } else if (hops >= 6) {
    return colors.max;
  } else {
    return colors.gradient[hops - 1] || colors.gradient[colors.gradient.length - 1];
  }
}

/**
 * The bare glyph-less marker disc: the same white circle + hop-colored stroke
 * `roleGlyphMarkerSvg` draws under a glyph. Used when a category has no glyph
 * (the `standard` family) so the strip still shows a hop-colored node.
 * `roleGlyphMarkerSvg` keeps returning '' for those categories — its existing
 * contract is load-bearing for `createNodeIcon` and `MapLegend`.
 */
export function plainNodeDiscSvg(color: string, size = 24): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="2" />`
    + `</svg>`;
}

/**
 * Neutral placeholder for a BROADCAST_ADDR hop that never self-identified:
 * dashed grey circle with a centered "?" — visibly "a hop happened here, we
 * don't know who".
 */
export function unknownNodeSvg(size = 24): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="#9ca3af" stroke-width="2" stroke-dasharray="4 3" />`
    + `<text x="24" y="30" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="#9ca3af">?</text>`
    + `</svg>`;
}
