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
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { NodeTypeCategory } from '../../utils/nodeTypeCategory';
import type { DateFormat, TimeFormat } from '../../contexts/SettingsContext';
import { getHopColor } from '../../utils/roleGlyphSvg';
import { calculateDistance, formatDistance } from '../../utils/distance';
import {
  layoutTracerouteStrip,
  paddedHexId,
  type StripEdge,
  type StripLane,
  type TracerouteStripGraph,
} from '../../utils/tracerouteStrip';
import {
  isUnionStripGraph,
  layoutTracerouteUnion,
  type UnionStripEdge,
  type UnionStripGraph,
  type UnionStripNode,
} from '../../utils/tracerouteUnionLayout';
import { NodeCard } from '../map/popups/NodeCard';
import { IdentityItems, SignalItems, PositionItem, LastHeardFooter, NodeActions } from '../map/popups/sections';
import type { NodeCardModel } from '../map/popups/nodeCardModel';
import { UiIcon } from '../icons';
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
  /** `node.user.id` when the node has a real user record, else undefined.
   *  Distinct from `nodeId`, which falls back to `paddedHexId`. Gates the
   *  "More Details" action: only a real user id can select a conversation. */
  userId?: string;
}

export interface TracerouteStripProps {
  graph: TracerouteStripGraph;
  /** nodeNum -> metadata. A missing entry renders the unknown placeholder. */
  meta: Map<number, TracerouteStripNodeMeta>;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  distanceUnit?: 'km' | 'mi' | 'nm';
  /** Load this node into the Node Details panel. When omitted (or when the
   *  hovered hop has no `meta.userId`) the popup renders no action button.
   *  Kept as a narrow callback so the strip stays a pure function of plain
   *  data — it never learns about MessagingContext, tabs, or DeviceInfo. */
  onOpenNodeDetails?: (nodeUserId: string) => void;
}

/** Gap between the glyph and the popup, and the minimum margin kept between
 *  the popup and every viewport edge. */
const POPUP_GAP = 8;

/** How long the popup survives after the pointer leaves the glyph, so the
 *  pointer can cross the POPUP_GAP into the card. Pointer only — blur,
 *  scroll-out and unmount still hide immediately. */
export const HOVER_LINGER_MS = 180;

interface HoverNodeTarget {
  kind: 'node';
  /** StripNode id — identifies the exact glyph, not just the nodeNum (the
   *  same node can occupy several lanes). */
  id: string;
  nodeNum: number;
  isPlaceholder: boolean;
  fallbackId: string;
  anchor: HTMLElement;
}

/** WP2: the edge-tooltip counterpart to `HoverNodeTarget`. */
interface HoverEdgeTarget {
  kind: 'edge';
  /** StripEdge id (`${leg}:${fromId}>${toId}`). */
  id: string;
  edge: StripEdge;
  anchor: SVGPolylineElement;
}

/** One target, two kinds — keeps exactly one popup open at a time by
 *  construction (spec §4.2). */
type HoverTarget = HoverNodeTarget | HoverEdgeTarget;

interface PopupPosition {
  left: number;
  top: number;
}

const DEFAULT_GLYPH_SIZE = 32;

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/** React's `CSSProperties` has no index signature for custom properties, so
 *  setting one needs a narrow cast. Kept in one place rather than at three call
 *  sites. Precedent: DashboardSidebar.tsx:505. */
function statStyle(opacity: number, base: CSSProperties): CSSProperties {
  return { ...base, '--stat-opacity': opacity } as CSSProperties;
}

/** Edge variant of `statStyle` — sets `--stat-opacity` AND `--stat-weight` in
 *  one shot so a UnionStripEdge only ever needs one style object. */
