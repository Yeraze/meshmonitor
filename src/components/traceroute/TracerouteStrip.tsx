/**
 * TracerouteStrip (issue #4381 WP3) — a single left-to-right strip of
 * Node-Map node glyphs, arrowed for direction, SNR-labelled, deduplicated
 * across the forward and return legs, with a branch sub-row where the two
 * legs diverge. Replaces the two plain-text route lines in the Node Details
 * traceroute box (`MessagesTab.tsx`, wired up in WP4).
 *
 * A pure function of `(graph, meta, compact)` — no contexts, no hooks besides
 * `useTranslation`, `useId`, and one `useMemo` around `layoutTracerouteStrip`.
 * All graph math (dedup, divergence, column layout, edge geometry) already
 * happened in `src/utils/tracerouteStrip.ts` (WP2); this component only
 * paints it.
 *
 * See docs/internal/dev-notes/TRACEROUTE_VISUAL_STRIP_SPEC.md §4.3/§4.4.
 */
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeTypeCategory } from '../../utils/nodeTypeCategory';
import { getHopColor } from '../../utils/roleGlyphSvg';
import {
  layoutTracerouteStrip,
  type StripLayoutOptions,
  type TracerouteStripGraph,
} from '../../utils/tracerouteStrip';
import { NodeGlyph } from './NodeGlyph';
import styles from './TracerouteStrip.module.css';

export interface TracerouteStripNodeMeta {
  nodeNum: number;
  /** Display shortName; falls back to the last 4 hex digits. */
  shortName: string;
  longName: string | null;
  /** Human role name, e.g. "Router (Late)". null when unknown. */
  roleLabel: string | null;
  /** "!a1b2c3d4" — node.user.id when known, else padded hex. */
  nodeId: string;
  category: NodeTypeCategory;
  /** Effective hops; 999 = unknown (grey). */
  hops: number;
  unmessagable: boolean;
}

export interface TracerouteStripProps {
  graph: TracerouteStripGraph;
  /** nodeNum -> metadata. A missing entry renders the unknown placeholder. */
  meta: Map<number, TracerouteStripNodeMeta>;
  /** Narrow-container mode: smaller pitch + glyph + font. Driven by the
   *  `compact` prop, not only a media query — the split-view side panel is
   *  narrow even on a wide viewport. */
  compact?: boolean;
}

/** Layout numbers for the narrow (split-view) presentation — spec §4.4. */
const COMPACT_LAYOUT: Partial<StripLayoutOptions> = {
  colWidth: 48,
  rowHeight: 44,
  glyphSize: 24,
  topBand: 34,
  bottomBand: 20,
};

const DEFAULT_GLYPH_SIZE = 32;
const COMPACT_GLYPH_SIZE = 24;

