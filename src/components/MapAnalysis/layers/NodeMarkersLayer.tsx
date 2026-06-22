import { Marker, Popup } from 'react-leaflet';
import { useMemo, useRef } from 'react';
import type { Marker as LeafletMarker } from 'leaflet';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useHopCounts } from '../../../hooks/useMapAnalysisData';
import { useSettings } from '../../../contexts/SettingsContext';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { useMarkerSpiderfier, SHARED_SPIDERFIER_OPTIONS } from '../../../hooks/useMarkerSpiderfier';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';
import { nodeMatchesSearch } from '../nodeSearch';
import { createNodeIcon } from '../../../utils/mapIcons';
import { getNodeTypeCategory } from '../../../utils/nodeTypeCategory';

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
  nodeId?: string | null;
  longName?: string | null;
  shortName?: string | null;
  hideFromMap?: boolean | null;
  user?: { role?: string | number | null } | null;
  isMeshCore?: boolean;
  advType?: number | null;
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
  const { config, selected, setSelected, nodeFilter } = useMapAnalysisCtx();
  const { mapPinStyle } = useSettings();

  // Spiderfier fans out markers that share (rounded) coordinates so each node in
  // a cluster is individually selectable (issues #3399, #3612). Same bridge
  // pattern as NodesTab: stable per-key ref handlers feed the imperative Leaflet
  // markers in. Uses the SHARED tuning (50px nearbyDistance etc.) so every map
  // surface fans out identically — the prior default 20px radius missed
  // near-but-not-identical co-located nodes.
  const { addMarker, removeMarker } = useMarkerSpiderfier(SHARED_SPIDERFIER_OPTIONS);
  const markerByKey = useRef<Map<string, LeafletMarker>>(new Map());
  const refHandlers = useRef<Map<string, (m: LeafletMarker | null) => void>>(new Map());
  const getMarkerRef = (key: string) => {
    let h = refHandlers.current.get(key);
    if (!h) {
      h = (m: LeafletMarker | null) => {
        const prev = markerByKey.current.get(key);
        if (m) {
          markerByKey.current.set(key, m);
          addMarker(m, key);
        } else {
          if (prev) removeMarker(prev);
          markerByKey.current.delete(key);
          refHandlers.current.delete(key);
        }
      };
      refHandlers.current.set(key, h);
    }
    return h;
  };

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
      // #3549: per-node "Hide from Map" suppresses the marker on every map surface.
      if (node.hideFromMap) return false;
      // Node search (issue #3399): hide non-matches.
      if (!nodeMatchesSearch(node, nodeFilter)) return false;
      // Node-type filter (issue #3546): hide categories the user toggled off.
      if (config.nodeTypes[getNodeTypeCategory(node)] === false) return false;
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
        const roleCategory = getNodeTypeCategory(n);
        const icon = createNodeIcon({
          hops,
          isSelected,
          isRouter,
          roleCategory,
          shortName: n.shortName ?? undefined,
          showLabel: true,
          pinStyle: mapPinStyle,
        });
        const markerKey = `${sourceId}:${n.nodeNum}`;
        return (
          <Marker
            key={markerKey}
            ref={getMarkerRef(markerKey)}
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
