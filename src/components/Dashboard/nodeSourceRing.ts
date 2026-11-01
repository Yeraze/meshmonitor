/**
 * #6125: "Colour nodes by source" — a per-source ring around node markers on
 * the Dashboard Unified (cross-source) map.
 *
 * Kept in its own module (not DashboardMap.tsx) so the component file exports
 * only components — a non-component export there trips
 * `react-refresh/only-export-components`.
 */
import L from 'leaflet';
import { getSourceColor } from '../../utils/sourceColors';

/**
 * The per-source ring colour for a node, or null when no ring should be drawn.
 *
 * Returns null unless the toggle is on AND this is the Unified (cross-source)
 * map AND the node carries a source — single-source views are unaffected. The
 * colour reuses {@link getSourceColor} so the ring matches the colour that
 * source already uses in Unified Messages/Telemetry, flight lines, and the
 * polar-grid legend.
 */
export function nodeSourceRingColor(
  colorNodesBySource: boolean,
  isUnified: boolean,
  sourceId: string | number | null | undefined,
  colorSourceIds: string[],
): string | null {
  if (!colorNodesBySource || !isUnified || sourceId == null) return null;
  return getSourceColor(String(sourceId), colorSourceIds);
}

/**
 * Wrap a node marker's divIcon in a per-source coloured ring.
 *
 * The ring is a CSS `box-shadow` on a wrapper around the existing marker html,
 * so it leaves the role glyph and the age opacity untouched (the issue is
 * explicit that the whole marker must NOT be recoloured — that would collide
 * with the role encoding). Because the ring colour is a CSS property (not an
 * SVG presentation attribute) a `var(--chart-N)` token resolves fine, so no
 * `resolveCssColor` is needed.
 *
 * `ringColor === null` returns the icon unchanged, so non-unified callers and
 * the toggle-off case render byte-identical output.
 */
export function applyNodeSourceRing(icon: L.DivIcon, ringColor: string | null): L.DivIcon {
  if (!ringColor) return icon;
  const baseHtml = typeof icon.options.html === 'string' ? icon.options.html : '';
  icon.options.html = `<div class="node-source-ring" data-source-ring style="box-shadow: 0 0 0 3px ${ringColor}; border-radius: 50%; display: inline-block; line-height: 0;">${baseHtml}</div>`;
  return icon;
}