const UNKNOWN_HOP_COLOR = '#9ca3af';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/** "!a1b2c3d4" fallback node id, matching `tracerouteStripMeta.ts`'s shape. */
function paddedHexId(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

export function TracerouteStrip({ graph, meta, compact }: TracerouteStripProps) {
  const { t } = useTranslation();
  const uid = useId();

  const layout = useMemo(
    () => layoutTracerouteStrip(graph, compact ? COMPACT_LAYOUT : undefined),
    [graph, compact],
  );

  const glyphSize = compact ? COMPACT_GLYPH_SIZE : DEFAULT_GLYPH_SIZE;
  const arrowId = `${uid}-head`;

  const stripLabel = t('messages.traceroute_strip_label', 'Traceroute path');
  const forwardLegCaption = t('messages.traceroute_leg_forward', 'Forward');
  const returnLegCaption = t('messages.traceroute_leg_return', 'Return');
  const unknownNodeLabel = t('messages.traceroute_unknown_node', 'Unknown');

  return (
    <div className={cx(styles.scroller, compact && styles.compact)} role="group" aria-label={stripLabel}>
      <div className={styles.canvas} style={{ width: layout.width, height: layout.height }}>
        <svg
          className={styles.edges}
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            {/* One marker def, shared by both legs — direction is carried by
                arrow orientation, not by a second color (see module banner
                in TracerouteStrip.module.css). */}
            <marker
              id={arrowId}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path className={styles.arrowHead} d="M 0 0 L 10 5 L 0 10 Z" />
            </marker>
          </defs>
          {graph.edges.map((e) => {
            const path = layout.edgePaths.get(e.id);
            if (!path) return null;
            const points = path.map((p) => `${p.x},${p.y}`).join(' ');
            return (
              <polyline
                key={e.id}
                className={e.leg === 'forward' ? styles.forwardEdge : styles.returnEdge}
                points={points}
                markerEnd={`url(#${arrowId})`}
              />
            );
          })}
        </svg>

        {graph.edges.map((e) => {
          // An edge with no SNR sample and no unknown-sentinel flag renders
          // NO label element at all (not an empty span) — keeps the DOM
          // assertable (spec §4.3).
          if (e.snr === null && !e.snrUnknown) return null;
          const anchor = layout.labelAnchors.get(e.id);
          if (!anchor) return null;
          const laneClass = e.leg === 'forward' ? styles.above : styles.below;
          const laneCaption = e.leg === 'forward' ? forwardLegCaption : returnLegCaption;
          return (
            <span
              key={e.id}
              className={cx(styles.snrLabel, laneClass)}
              style={{ left: anchor.x, top: anchor.y }}
            >
              <span className={styles.srOnly}>{laneCaption}: </span>
              {e.snrUnknown ? (
                <span
                  className={styles.snrUnknown}
                  title={t(
                    'messages.traceroute_snr_unknown',
                    'Unknown SNR (MQTT-bridged hop, decrypt failure, or old firmware)',
                  )}
                >
                  ?
                </span>
              ) : (
                t('messages.traceroute_hop_snr', '{{snr}} dB', { snr: e.snr!.toFixed(1) })
              )}
            </span>
          );
        })}

        {graph.nodes.map((n) => {
          const center = layout.centers.get(n.id);
          if (!center) return null;

          const isPlaceholder = n.isUnknown || !meta.has(n.nodeNum);
          const nodeMeta = isPlaceholder ? undefined : meta.get(n.nodeNum);

          const shortName = nodeMeta?.shortName ?? unknownNodeLabel;
          const longName = nodeMeta?.longName ?? null;
          const roleLabel = nodeMeta?.roleLabel ?? null;
          const nodeId = nodeMeta?.nodeId ?? paddedHexId(n.nodeNum);
          const category: NodeTypeCategory = nodeMeta?.category ?? 'standard';
          const color = nodeMeta ? getHopColor(nodeMeta.hops) : UNKNOWN_HOP_COLOR;
          const unmessagable = !!nodeMeta?.unmessagable;

          const displayName = longName ? `${longName} (${shortName})` : shortName;
          const accessibleName = t('messages.traceroute_node_label', '{{name}}, {{role}}, {{id}}', {
            name: displayName,
            role: roleLabel ?? '',
            id: nodeId,
          });

          const tipId = `${uid}-tip-${n.id}`;

          return (
            <div
              key={n.id}
              className={styles.node}
              style={{ left: center.x, top: center.y }}
              tabIndex={0}
              aria-describedby={tipId}
              aria-label={accessibleName}
            >
              <NodeGlyph
                category={category}
                color={color}
                size={glyphSize}
                unmessagable={unmessagable}
                unknown={isPlaceholder}
              />
              <span className={styles.shortName}>{shortName}</span>
              {/* Always in the DOM (opacity: 0, not display: none) so
                  aria-describedby resolves for assistive tech (spec §4.3). */}
              <span id={tipId} role="tooltip" className={styles.tooltip}>
                {!isPlaceholder && (
                  <>
                    <span className={styles.tipLong}>{longName ?? shortName}</span>
                    {roleLabel && <span className={styles.tipRole}>{roleLabel}</span>}
                  </>
                )}
                <span className={styles.tipId}>{nodeId}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TracerouteStrip;
