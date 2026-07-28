/**
 * TracerouteStrip (issue #4381 WP3) — a single left-to-right strip of
 * Node-Map node glyphs, arrowed for direction, SNR-labelled, deduplicated
 * across the forward and return legs, with a branch sub-row where the two
 * legs diverge. Replaces the two plain-text route lines in the Node Details
 * traceroute box (`MessagesTab.tsx`, wired up in WP4).
 *
 * A pure function of `(graph, meta)` — no contexts, no hooks besides
 * `useTranslation`, `useId`, and one `useMemo` around `layoutTracerouteStrip`.
 * All graph math (dedup, divergence, column layout, edge geometry) already
 * happened in `src/utils/tracerouteStrip.ts` (WP2); this component only
 * paints it.
 *
 * See docs/internal/dev-notes/TRACEROUTE_VISUAL_STRIP_SPEC.md §4.3/§4.4.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { NodeTypeCategory } from '../../utils/nodeTypeCategory';
import type { DateFormat, TimeFormat } from '../../contexts/SettingsContext';
import { getHopColor } from '../../utils/roleGlyphSvg';
import {
  layoutTracerouteStrip,
  paddedHexId,
  type StripLane,
  type TracerouteStripGraph,
} from '../../utils/tracerouteStrip';
import { NodeCard } from '../map/popups/NodeCard';
import { IdentityItems, SignalItems, PositionItem, LastHeardFooter } from '../map/popups/sections';
import type { NodeCardModel } from '../map/popups/nodeCardModel';
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
  /** View-model for the hover popup — the same card the Map page renders.
   *  Built by `buildStripNodeMeta`, which is the layer that holds the
   *  `DeviceInfo`; this component stays a pure function of plain data. */
  card: NodeCardModel;
  /** Reported coordinates, when the node has a position fix. */
  pos?: { lat: number; lng: number };
}

export interface TracerouteStripProps {
  graph: TracerouteStripGraph;
  /** nodeNum -> metadata. A missing entry renders the unknown placeholder. */
  meta: Map<number, TracerouteStripNodeMeta>;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  distanceUnit?: 'km' | 'mi' | 'nm';
}

/** Gap between the glyph and the popup, and the minimum margin kept between
 *  the popup and every viewport edge. */
const POPUP_GAP = 8;

interface HoverState {
  /** StripNode id — identifies the exact glyph, not just the nodeNum (the
   *  same node can occupy several lanes). */
  id: string;
  nodeNum: number;
  isPlaceholder: boolean;
  fallbackId: string;
  anchor: HTMLElement;
}

