import { Marker, Popup } from 'react-leaflet';
import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useHopCounts } from '../../../hooks/useMapAnalysisData';
import { useSettings } from '../../../contexts/SettingsContext';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';
import { createNodeIcon } from '../../../utils/mapIcons';

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
  longName?: string | null;
  shortName?: string | null;
  user?: { role?: string | number | null } | null;
}

interface HopEntry {
  sourceId: string;
  nodeNum: number;
  hops: number;
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
  const { config, selected, setSelected } = useMapAnalysisCtx();
  const { mapPinStyle } = useSettings();
  const { data: sources = [] } = useDashboardSources();
  const sourceList = sources as Array<{ id: string; name: string }>;
  const sourceIds = sourceList.map((s) => s.id);
  const sourceNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sourceList) m.set(s.id, s.name);
    return m;
  }, [sourceList]);
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
        const hopVal = hopByKey.get(`${sourceId}:${Number(n.nodeNum)}`);
        const hops =
          config.layers.hopShading.enabled && hopVal !== undefined ? hopVal : 999;
        const isSelected =
          selected?.type === 'node' &&
          selected.nodeNum === Number(n.nodeNum) &&
          (selected.sourceId ?? '') === sourceId;
        const roleNum =
          typeof n.user?.role === 'string'
            ? parseInt(n.user.role, 10)
            : typeof n.user?.role === 'number'
              ? n.user.role
              : 0;
        const isRouter = roleNum === 2;
        const icon = createNodeIcon({
          hops,
          isSelected,
          isRouter,
          shortName: n.shortName ?? undefined,
          showLabel: true,
          pinStyle: mapPinStyle,
        });
        return (
          <Marker
            key={`${sourceId}:${n.nodeNum}`}
            position={[lat, lon]}
            icon={icon}
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
              <div>Source: {sourceNameById.get(sourceId) ?? sourceId ?? '(unknown)'}</div>
              {hopVal !== undefined && <div>Hops: {hopVal}</div>}
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}
