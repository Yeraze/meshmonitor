import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useTraceroutes } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { getTracerouteOptions } from '../../../hooks/useMapAnalysisConfig';
import {
  useTracerouteAnalysis,
  type AnalyzedSegment,
  type TracerouteAnalysisInput,
} from '../../../hooks/useTracerouteAnalysis';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';
import { visibleNodeNumSet, type SearchableNode } from '../nodeSearch';
import { weightByOccurrence, getSegmentSnrOpacity } from '../../../utils/mapHelpers';
import type { TracerouteRenderSegment } from '../../../utils/tracerouteSegments';
import { TraceroutePathsLayer as SharedTraceroutePathsLayer } from '../../map/layers/TraceroutePathsLayer';
import { useSettings } from '../../../contexts/SettingsContext';

// Direction colours (issue #3399): outbound = the selected node transmitting,
// inbound = the selected node receiving. These are Analysis-specific-by-design
// (not part of the canonical theme palette) — kept as the same hardcoded
// VALUES as before, now threaded through the shared layer's `directionColors`
// prop instead of a local `segmentColor`/`snrQualityColor` implementation.
const OUTBOUND_COLOR = '#3b82f6'; // blue
const INBOUND_COLOR = '#f43f5e'; // rose

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
  longName?: string | null;
  shortName?: string | null;
  nodeId?: string | null;
}

/**
 * Maps one {@link AnalyzedSegment} to a {@link TracerouteRenderSegment} for
 * the shared render layer. `leg` is 'neutral' for the unfocused (SNR-colored)
 * view and 'forward' for the focused (direction-colored) view — this
 * reproduces the pre-migration curvature exactly: unfocused segments always
 * used the flat 0.12 neutral curvature, while focused in/outbound segments
 * always used a positive (never leg-signed/negative) 0.2 curvature. Using
 * 'forward' (not 'return') for focused segments avoids the shared layer's
 * leg-signed negation, which the old renderer never applied here.
 */
function toRenderSegment(s: AnalyzedSegment): TracerouteRenderSegment {
  return {
    key: s.key,
    from: s.fromPos,
    to: s.toPos,
    leg: s.direction === 'neutral' ? 'neutral' : 'forward',
    direction: s.direction,
    avgSnr: s.avgSnr,
    isMqtt: s.isMqtt,
    occurrences: s.occurrences,
  };
}

/**
 * Renders deduplicated traceroute links via {@link useTracerouteAnalysis}. When
 * a node is selected, links are scoped to that node and coloured by direction
 * (outbound vs inbound) with arrows; otherwise links are coloured by SNR. Weak
 * links are removed per the persisted min-occurrences / min-SNR options.
 *
 * Thin adapter (#4047 P3 WP5): owns MapAnalysis-specific data wiring
 * (`useTracerouteAnalysis`) and maps its output onto the shared
 * `src/components/map/layers/TraceroutePathsLayer` for rendering. Geometry,
 * color-mode resolution, weight/opacity/dash strategies, and arrows all live
 * in the shared layer now — this file stays free of hardcoded SNR hex.
 */
export default function TraceroutePathsLayer() {
  const { config, selected, nodeFilter, setSelected } = useMapAnalysisCtx();
  const { overlayColors } = useSettings();
  const layer = config.layers.traceroutes;
  const options = useMemo(
    () => getTracerouteOptions(config),
    // Only the traceroute options object affects the result; re-deriving on every
    // unrelated config change would needlessly recompute the analysis.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.layers.traceroutes.options],
  );
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;
  const { items } = useTraceroutes({
    enabled: layer.enabled,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
  });
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);

  const positionByKey = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      const ll = resolveNodeLatLng(n);
      if (ll) map.set(`${n.sourceId ?? ''}:${Number(n.nodeNum)}`, ll);
    }
    return map;
  }, [nodes]);

  const visibleNodeNums = useMemo(
    () => visibleNodeNumSet((nodes ?? []) as SearchableNode[], nodeFilter),
    [nodes, nodeFilter],
  );

  const ts = config.timeSlider;
  const timeWindow = useMemo(
    () =>
      ts.enabled && ts.windowStartMs !== undefined && ts.windowEndMs !== undefined
        ? { startMs: ts.windowStartMs, endMs: ts.windowEndMs }
        : null,
    [ts.enabled, ts.windowStartMs, ts.windowEndMs],
  );

  const selectedNodeNum =
    selected?.type === 'node' && selected.nodeNum !== undefined ? selected.nodeNum : null;
  const selectedSourceId =
    selected?.type === 'node' ? selected.sourceId ?? null : null;

  const { segments } = useTracerouteAnalysis({
    traceroutes: items as TracerouteAnalysisInput[],
    positionByKey,
    selectedNodeNum,
    selectedSourceId,
    options,
    visibleNodeNums,
    timeWindow,
  });

  // Arrows are only drawn in the directional (node-selected) view to keep the
  // global view light.
  const showArrows = selectedNodeNum !== null;
  // colorMode is dynamic: focused segments carry inbound/outbound direction
  // (colored by directionColors); unfocused segments are all 'neutral' and
  // colored by SNR instead (see useTracerouteAnalysis's `focus` gating).
  const colorMode = showArrows ? 'direction' : 'snr';

  const renderSegments = useMemo(() => segments.map(toRenderSegment), [segments]);
  const analyzedByKey = useMemo(
    () => new Map(segments.map((s) => [s.key, s])),
    [segments],
  );

  return (
    <SharedTraceroutePathsLayer
      segments={renderSegments}
      snrColors={overlayColors.snrColors}
      colorMode={colorMode}
      directionColors={{
        outbound: OUTBOUND_COLOR,
        inbound: INBOUND_COLOR,
        // Unreachable in practice: focused segments are always in/outbound
        // (never 'neutral') and unfocused segments use colorMode 'snr', which
        // ignores directionColors entirely.
        neutral: overlayColors.snrColors.noData,
      }}
      neutralCurvature={0.12}
      curvature={0.2}
      weight={(seg) => weightByOccurrence(seg.occurrences ?? 1)}
      opacity={(seg) =>
        getSegmentSnrOpacity(seg.avgSnr === null ? undefined : [{ snr: seg.avgSnr }], seg.isMqtt)
      }
      showArrows={showArrows}
      onSegmentClick={(seg) => {
        const s = analyzedByKey.get(seg.key);
        if (!s) return;
        setSelected({
          type: 'segment',
          fromNodeNum: s.from,
          toNodeNum: s.to,
          direction: s.direction,
          occurrences: s.occurrences,
          avgSnr: s.avgSnr,
        });
      }}
    />
  );
}
