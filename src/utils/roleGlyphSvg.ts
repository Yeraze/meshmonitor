/**
 * Pure SVG string builders for node role glyphs. **Leaflet-free on purpose** —
 * `markerIcons.ts` re-exports these for map callers, and off-map surfaces
 * (the Node Details traceroute strip) import them directly so they don't pull
 * Leaflet into a non-map bundle/test. Do not add a Leaflet import here.
 */

import { categoryGlyphFamily, type GlyphFamily, type NodeTypeCategory } from './nodeTypeCategory.js';
import { isRoleBadgeKind, type MarkerRoleKind, type RoleBadgeKind } from './nodeRoleMarker.js';

/**
 * Inner SVG markup for a node-type role glyph, drawn inside the 48×48 viewBox
 * over a white background circle (issue #3546). Returns '' for 'standard' so
 * callers fall back to the default pin/circle. `color` is the hop color so the
 * glyph stays consistent with the marker's stroke.
 *
 * Meshtastic role categories (issue #3610) draw through {@link categoryGlyphFamily}:
 * only infrastructure swaps the glyph (#6008). ROUTER / ROUTER_LATE / the
 * deprecated ROUTER_CLIENT and REPEATER draw the `'router'` tower, apart from
 * the MeshCore Repeater's mesh relay (#5491); CLIENT_BASE draws a base station.
 * Other roles return '' and get a corner badge ({@link roleBadgeSvg}).
 */
/**
 * The Meshtastic router tower silhouette (tower + signal waves): the `'router'`
 * glyph family (ROUTER / ROUTER_LATE / REPEATER, #5491) and the base of the
 * ROUTER_LATE variant (issue #4295). Drawn in the 48×48 role-glyph viewBox.
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
 * The MeshCore Repeater glyph (#5491): a mesh relay, one hub linked to three
 * peers. Wide and round where the Meshtastic tower is tall and thin, so the two
 * infrastructure types read apart on the Unified map. 48×48 role-glyph viewBox.
 */
function meshcoreRepeaterSvg(color: string): string {
  return `
        <path d="M 24 25 L 24 11 M 24 25 L 11.5 33 M 24 25 L 36.5 33" stroke="#555" stroke-width="3" stroke-linecap="round" />
        <circle cx="24" cy="11" r="4.5" fill="${color}" />
        <circle cx="11.5" cy="33" r="4.5" fill="${color}" />
        <circle cx="36.5" cy="33" r="4.5" fill="${color}" />
        <circle cx="24" cy="25" r="6" fill="#555" />
        <circle cx="24" cy="25" r="2.5" fill="white" />`;
}

/**
 * The CLIENT_BASE glyph (#6008): a base station, a house with the router
 * tower's antenna and signal waves on its roof. It shares the tower's grey
 * body and hop-coloured waves so it reads as infrastructure, while the house
 * shape keeps it apart from a ROUTER. Drawn in the 48x48 role-glyph viewBox.
 */
function clientBaseSvg(color: string): string {
  return `
        <rect x="22.5" y="5" width="3" height="11" fill="#555" />
        <circle cx="24" cy="5" r="3" fill="${color}" />
        <path d="M 17 9 C 14 9 11.5 11 11.5 13.5" stroke="${color}" stroke-width="2.5" fill="none" />
        <path d="M 31 9 C 34 9 36.5 11 36.5 13.5" stroke="${color}" stroke-width="2.5" fill="none" />
        <path d="M 9 28 L 24 15 L 39 28 Z" fill="#555" />
        <rect x="13" y="27" width="22" height="15" fill="#555" />
        <rect x="21" y="32" width="6" height="10" fill="white" />`;
}

/**
 * Glyphs for the role corner badges (#6008), drawn in a 24x24 viewBox. Paths
 * are from Lucide (ISC licence, https://lucide.dev), the set behind `UiIcon`:
 * `navigation` (tracker), `life-buoy` (lost and found), `thermometer`
 * (sensor, as UiIcon's `sensor`), `crosshair` (TAK, as UiIcon's `target`) and
 * `volume-x` (client mute, as UiIcon's `muted`). Scaled to 60% about the
 * centre so they clear the disc's edge.
 */
const ROLE_BADGE_GLYPHS: Record<RoleBadgeKind, string> = {
  tracker: '<polygon points="3 11 22 2 13 21 11 13 3 11" />',
  lostAndFound: '<circle cx="12" cy="12" r="10" /><path d="m4.93 4.93 4.24 4.24" /><path d="m14.83 9.17 4.24-4.24" /><path d="m14.83 14.83 4.24 4.24" /><path d="m9.17 14.83-4.24 4.24" /><circle cx="12" cy="12" r="4" />',
  sensor: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />',
  tak: '<circle cx="12" cy="12" r="10" /><line x1="22" x2="18" y1="12" y2="12" /><line x1="6" x2="2" y1="12" y2="12" /><line x1="12" x2="12" y1="6" y2="2" /><line x1="12" x2="12" y1="22" y2="18" />',
  clientMute: '<path d="M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z" /><path d="m16.5 14.5 5-5" /><path d="m16.5 9.5 5 5" />',
};

