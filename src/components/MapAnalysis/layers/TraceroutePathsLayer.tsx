import { Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useTraceroutes } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';

function snrToColor(snr: number): string {
  if (snr >= 5) return '#22c55e';
  if (snr >= 0) return '#eab308';
  if (snr >= -5) return '#f97316';
  return '#ef4444';
}

interface TracerouteRecord {
  id: number | string;
  fromNodeNum: number;
  toNodeNum: number;
  sourceId: string;
  route?: string | null;
  routeBack?: string | null;
  snrTowards?: string | null;
  snrBack?: string | null;
  timestamp?: number;
}

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
}

/**
 * Renders one Polyline per hop in each traceroute. Each segment is colored by
 * the per-hop SNR toward the destination. Clicking a segment writes the
 * selection into MapAnalysisContext for the inspector panel.
 */
export default function TraceroutePathsLayer() {
  const { config, setSelected } = useMapAnalysisCtx();
  const layer = config.layers.traceroutes;
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

  const ts = config.timeSlider;
  const inWindow = (t: number): boolean =>
    !ts.enabled ||
    ts.windowStartMs === undefined ||
    ts.windowEndMs === undefined ||
    (t >= ts.windowStartMs && t <= ts.windowEndMs);

  const segments = useMemo(() => {
    const out: Array<{
      key: string;
      positions: [number, number][];
      color: string;
      from: number;
      to: number;
    }> = [];
    const filtered = (items as TracerouteRecord[]).filter((tr) =>
      inWindow(tr.timestamp ?? 0),
    );
    for (const tr of filtered) {
      let route: number[] = [];
      try {
        route = JSON.parse(tr.route ?? '[]');
      } catch {
        /* ignore */
      }
      let snrTowards: number[] = [];
      try {
        snrTowards = JSON.parse(tr.snrTowards ?? '[]');
      } catch {
        /* ignore */
      }
      const path = [Number(tr.fromNodeNum), ...route, Number(tr.toNodeNum)];
      for (let i = 0; i < path.length - 1; i++) {
        const a = positionByKey.get(`${tr.sourceId}:${path[i]}`);
        const b = positionByKey.get(`${tr.sourceId}:${path[i + 1]}`);
        if (!a || !b) continue;
        const snr = snrTowards[i] ?? 0;
        out.push({
          key: `${tr.id}:${i}`,
          positions: [a, b],
          color: snrToColor(snr),
          from: path[i],
          to: path[i + 1],
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, positionByKey, ts.enabled, ts.windowStartMs, ts.windowEndMs]);

  return (
    <>
      {segments.map((s) => (
        <Polyline
          key={s.key}
          positions={s.positions}
          pathOptions={{ color: s.color, weight: 2 }}
          eventHandlers={{
            click: () =>
              setSelected({
                type: 'segment',
                fromNodeNum: s.from,
                toNodeNum: s.to,
              }),
          }}
        />
      ))}
    </>
  );
}
