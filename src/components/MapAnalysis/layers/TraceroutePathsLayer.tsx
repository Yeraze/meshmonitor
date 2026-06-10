import { Polyline } from 'react-leaflet';
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
import {
  generateCurvedPath,
  generateCurvedArrowMarkers,
  getSegmentSnrOpacity,
  UNKNOWN_SNR_SENTINEL,
} from '../../../utils/mapHelpers';

// Direction colours (issue #3399): outbound = the selected node transmitting,
// inbound = the selected node receiving.
const OUTBOUND_COLOR = '#3b82f6'; // blue
const INBOUND_COLOR = '#f43f5e'; // rose

/** SNR → quality colour for the global (no node selected) view. */
function snrQualityColor(avgSnr: number | null): string {
  if (avgSnr === null) return '#94a3b8'; // slate — unknown SNR
  if (avgSnr >= 5) return '#22c55e';
  if (avgSnr >= 0) return '#eab308';
  if (avgSnr >= -5) return '#f97316';
  return '#ef4444';
}

function segmentColor(s: AnalyzedSegment): string {
  if (s.direction === 'outbound') return OUTBOUND_COLOR;
  if (s.direction === 'inbound') return INBOUND_COLOR;
  return snrQualityColor(s.avgSnr);
}

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
  longName?: string | null;
  shortName?: string | null;
  nodeId?: string | null;
}

/**
 * Renders deduplicated traceroute links via {@link useTracerouteAnalysis}. When
 * a node is selected, links are scoped to that node and coloured by direction
 * (outbound vs inbound) with arrows; otherwise links are coloured by SNR. Weak
 * links are removed per the persisted min-occurrences / min-SNR options.
 */
export default function TraceroutePathsLayer() {
  const { config, selected, nodeFilter, setSelected } = useMapAnalysisCtx();
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

  return (
    <>
      {segments.map((s) => {
        const color = segmentColor(s);
        const curvature = s.direction === 'neutral' ? 0.12 : 0.2;
        const path = generateCurvedPath(s.fromPos, s.toPos, curvature, 20, true);
        const weight = 2 + Math.min(s.occurrences - 1, 5) * 0.8;
        const opacity = getSegmentSnrOpacity(
          s.avgSnr === null ? undefined : [{ snr: s.avgSnr }],
          s.isMqtt,
        );
        return (
          <Polyline
            key={s.key}
            positions={path}
            pathOptions={{
              color,
              weight,
              opacity,
              dashArray: s.isMqtt ? '4,6' : undefined,
            }}
            eventHandlers={{
              click: () =>
                setSelected({
                  type: 'segment',
                  fromNodeNum: s.from,
                  toNodeNum: s.to,
                  direction: s.direction,
                  occurrences: s.occurrences,
                  avgSnr: s.avgSnr,
                }),
            }}
          />
        );
      })}
      {showArrows &&
        segments.flatMap((s) =>
          generateCurvedArrowMarkers(
            [s.fromPos, s.toPos],
            s.key,
            segmentColor(s),
            [s.avgSnr === null ? UNKNOWN_SNR_SENTINEL : s.avgSnr],
            s.direction === 'neutral' ? 0.12 : 0.2,
            true,
          ),
        )}
    </>
  );
}
