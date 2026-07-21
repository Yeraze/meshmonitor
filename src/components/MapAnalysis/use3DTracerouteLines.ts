import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../hooks/useDashboardData';
import { useTraceroutes } from '../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx, type SelectedTarget } from './MapAnalysisContext';
import { getTracerouteOptions } from '../../hooks/useMapAnalysisConfig';
import {
  useTracerouteAnalysis,
  type AnalyzedSegment,
  type TracerouteAnalysisInput,
} from '../../hooks/useTracerouteAnalysis';
import { resolveNodeLatLng, type MaybePositionedNode } from './nodePositionUtil';
import { visibleNodeNumSet, type SearchableNode } from './nodeSearch';
import { weightByOccurrence, getSegmentSnrOpacity, snrToColor } from '../../utils/mapHelpers';
import { useSettings } from '../../contexts/SettingsContext';
import type { Line3DFeature } from '../map/Base3DMap';

/**
 * 3D traceroute-segment data hook (#3826 Phase 3 WP-2, spec §3.3).
 *
 * Mirrors `layers/TraceroutePathsLayer.tsx`'s data wiring (`useTraceroutes`,
 * `positionByKey`/`visibleNodeNums`/`options`/`timeWindow`, then
 * `useTracerouteAnalysis`) and the shared `map/layers/TraceroutePathsLayer.tsx`
 * `resolveColor`/`resolveOpacity`/`resolveWeight`/`resolveDash` formulas
 * (both off-limits to edit, spec §0) so 2D and 3D render pixel-equivalent
 * color/opacity/width and agree on which segments exist. Per spec §2.6, 3D
 * renders straight 2-vertex lines — no bezier curvature, no direction arrows.
 * `selectionByKey` is locked to the 2D adapter's literal `onSegmentClick`
 * payload shape by a parity test (`use3DTracerouteLines.test.ts`).
 */

// mirror of layers/TraceroutePathsLayer.tsx L25-26 (OUTBOUND_COLOR/INBOUND_COLOR)
const OUTBOUND_COLOR = '#3b82f6';
const INBOUND_COLOR = '#f43f5e';

// Per spec §2.6: dashed = MQTT/unknown-SNR segment; solid otherwise.
const MQTT_UNKNOWN_DASH = [2, 2];

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
  hideFromMap?: boolean | null;
}

export interface TracerouteLines3D {
  lines: Line3DFeature[];
  selectionByKey: Map<string, SelectedTarget>;
}

/**
 * Resolve a segment's line color, replicating
 * `map/layers/TraceroutePathsLayer.tsx`'s `resolveColor` for the two prop
 * shapes the MapAnalysis 2D adapter actually passes: `colorMode: 'snr'` with
 * `mqttColor: overlayColors.mqttSegment`, or `colorMode: 'direction'` with
 * `directionColors: { outbound: OUTBOUND_COLOR, inbound: INBOUND_COLOR }`
 * (no `neutral` override, so a 'neutral' segment in direction mode falls back
 * to `snrColors.noData` — same as 2D).
 */
function resolveSegmentColor(
  seg: AnalyzedSegment,
  colorMode: 'snr' | 'direction',
  snrColors: Parameters<typeof snrToColor>[1],
  mqttColor: string,
): string {
  if (colorMode === 'direction') {
    if (seg.direction === 'outbound') return OUTBOUND_COLOR;
    if (seg.direction === 'inbound') return INBOUND_COLOR;
    return snrColors.noData;
  }
  if (seg.isMqtt) return mqttColor;
  return snrToColor(seg.avgSnr, snrColors);
}

export function use3DTracerouteLines(): TracerouteLines3D {
  const { config, selected, nodeFilter } = useMapAnalysisCtx();
  const { overlayColors } = useSettings();
  const layer = config.layers.traceroutes;
  const options = useMemo(
    () => getTracerouteOptions(config),
    // Only the traceroute options object affects the result — mirrors
    // layers/TraceroutePathsLayer.tsx L76-82.
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
      if (n.hideFromMap) continue;
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
  const selectedSourceId = selected?.type === 'node' ? selected.sourceId ?? null : null;

  const { segments } = useTracerouteAnalysis({
    traceroutes: items as TracerouteAnalysisInput[],
    positionByKey,
    selectedNodeNum,
    selectedSourceId,
    options,
    visibleNodeNums,
    timeWindow,
  });

  // colorMode is dynamic, same as 2D: direction when a node is selected, SNR
  // otherwise (layers/TraceroutePathsLayer.tsx L140-144).
  const colorMode: 'snr' | 'direction' = selectedNodeNum !== null ? 'direction' : 'snr';

  return useMemo(() => {
    if (!layer.enabled) return { lines: [], selectionByKey: new Map<string, SelectedTarget>() };

    const lines: Line3DFeature[] = [];
    const selectionByKey = new Map<string, SelectedTarget>();

    for (const seg of segments) {
      const color = resolveSegmentColor(seg, colorMode, overlayColors.snrColors, overlayColors.mqttSegment);
      const opacity = getSegmentSnrOpacity(
        seg.avgSnr === null ? undefined : [{ snr: seg.avgSnr }],
        seg.isMqtt,
      );
      const width = weightByOccurrence(seg.occurrences ?? 1);
      const isDashed = seg.isMqtt || seg.avgSnr == null;

      const key = `tr:${seg.key}`;
      lines.push({
        key,
        // §2.6: straight 2-vertex LineString — no generateCurvedPath, no arrows.
        from: seg.fromPos,
        to: seg.toPos,
        color,
        opacity,
        width,
        ...(isDashed ? { dash: MQTT_UNKNOWN_DASH } : {}),
      });
      // PARITY: literal shape of the `onSegmentClick` -> `setSelected(...)`
      // call in layers/TraceroutePathsLayer.tsx L165-174 (via the
      // `toRenderSegment` mapping: `seg.fromNodeNum`/`toNodeNum` == this
      // AnalyzedSegment's `from`/`to`).
      selectionByKey.set(key, {
        type: 'segment',
        fromNodeNum: seg.from,
        toNodeNum: seg.to,
        direction: seg.direction,
        occurrences: seg.occurrences,
        avgSnr: seg.avgSnr,
      });
    }

    return { lines, selectionByKey };
  }, [segments, colorMode, overlayColors.snrColors, overlayColors.mqttSegment, layer.enabled]);
}
