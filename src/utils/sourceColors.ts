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
