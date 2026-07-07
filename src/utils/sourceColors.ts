/**
 * Stable color palette for tagging entries by source in cross-source ("Unified")
 * views. The palette mirrors the inline ones in UnifiedMessagesPage /
 * UnifiedTelemetryPage so source colors stay visually consistent across pages.
 *
 * Colors are assigned by the source's index within a stable, sorted source list
 * so a given source keeps the same color across filter/sort changes.
 */
export const SOURCE_COLORS = [
  'var(--ctp-blue)',
  'var(--ctp-mauve)',
  'var(--ctp-green)',
  'var(--ctp-peach)',
  'var(--ctp-yellow)',
  'var(--ctp-teal)',
  'var(--ctp-pink)',
  'var(--ctp-sapphire)',
];

/**
 * Resolve the color for a source id given the ordered list of source ids.
 * Falls back to the first color when the id is not found.
 */
export function getSourceColor(sourceId: string, sourceIds: string[]): string {
  const idx = sourceIds.indexOf(sourceId);
  return SOURCE_COLORS[(idx < 0 ? 0 : idx) % SOURCE_COLORS.length];
}

/**
 * Resolve a color value to a literal (hex/rgb) string.
 *
 * The palette in {@link SOURCE_COLORS} is expressed as CSS custom properties
 * (`var(--ctp-blue)`). CSS variables resolve fine when set on an element's
 * `style` (backgrounds, borders, legend swatches), but Leaflet paints SVG
 * strokes via the presentation *attribute* (`setAttribute('stroke', color)`),
 * which does NOT evaluate `var()`. Leaflet overlays (e.g. the polar grid on the
 * Unified map) therefore need the computed literal. This reads the variable off
 * `:root` via getComputedStyle; non-var values pass through unchanged, and it is
 * a no-op fallback when there is no `document` (SSR/tests without a DOM).
 */
export function resolveCssColor(value: string): string {
  const match = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (match && typeof document !== 'undefined') {
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue(match[1])
      .trim();
    if (resolved) return resolved;
  }
  return value;
}

/**
 * Like {@link getSourceColor} but resolved to a literal color usable as a
 * Leaflet stroke. See {@link resolveCssColor} for why the raw `var(...)` form
 * cannot be handed directly to Leaflet.
 */
export function resolveSourceColor(sourceId: string, sourceIds: string[]): string {
  return resolveCssColor(getSourceColor(sourceId, sourceIds));
}