/**
 * Theme role tokens for each badge: `disc` fills the badge, `ink` strokes the
 * glyph and the disc's rim. Lost and Found inverts the pair (a solid caution
 * disc) so a lost device stands out; Client Mute uses muted text so its mark
 * stays quiet. Tokens resolve per theme, so the badge follows light and dark.
 */
const ROLE_BADGE_TOKENS: Record<RoleBadgeKind, { disc: string; ink: string }> = {
  tracker: { disc: 'var(--color-bg-raised)', ink: 'var(--color-info)' },
  lostAndFound: { disc: 'var(--color-caution)', ink: 'var(--color-bg-raised)' },
  sensor: { disc: 'var(--color-bg-raised)', ink: 'var(--color-success)' },
  tak: { disc: 'var(--color-bg-raised)', ink: 'var(--color-accent-alt)' },
  clientMute: { disc: 'var(--color-bg-raised)', ink: 'var(--color-text-muted)' },
};

/**
 * Role corner badge (#6008) as a complete `<svg>` string: a theme-coloured disc
 * with a Lucide glyph. Colours are CSS custom properties, so the markup must be
 * inlined into the page (a divIcon or `dangerouslySetInnerHTML`), not loaded as
 * an image. `data-role-badge` names the kind for tests and styling.
 */
export function roleBadgeSvg(kind: RoleBadgeKind, size: number): string {
  const { disc, ink } = ROLE_BADGE_TOKENS[kind];
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" data-role-badge="${kind}">`
    + `<circle cx="12" cy="12" r="11" style="fill: ${disc}; stroke: ${ink}" stroke-width="1.5" />`
    + `<g style="stroke: ${ink}" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(4.8 4.8) scale(0.6)">${ROLE_BADGE_GLYPHS[kind]}</g>`
    + `</svg>`;
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

/**
 * "Likely aircraft" corner badge (#5364/#5365 Phase 1 WP4): a white disc (same
 * treatment as {@link unmessageableBadgeSvg}) carrying the Lucide `Plane`
 * glyph path (lucide-react, ISC licence, https://lucide.dev/icons/plane),
 * scaled down and centered so it clears the disc's edge. Blue stroke keeps it
 * visually distinct from the unmessageable badge's muted red "no" semantic —
 * this badge states a fact (classification), not a warning.
 */
export function aircraftBadgeSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="12" cy="12" r="11" fill="white" fill-opacity="0.95" />`
    + `<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" fill="none" stroke="#1f6feb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(3 3) scale(0.75)" />`
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
  return glyphFamilyInnerSvg(categoryGlyphFamily(category), color);
}

/**
 * Inner SVG markup for a glyph FAMILY (see {@link categoryGlyphFamily}). The 3D
 * map keys its rasterized icons by family, so it draws through here rather than
 * by category. Returns '' for `'standard'`.
 */
export function glyphFamilyInnerSvg(family: GlyphFamily, color: string): string {
  switch (family) {
    case 'router':
      // Meshtastic infrastructure: tower with signal waves, overflows the
      // circle so backbone nodes read at a glance.
      return repeaterTowerSvg(color);
    case 'repeater':
      // MeshCore Repeater: mesh relay (#5491).
      return meshcoreRepeaterSvg(color);
    case 'clientBase':
      // Meshtastic CLIENT_BASE: base station (#6008).
      return clientBaseSvg(color);
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
  return wrapGlyphMarker(roleGlyphInnerSvg(category, color), color, size);
}

/** {@link roleGlyphMarkerSvg} for a glyph family (the 3D map's icon key). */
export function glyphFamilyMarkerSvg(family: GlyphFamily, color: string, size = 24): string {
  return wrapGlyphMarker(glyphFamilyInnerSvg(family, color), color, size);
}

function wrapGlyphMarker(inner: string, color: string, size: number): string {
  if (!inner) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="2" />`
    + `${inner}</svg>`;
}

/** The category whose glyph draws each infrastructure marker kind. */
const INFRA_KIND_CATEGORY: Record<'router' | 'routerLate' | 'clientBase', NodeTypeCategory> = {
  router: 'mtRouter',
  routerLate: 'mtRouterLate',
  clientBase: 'mtClientBase',
};

/**
 * Legend swatch for a Meshtastic role marker kind (#6008): the infrastructure
 * glyph over its disc, or the corner badge. Returns '' for `'none'`.
 */
export function roleMarkerLegendSvg(kind: MarkerRoleKind, color: string, size = 20): string {
  if (kind === 'none') return '';
  if (isRoleBadgeKind(kind)) return roleBadgeSvg(kind, size);
  return roleGlyphMarkerSvg(INFRA_KIND_CATEGORY[kind], color, size);
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