interface PopupPosition {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

const DEFAULT_GLYPH_SIZE = 32;

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/** Maps a StripNode's semantic band to its CSS lane hook (spec §4.3/§4.4).
 * Deliberately empty rules today — an assertable class name and a home for
 * any future visual differentiation, not a styling switch. Do not branch
 * component logic on lane; if a raised/dropped node ever needs to look
 * different, that is a CSS rule against these hooks, not a code path here. */
function laneClassFor(lane: StripLane): string {
  switch (lane) {
    case 'forward':
      return styles.laneForward;
    case 'return':
      return styles.laneReturn;
    case 'spine':
    default:
      return styles.laneSpine;
  }
}

export function TracerouteStrip({
  graph,
  meta,
  timeFormat,
  dateFormat,
  distanceUnit = 'km',
}: TracerouteStripProps) {
  const { t } = useTranslation();
  const uid = useId();

  const layout = useMemo(() => layoutTracerouteStrip(graph), [graph]);

  const [hover, setHover] = useState<HoverState | null>(null);
  const [popupPos, setPopupPos] = useState<PopupPosition | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const hide = useCallback(() => {
    setHover(null);
    setPopupPos(null);
  }, []);

  const show = useCallback(
    (id: string, nodeNum: number, isPlaceholder: boolean, fallbackId: string, anchor: HTMLElement) => {
      setPopupPos(null); // re-measure for the new anchor before showing
      setHover({ id, nodeNum, isPlaceholder, fallbackId, anchor });
    },
    [],
  );

  /**
   * Place the popup against the anchor glyph, in viewport coordinates.
   *
   * Prefer above; flip below when there isn't room. The popup is portalled to
   * `document.body` because `.node` carries a `transform`, which would
   * otherwise make it the containing block for a `position: fixed` child and
   * trap the popup inside `.scroller`'s `overflow: hidden`.
   *
   * Measures the rendered popup rather than assuming its size — the card's
   * height varies with how many fields a node has.
   */
  const reposition = useCallback(() => {
    const anchor = hover?.anchor;
    const popup = popupRef.current;
    if (!anchor || !popup) return;

    const a = anchor.getBoundingClientRect();
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // The anchor can be scrolled out of view while the popup is open (hover,
    // then scroll the panel). Anchoring to something off-screen would drag the
    // popup off with it, so drop it instead.
    if (a.bottom < 0 || a.top > vh || a.right < 0 || a.left > vw) {
      hide();
      return;
    }

    let placement: 'above' | 'below' = 'above';
    let top = a.top - POPUP_GAP - height;
    if (top < POPUP_GAP) {
      placement = 'below';
      top = a.bottom + POPUP_GAP;
      // Neither side fits (very short viewport): clamp into view rather than
      // letting it run off the bottom.
      if (top + height > vh - POPUP_GAP) {
        top = Math.max(POPUP_GAP, vh - POPUP_GAP - height);
      }
    }

    const left = Math.max(
      POPUP_GAP,
      Math.min(a.left + a.width / 2 - width / 2, vw - POPUP_GAP - width),
    );

    setPopupPos((prev) =>
      prev && prev.left === left && prev.top === top && prev.placement === placement
        ? prev
        : { left, top, placement },
    );
  }, [hover, hide]);

  // Position after the popup has rendered (so it can be measured), before paint.
  useLayoutEffect(() => {
    if (!hover) return;
    reposition();
  }, [hover, reposition]);

  // The strip sits inside `.nodes-main-content`, which scrolls — so the anchor
  // moves without the window scrolling. `capture: true` catches scroll on any
  // ancestor, not just the window.
  useEffect(() => {
    if (!hover) return;
    const onMove = () => reposition();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [hover, reposition]);

  const glyphSize = DEFAULT_GLYPH_SIZE;
  const arrowId = `${uid}-head`;

  /**
   * The hover popup body — the same card the Map page renders, minus the
   * action buttons (the popup is non-interactive) and minus the traceroute
   * tab (redundant inside a traceroute strip). Composed from the shared
   * popup family rather than re-implemented.
   *
   * A hop we never resolved (`BROADCAST_ADDR`, or a node absent from `meta`)
   * has no card model, so it falls back to a minimal card carrying just the
   * padded hex id — same information the old inline tooltip showed.
   */
  const hoverCard = useMemo(() => {
    if (!hover) return null;
    const hovered = hover.isPlaceholder ? undefined : meta.get(hover.nodeNum);

    if (!hovered) {
      return (
        <NodeCard
          model={{ longName: t('messages.traceroute_unknown_node', 'Unknown') }}
          sections={
            <div className="node-popup-grid">
              <IdentityItems model={{ longName: '', nodeId: hover.fallbackId }} />
            </div>
          }
        />
      );
    }

    return (
      <NodeCard
        model={hovered.card}
        sections={
          <>
            <div className="node-popup-grid">
              <IdentityItems model={hovered.card} />
              <SignalItems
                model={hovered.card}
                showAltitude
                showPluggedIn
                snrDecimals={1}
                distanceUnit={distanceUnit}
              />
              {hovered.pos && <PositionItem position={hovered.pos} />}
            </div>
            <LastHeardFooter
              lastHeard={hovered.card.lastHeard}
              mode="absolute"
              timeFormat={timeFormat}
              dateFormat={dateFormat}
            />
          </>
        }
      />
    );
  }, [hover, meta, distanceUnit, timeFormat, dateFormat, t]);

  const stripLabel = t('messages.traceroute_strip_label', 'Traceroute path');
  const forwardLegCaption = t('messages.traceroute_leg_forward', 'Forward');
  const returnLegCaption = t('messages.traceroute_leg_return', 'Return');
  const unknownNodeLabel = t('messages.traceroute_unknown_node', 'Unknown');

  return (
    <div className={styles.scroller} role="group" aria-label={stripLabel}>
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
          // Reuses the map's existing "unknown hops = grey" convention
          // (getHopColor(999)) instead of inventing a second grey — and for a
          // placeholder node this value never actually reaches the DOM anyway
          // (NodeGlyph's `unknown` branch renders unknownNodeSvg, which
          // ignores `color` entirely).
          const color = getHopColor(nodeMeta?.hops ?? 999);
          const unmessagable = !!nodeMeta?.unmessagable;

          const displayName = longName ? `${longName} (${shortName})` : shortName;
          // Join only the present segments — a null roleLabel (very common:
          // an unlearned role, or the unknown-hop placeholder) must not leave
          // a dangling ", ," in the accessible name.
          const accessibleName = [displayName, roleLabel, nodeId]
            .filter((part): part is string => !!part)
            .join(t('messages.traceroute_node_label_separator', ', '));

          const tipId = `${uid}-tip-${n.id}`;

          return (
            <div
              key={n.id}
              className={cx(styles.node, laneClassFor(n.lane))}
              style={{ left: center.x, top: center.y }}
              tabIndex={0}
              aria-describedby={hover?.id === n.id ? tipId : undefined}
              aria-label={accessibleName}
              onMouseEnter={(e) =>
                show(n.id, n.nodeNum, isPlaceholder, nodeId, e.currentTarget)
              }
              onMouseLeave={hide}
              onFocus={(e) => show(n.id, n.nodeNum, isPlaceholder, nodeId, e.currentTarget)}
              onBlur={hide}
            >
              <NodeGlyph
                category={category}
                color={color}
                size={glyphSize}
                unmessagable={unmessagable}
                unknown={isPlaceholder}
              />
              <span className={styles.shortName}>{shortName}</span>
            </div>
          );
        })}
      </div>

      {hover &&
        createPortal(
          <div
            ref={popupRef}
            id={`${uid}-tip-${hover.id}`}
            role="tooltip"
            className={cx(styles.hoverPopup, popupPos && styles.hoverPopupReady)}
            style={{ left: popupPos?.left ?? 0, top: popupPos?.top ?? 0 }}
          >
            {hoverCard}
          </div>,
          document.body,
        )}
    </div>
  );
}

export default TracerouteStrip;