function statEdgeStyle(opacity: number, weight: number): CSSProperties {
  return { '--stat-opacity': opacity, '--stat-weight': `${weight}px` } as CSSProperties;
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
  onOpenNodeDetails,
}: TracerouteStripProps) {
  const { t } = useTranslation();
  const uid = useId();

  // D12: the discriminant is `graph.mode`, never `leg`. Null on the single-route
  // path, which then behaves exactly as before this change.
  const statGraph: UnionStripGraph | null = isUnionStripGraph(graph) ? graph : null;

  const layout = useMemo(
    () => (isUnionStripGraph(graph) ? layoutTracerouteUnion(graph) : layoutTracerouteStrip(graph)),
    [graph],
  );

  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [popupPos, setPopupPos] = useState<PopupPosition | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  /** Immediate — keyboard blur, anchor scrolled out of view, action taken. */
  const hideNow = useCallback(() => {
    clearHideTimer();
    setHover(null);
    setPopupPos(null);
  }, [clearHideTimer]);

  /** Pointer-leave — deferred, so travel into the popup can cancel it. */
  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setHover(null);
      setPopupPos(null);
    }, HOVER_LINGER_MS);
  }, [clearHideTimer]);

  // Clear any pending hide on unmount — nothing left to set state on.
  useEffect(() => clearHideTimer, [clearHideTimer]);

  const show = useCallback(
    (id: string, nodeNum: number, isPlaceholder: boolean, fallbackId: string, anchor: HTMLElement) => {
      clearHideTimer(); // re-entering the same glyph or a neighbour cancels a pending hide
      setPopupPos(null); // re-measure for the new anchor before showing
      setHover({ kind: 'node', id, nodeNum, isPlaceholder, fallbackId, anchor });
    },
    [clearHideTimer],
  );

  /** WP2: same shape as `show`, for an edge hit target. */
  const showEdge = useCallback(
    (e: StripEdge, anchor: SVGPolylineElement) => {
      clearHideTimer();
      setPopupPos(null);
      setHover({ kind: 'edge', id: e.id, edge: e, anchor });
    },
    [clearHideTimer],
  );

  /** Touch path: a tap on an already-open hit target closes it; a tap on any
   *  other (or no) target opens it. */
  const toggleEdge = useCallback(
    (e: StripEdge, anchor: SVGPolylineElement) => {
      if (hover?.id === e.id) {
        hideNow();
      } else {
        showEdge(e, anchor);
      }
    },
    [hover, hideNow, showEdge],
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
      hideNow();
      return;
    }

    // Prefer above the glyph; flip below when it doesn't fit. If neither side
    // fits (very short viewport, very tall card) the popup is clamped into
    // view and may overlap the anchor — being readable beats being correctly
    // placed but off-screen.
    let top = a.top - POPUP_GAP - height;
    if (top < POPUP_GAP) {
      top = a.bottom + POPUP_GAP;
      if (top + height > vh - POPUP_GAP) {
        top = Math.max(POPUP_GAP, vh - POPUP_GAP - height);
      }
    }

    const left = Math.max(
      POPUP_GAP,
      Math.min(a.left + a.width / 2 - width / 2, vw - POPUP_GAP - width),
    );

    setPopupPos((prev) =>
      prev && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [hover, hideNow]);

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

  // Touch has no hover-out to dismiss on, so a tap outside the open target
  // (and outside the popup itself) closes it — mirrors the scroll/resize
  // effect above: mounted only while something is open.
  useEffect(() => {
    if (!hover) return;
    const onDown = (ev: PointerEvent) => {
      const target = ev.target as Element | null;
      if (target?.closest?.(`.${styles.edgeHit}`)) return; // handled by onClick
      if (popupRef.current?.contains(target as Node)) return; // clicking inside the card
      hideNow();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [hover, hideNow]);

  const glyphSize = DEFAULT_GLYPH_SIZE;
  const arrowId = `${uid}-head`;

  /** StripNode.id -> StripNode, so an edge's endpoints resolve to nodeNums
   *  (WP2), and so `hoverCard` can look a hovered statistical node's
   *  count/opacity up BY ID (D10) — declared ahead of `hoverCard` because it
   *  is one of that memo's dependencies. */
  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n] as const)),
    [graph],
  );

  /**
   * The hover popup body — the same card the Map page renders, minus the
   * traceroute tab (redundant inside a traceroute strip) and minus every
   * action button except `more-details` (the only one that makes sense from
   * inside a traceroute hop — reused via `NodeActions`, never hand-rolled).
   * Composed from the shared popup family rather than re-implemented.
   *
   * A hop we never resolved (`BROADCAST_ADDR`, or a node absent from `meta`)
   * has no card model, so it falls back to a minimal card carrying just the
   * padded hex id — same information the old inline tooltip showed.
   *
   * Statistical mode (D15) appends/replaces content with a "seen in N of M
   * routes" row; every new string is an inline `t()` call (matching this
   * memo's existing style, e.g. the `traceroute_unknown_node` call just
   * below) rather than a reference to an outer helper, so the only new
   * dependencies this memo needs are `statGraph` and `nodeById` — the count
   * lookup is BY `hover.id`, never by `nodeNum` (D10), since several unknown
   * hops share one `nodeNum` (`BROADCAST_ADDR`).
   */
  const hoverCard = useMemo(() => {
    if (!hover || hover.kind !== 'node') return null;
    const hovered = hover.isPlaceholder ? undefined : meta.get(hover.nodeNum);
    const statNode =
      statGraph && statGraph.totalRoutes > 0 ? (nodeById.get(hover.id) as UnionStripNode | undefined) : undefined;
    const seenInRow = statGraph && statNode ? (
      <div className="node-popup-item node-popup-item-full">
        <span className="node-popup-icon"><UiIcon name="telemetry" /></span>
        <span className={styles.srOnly}>{t('messages.traceroute_stat_seen_in_label', 'Occurrence')}: </span>
        <span className="node-popup-value">
          {t('messages.traceroute_stat_seen_in', {
            seen: statNode.count,
            count: statGraph.totalRoutes,
            percent: Math.round((statNode.count / statGraph.totalRoutes) * 100),
          })}
        </span>
      </div>
    ) : null;

    if (!hovered) {
      if (statGraph) {
        // D15: unrecorded statistical hops are positional — "Unrecorded
        // hop", a description line, and the seen-in row. No hex id
        // (`paddedHexId(BROADCAST_ADDR)` is the same `!ffffffff` for every
        // one of them) and no `IdentityItems` (there is no honest id to show).
        return (
          <NodeCard
            model={{ longName: t('messages.traceroute_stat_unrecorded_hop', 'Unrecorded hop') }}
            sections={
              <div className="node-popup-grid">
                <div className="node-popup-item node-popup-item-full">
                  <span className="node-popup-value">
                    {t(
                      'messages.traceroute_stat_unrecorded_hop_desc',
                      'The traceroute did not record which node relayed here.',
                    )}
                  </span>
                </div>
                {seenInRow}
              </div>
            }
          />
        );
      }
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
              {seenInRow}
            </div>
            <LastHeardFooter
              lastHeard={hovered.card.lastHeard}
              mode="absolute"
              timeFormat={timeFormat}
              dateFormat={dateFormat}
            />
            {onOpenNodeDetails && hovered.userId && (
              <NodeActions
                actions={[{
                  kind: 'more-details',
                  onClick: () => {
                    const userId = hovered.userId!;
                    // Dismiss FIRST: selecting a different node re-renders the
                    // strip for that node's traceroute, which unmounts the
                    // anchor glyph this popup is positioned against. A
                    // surviving popup would be anchored to a detached element.
                    hideNow();
                    onOpenNodeDetails(userId);
                  },
                }]}
              />
            )}
          </>
        }
      />
    );
  }, [hover, meta, distanceUnit, timeFormat, dateFormat, t, onOpenNodeDetails, hideNow, statGraph, nodeById]);

  const stripLabel = t('messages.traceroute_strip_label', 'Traceroute path');
  const forwardLegCaption = t('messages.traceroute_leg_forward', 'Forward');
  const returnLegCaption = t('messages.traceroute_leg_return', 'Return');
  const unknownNodeLabel = t('messages.traceroute_unknown_node', 'Unknown');
  const unrecordedHopLabel = t('messages.traceroute_stat_unrecorded_hop', 'Unrecorded hop');

  /** "Seen in 12 of 15 routes (80%)". The DENOMINATOR is passed as `count`,
   *  because i18next picks the plural form from `count` and the plural noun here
   *  is "routes" (the total), not the numerator. Plain function (not
   *  useCallback) — every call site is either plain render code or (in
   *  `hoverCard`) inlined directly, so it never needs to appear in a
   *  dependency array. */
  const seenInText = (count: number): string | null => {
    if (!statGraph) return null;
    const total = statGraph.totalRoutes;
    if (total <= 0) return null;
    return t('messages.traceroute_stat_seen_in', {
      seen: count,
      count: total,
      percent: Math.round((count / total) * 100),
    });
  };

  /** The `.node-popup-item` row both tooltips append. Reuses the global popup
   *  classes the edge tooltip already uses — no new markup shape. */
  const renderSeenInRow = (count: number) => {
    const text = seenInText(count);
    if (!text) return null;
    return (
      <div className="node-popup-item node-popup-item-full">
        <span className="node-popup-icon"><UiIcon name="telemetry" /></span>
        <span className={styles.srOnly}>{t('messages.traceroute_stat_seen_in_label', 'Occurrence')}: </span>
        <span className="node-popup-value">{text}</span>
      </div>
    );
  };

  /** Same name shape the glyph shows: "Long Name (SHRT)", or the short name
   *  alone, or the unknown placeholder + padded hex for an unresolved hop —
   *  mirrors the `isPlaceholder`/`nodeMeta` pattern the glyph loop below
   *  already uses, so the two stay in lockstep. */
  const displayNameForNodeId = useCallback(
    (stripNodeId: string): string => {
      const node = nodeById.get(stripNodeId);
      if (!node) return unknownNodeLabel;
      const isPlaceholder = node.isUnknown || !meta.has(node.nodeNum);
      const nodeMeta = isPlaceholder ? undefined : meta.get(node.nodeNum);
      if (!nodeMeta) {
        // D4: every unknown statistical hop shares `nodeNum === BROADCAST_ADDR`,
        // so the hex id is the same meaningless `!ffffffff` for all of them —
        // a positional "Unrecorded hop" beats a shared, fake-looking id.
        return statGraph ? unrecordedHopLabel : `${unknownNodeLabel} ${paddedHexId(node.nodeNum)}`;
      }
      return nodeMeta.longName ? `${nodeMeta.longName} (${nodeMeta.shortName})` : nodeMeta.shortName;
    },
    [nodeById, meta, unknownNodeLabel, statGraph, unrecordedHopLabel],
  );

  /** km between two endpoints, or null when either lacks a position fix. */
  const edgeDistanceKm = useCallback(
    (e: StripEdge): number | null => {
      const from = meta.get(nodeById.get(e.fromId)?.nodeNum ?? -1)?.pos;
      const to = meta.get(nodeById.get(e.toId)?.nodeNum ?? -1)?.pos;
      if (!from || !to) return null;
      return calculateDistance(from.lat, from.lng, to.lat, to.lng);
    },
    [meta, nodeById],
  );

  // `formatDistance` accepts only 'km' | 'mi'; 'nm' falls back to metric —
  // the same coercion src/utils/traceroute.tsx and sections.tsx already make.
  const formatUnit: 'km' | 'mi' = distanceUnit === 'mi' ? 'mi' : 'km';

  // Identical formatting to the existing SNR labels (snrDecimals = 1).
  const edgeSnrText = (e: StripEdge): string | null =>
    e.snrUnknown
      ? t(
          'messages.traceroute_snr_unknown',
          'Unknown SNR (MQTT-bridged hop, decrypt failure, or old firmware)',
        )
      : e.snr !== null
        ? t('messages.traceroute_hop_snr', '{{snr}} dB', { snr: e.snr.toFixed(1) })
        : null;

  /** The hit target's aria-label: direction, endpoints, distance and SNR,
   *  joined via the existing separator and skipping any absent fragment —
   *  same "no dangling comma" rule the glyph's accessibleName follows.
   *  Statistical mode (D8/D15) drops direction and SNR and adds the seen-in
   *  fragment; the join/filter/separator tail is shared, not copied. */
  const edgeSummary = (e: StripEdge): string => {
    const km = edgeDistanceKm(e);
    const distance = km !== null ? formatDistance(km, formatUnit, 1) : null;
    const parts: Array<string | null> = statGraph
      ? [
          t('messages.traceroute_stat_edge_endpoints', '{{from}} ↔ {{to}}', {
            from: displayNameForNodeId(e.fromId),
            to: displayNameForNodeId(e.toId),
          }),
          distance,
          seenInText((e as UnionStripEdge).count),
        ]
      : [
          e.leg === 'forward' ? forwardLegCaption : returnLegCaption,
          t('messages.traceroute_edge_endpoints', '{{from}} → {{to}}', {
            from: displayNameForNodeId(e.fromId),
            to: displayNameForNodeId(e.toId),
          }),
          distance,
          edgeSnrText(e),
        ];
    return parts
      .filter((part): part is string => !!part)
      .join(t('messages.traceroute_node_label_separator', ', '));
  };

  /** Edge tooltip body (WP2) — plain JSX reusing the `.node-popup-*` classes
   *  rather than `NodeCard`: an edge has no node model to render. Distance
   *  and SNR rows are omitted entirely when absent, matching the existing
   *  SNR-label convention and keeping the DOM assertable. */
  const renderEdgeTooltip = (e: StripEdge) => {
    const from = displayNameForNodeId(e.fromId);
    const to = displayNameForNodeId(e.toId);
    const km = edgeDistanceKm(e);

    if (statGraph) {
      // D8/D15: no direction row, no SNR row — an aggregate edge makes no
      // direction claim. Endpoints use the `↔` key, not `→`.
      return (
        <div className="node-popup">
          <div className="node-popup-content">
            <div className="node-popup-grid">
              <div className="node-popup-item node-popup-item-full">
                <span className="node-popup-icon"><UiIcon name="link" /></span>
                <span className={styles.srOnly}>{t('messages.traceroute_edge_endpoints_label', 'Endpoints')}: </span>
                <span className="node-popup-value">
                  {t('messages.traceroute_stat_edge_endpoints', '{{from}} ↔ {{to}}', { from, to })}
                </span>
              </div>
              {km !== null && (
                <div className="node-popup-item node-popup-item-full">
                  <span className="node-popup-icon"><UiIcon name="ruler" /></span>
                  <span className={styles.srOnly}>{t('messages.traceroute_edge_distance_label', 'Distance')}: </span>
                  <span className="node-popup-value">{formatDistance(km, formatUnit, 1)}</span>
                </div>
              )}
              {renderSeenInRow((e as UnionStripEdge).count)}
            </div>
          </div>
        </div>
      );
    }

    const directionCaption = e.leg === 'forward' ? forwardLegCaption : returnLegCaption;
    const snrText = edgeSnrText(e);
    return (
      <div className="node-popup">
        <div className="node-popup-content">
          <div className="node-popup-grid">
            <div className="node-popup-item node-popup-item-full">
              <span className="node-popup-icon"><UiIcon name="route" /></span>
              <span className={styles.srOnly}>{t('messages.traceroute_edge_direction_label', 'Direction')}: </span>
              <span className="node-popup-value">{directionCaption}</span>
            </div>
            <div className="node-popup-item node-popup-item-full">
              <span className="node-popup-icon"><UiIcon name="link" /></span>
              <span className={styles.srOnly}>{t('messages.traceroute_edge_endpoints_label', 'Endpoints')}: </span>
              <span className="node-popup-value">
                {t('messages.traceroute_edge_endpoints', '{{from}} → {{to}}', { from, to })}
              </span>
            </div>
            {km !== null && (
              <div className="node-popup-item node-popup-item-full">
                <span className="node-popup-icon"><UiIcon name="ruler" /></span>
                <span className={styles.srOnly}>{t('messages.traceroute_edge_distance_label', 'Distance')}: </span>
                <span className="node-popup-value">{formatDistance(km, formatUnit, 1)}</span>
              </div>
            )}
            {snrText && (
              <div className="node-popup-item node-popup-item-full">
                <span className="node-popup-icon"><UiIcon name="radioSignal" /></span>
                <span className={styles.srOnly}>{t('messages.traceroute_edge_snr_label', 'Signal')}: </span>
                <span className="node-popup-value">{snrText}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      className={styles.scroller}
      role="group"
      aria-label={statGraph ? t('messages.traceroute_stat_strip_label', 'Statistical traceroute paths') : stripLabel}
    >
      <div className={styles.canvas} style={{ width: layout.width, height: layout.height }}>
        <svg className={styles.edges} width={layout.width} height={layout.height}>
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

          {/* Visible geometry — decorative; every fact it encodes is also
              carried by the node aria-labels, the SNR labels, and the
              per-edge hit targets below. */}
          <g aria-hidden="true">
            {graph.edges.map((e) => {
              const path = layout.edgePaths.get(e.id);
              if (!path) return null;
              const points = path.map((p) => `${p.x},${p.y}`).join(' ');
              const stat = statGraph ? (e as UnionStripEdge) : null;
              return (
                <polyline
                  key={e.id}
                  className={stat ? styles.statEdge : e.leg === 'forward' ? styles.forwardEdge : styles.returnEdge}
                  points={points}
                  // D8: no arrowhead in statistical mode — the edge makes no
                  // direction claim.
                  markerEnd={stat ? undefined : `url(#${arrowId})`}
                  style={stat ? statEdgeStyle(stat.opacity, stat.weight) : undefined}
                />
              );
            })}
          </g>

          {/* Interactive hit targets: an invisible, widened copy of each edge
              path, drawn last so it sits above the visible stroke. `.edges`
              keeps `pointer-events: none`; a descendant re-enabling its own
              `pointer-events` is hit-tested normally, so only these lines
              are (WP2). */}
          <g>
            {graph.edges.map((e) => {
              const path = layout.edgePaths.get(e.id);
              if (!path) return null;
              const tipId = `${uid}-tip-${e.id}`;
              return (
                <polyline
                  key={`hit-${e.id}`}
                  className={styles.edgeHit}
                  points={path.map((p) => `${p.x},${p.y}`).join(' ')}
                  role="img"
                  tabIndex={0}
                  aria-label={edgeSummary(e)}
                  aria-describedby={hover?.id === e.id ? tipId : undefined}
                  onMouseEnter={(ev) => showEdge(e, ev.currentTarget)}
                  onMouseLeave={scheduleHide}
                  onFocus={(ev) => showEdge(e, ev.currentTarget)}
                  onBlur={hideNow}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    toggleEdge(e, ev.currentTarget);
                  }}
                />
              );
            })}
          </g>
        </svg>

        {graph.edges.map((e) => {
          // D8: no SNR labels in statistical mode. Union edges already carry
          // `snr: null, snrUnknown: false`, so this is belt-and-braces — but
          // the rule is "branch on mode", not "trust the data".
          if (statGraph) return null;
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

          const statNode = statGraph ? (n as UnionStripNode) : null;
          const seenIn = statNode ? seenInText(statNode.count) : null;

          // Join only the present segments — a null roleLabel (very common:
          // an unlearned role, or the unknown-hop placeholder) must not leave
          // a dangling ", ," in the accessible name. Unknown statistical hops
          // are positional (D4): "Unrecorded hop", never a name and never the
          // shared !ffffffff placeholder id.
          const accessibleName = (
            statNode && isPlaceholder
              ? [unrecordedHopLabel, seenIn]
              : [displayName, roleLabel, nodeId, seenIn]
          )
            .filter((part): part is string => !!part)
            .join(t('messages.traceroute_node_label_separator', ', '));

          const tipId = `${uid}-tip-${n.id}`;

          // Keyboard reaches the action from the anchor, not by tabbing into
          // the portal (the popup is portalled to `document.body`, at the
          // very end of document order — see the module banner). `Enter`/
          // `Space` on a focused glyph fires the same callback the button
          // fires; `role="button"` is set only when that path is actually
          // available, so assistive tech doesn't advertise a no-op control.
          const userId = nodeMeta?.userId;
          const canOpenDetails = !!onOpenNodeDetails && !!userId;

          return (
            <div
              key={n.id}
              className={cx(styles.node, laneClassFor(n.lane), statNode && styles.statNode)}
              style={
                statNode
                  ? statStyle(statNode.opacity, { left: center.x, top: center.y })
                  : { left: center.x, top: center.y }
              }
              tabIndex={0}
              role={canOpenDetails ? 'button' : undefined}
              aria-describedby={hover?.id === n.id ? tipId : undefined}
              aria-label={accessibleName}
              onMouseEnter={(e) =>
                show(n.id, n.nodeNum, isPlaceholder, nodeId, e.currentTarget)
              }
              onMouseLeave={scheduleHide}
              onFocus={(e) => show(n.id, n.nodeNum, isPlaceholder, nodeId, e.currentTarget)}
              onBlur={hideNow}
              onKeyDown={
                canOpenDetails
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        hideNow();
                        onOpenNodeDetails!(userId!);
                      }
                    }
                  : undefined
              }
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
            className={cx(
              styles.hoverPopup,
              popupPos && styles.hoverPopupReady,
              hover.kind === 'edge' && styles.hoverPopupEdge,
            )}
            style={{ left: popupPos?.left ?? 0, top: popupPos?.top ?? 0 }}
            onMouseEnter={clearHideTimer}
            onMouseLeave={scheduleHide}
          >
            {hover.kind === 'node' ? hoverCard : renderEdgeTooltip(hover.edge)}
          </div>,
          document.body,
        )}
    </div>
  );
}

export default TracerouteStrip;
