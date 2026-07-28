/**
 * NodeGlyph (issue #4381 WP3) — thin React wrapper around the pure SVG
 * role-glyph builders in `src/utils/roleGlyphSvg.ts`. Renders the exact same
 * marker glyph the Node Map draws for a node's category/hop color, so the
 * Node Details traceroute strip stays visually consistent with the map
 * without re-deriving or re-drawing anything (see
 * docs/internal/dev-notes/TRACEROUTE_VISUAL_STRIP_SPEC.md §4.2).
 *
 * `dangerouslySetInnerHTML` is correct and precedented here — `MapLegend.tsx`
 * renders the same builder output the same way. The strings are
 * machine-generated from a closed category enum plus a hex color, never from
 * user input.
 */
import type { NodeTypeCategory } from '../../utils/nodeTypeCategory';
import {
  roleGlyphMarkerSvg,
  plainNodeDiscSvg,
  unknownNodeSvg,
  unmessageableBadgeSvg,
} from '../../utils/roleGlyphSvg';
import styles from './NodeGlyph.module.css';

export interface NodeGlyphProps {
  category: NodeTypeCategory;
  /**
   * Already resolved through `getHopColor` — NEVER a caller-invented color.
   * This value is interpolated directly into a generated SVG string, so a
   * caller must never route user-supplied text (e.g. a node name) into it.
   */
  color: string;
  /** Glyph edge length in px. */
  size?: number;
  unmessagable?: boolean;
  /** Render the neutral unknown-hop placeholder instead of a role glyph. */
  unknown?: boolean;
  className?: string;
}

export function NodeGlyph({
  category,
  color,
  size = 32,
  unmessagable,
  unknown,
  className,
}: NodeGlyphProps) {
  const svg = unknown
    ? unknownNodeSvg(size)
    : roleGlyphMarkerSvg(category, color, size) || plainNodeDiscSvg(color, size);

  const wrapperClassName = className ? `${styles.wrapper} ${className}` : styles.wrapper;

  return (
    <span className={wrapperClassName}>
      {/* aria-hidden: the accessible name lives on the strip-node wrapper
          (TracerouteStrip.tsx), so a screen reader announces the node once. */}
      <span className={styles.glyph} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
      {unmessagable && (
        <span
          className={styles.badge}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: unmessageableBadgeSvg(Math.round(size * 0.4)) }}
        />
      )}
    </span>
  );
}

export default NodeGlyph;
