import { Marker, Popup } from 'react-leaflet';
import { useMemo } from 'react';
import L from 'leaflet';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useHopCounts } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
  longName?: string | null;
  shortName?: string | null;
}

interface HopEntry {
  sourceId: string;
  nodeNum: number;
  hops: number;
}

function hopColor(hops: number | undefined): string {
  if (hops === undefined) return '#6b7280';
  if (hops === 0) return '#22c55e';
  if (hops === 1) return '#84cc16';
  if (hops === 2) return '#eab308';
  if (hops === 3) return '#f97316';
  return '#ef4444';
}

/**
 * Renders one Marker per node that has a position. When `config.sources` is
 * non-empty, only nodes whose sourceId is in the allow-list are shown; an
 * empty list means "all sources" (Unified semantics).
 *
 * When `config.layers.hopShading.enabled` is true, markers are rendered as a
 * colored divIcon tinted by the node's hop count from `/api/analysis/hopCounts`.
 *
 * Clicking a marker writes the selection into MapAnalysisContext so the
 * inspector panel can react.
 */
export default function NodeMarkersLayer() {
  const { config, setSelected } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();
  const sourceIds = (sources as { id: string }[]).map((s) => s.id);
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);
  const hop = useHopCounts({
    enabled: config.layers.hopShading.enabled,
    sources: config.sources.length === 0 ? sourceIds : config.sources,
  });

  const hopByKey = useMemo(() => {
    const m = new Map<string, number>();
    const entries = (hop.data as { entries?: HopEntry[] } | undefined)?.entries ?? [];
    for (const e of entries) {
      m.set(`${e.sourceId}:${Number(e.nodeNum)}`, e.hops);
    }
    return m;
  }, [hop.data]);

  const filteredNodes = ((nodes ?? []) as NodeRecord[])
    .map((n) => ({ node: n, latLng: resolveNodeLatLng(n) }))
    .filter(({ node, latLng }) => {
      if (!latLng) return false;
      if (config.sources.length === 0) return true;
      if (!node.sourceId) return false;
      return config.sources.includes(node.sourceId);
    });

  return (
    <>
      {filteredNodes.map(({ node: n, latLng }) => {
        const [lat, lon] = latLng!;
        const sourceId = n.sourceId ?? '';
        const hops = hopByKey.get(`${sourceId}:${Number(n.nodeNum)}`);
        const tinted = config.layers.hopShading.enabled;
        const color = tinted ? hopColor(hops) : '#6698f5';
        const icon =
          tinted && typeof (L as { divIcon?: unknown }).divIcon === 'function'
            ? (L as unknown as {
                divIcon: (opts: {
                  className: string;
                  html: string;
                  iconSize: [number, number];
                  iconAnchor: [number, number];
                }) => L.DivIcon;
              }).divIcon({
                className: 'map-analysis-node-marker',
                html: `<div style="background:${color};width:14px;height:14px;border-radius:50%;border:2px solid #fff;"></div>`,
                iconSize: [18, 18],
                iconAnchor: [9, 9],
              })
            : undefined;
        return (
          <Marker
            key={`${sourceId}:${n.nodeNum}`}
            position={[lat, lon]}
            {...(icon ? { icon } : {})}
            eventHandlers={{
              click: () =>
                setSelected({
                  type: 'node',
                  nodeNum: Number(n.nodeNum),
                  sourceId,
                }),
            }}
          >
            <Popup>
              <strong>
                {n.longName ?? n.shortName ?? `!${Number(n.nodeNum).toString(16)}`}
              </strong>
              <div>Source: {sourceId || '(unknown)'}</div>
              {hops !== undefined && <div>Hops: {hops}</div>}
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}
