import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Popup, Tooltip, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings, useDisplaySettings } from '../../contexts/SettingsContext';
import {
  getNodeTypeCategory,
  nodePassesTypeFilter,
  MESHCORE_CATEGORIES,
  NODE_TYPE_CATEGORY_META,
  type NodeTypeCategory,
} from '../../utils/nodeTypeCategory';
import { createNodeIcon } from '../map/markerIcons';
import { BaseMap } from '../map/BaseMap';
import { MapLoadingOverlay } from '../map/MapLoadingOverlay';
import { NodeMarkersLayer, type NodeMarkerDescriptor } from '../map/layers/NodeMarkersLayer';
import { NeighborLinksLayer, type NeighborLinkDescriptor } from '../map/layers/NeighborLinksLayer';
import PolarGridOverlay from '../PolarGridOverlay';
import { useSource } from '../../contexts/SourceContext';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { shouldDiscardPosition } from '../../utils/nullIsland';
import { getDiscardInvalidPositions } from '../../utils/positionDisplayConfig';
import { getPositionHistoryColor } from '../../utils/mapHelpers';
import api from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import GeoJsonOverlay from '../GeoJsonOverlay';
import type { GeoJsonLayer } from '../../server/services/geojsonService.js';
import MapLegend from '../MapLegend';
import MeasureDistanceController from '../MeasureDistanceController';
import type { MeasurePoint } from '../../utils/measureDistance';
import { NodeCard } from '../map/popups/NodeCard';
import { toNodeCardModel } from '../map/popups/nodeCardModel';
import { MeshCoreDetails, LastHeardFooter, NodeActions, type NodeActionSpec } from '../map/popups/sections';

const MESHCORE_COLOR = '#cba6f7';
const NEIGHBOR_COLOR = '#06b6d4';
const DEFAULT_CENTER: [number, number] = [0, 0];
const DEFAULT_ZOOM = 2;

const PATH_COLORS: Record<string, string> = {
  direct: '#a6e3a1',
  short: '#89b4fa',
  long: '#fab387',
  unknown: '#6c7086',
};

function hopCountColor(hops: number | null | undefined): string {
  if (hops === null || hops === undefined) return PATH_COLORS.unknown;
  if (hops === 0) return PATH_COLORS.direct;
  if (hops <= 2) return PATH_COLORS.short;
  return PATH_COLORS.long;
}

function hopCountLabel(hops: number | null | undefined): string {
  if (hops === null || hops === undefined) return 'Unknown';
  if (hops === 0) return 'Direct';
  return `${hops} hop${hops > 1 ? 's' : ''}`;
}

interface NeighborEdge {
  publicKey: string;
  neighborPublicKey: string;
  nodeName: string | null;
  neighborName: string | null;
  snr: number | null;
}

interface MeshCoreMapProps {
  contacts: MeshCoreContact[];
  selectedPublicKey: string | null;
  localNodePosition?: { lat: number; lng: number } | null;
  onNavigateToDm?: (publicKey: string) => void;
  /**
   * True while the FIRST contacts snapshot fetch is still in flight (see
   * `useMeshCore`'s `hasLoadedOnce`). Shows a loading overlay so a slow
   * initial connect doesn't render an apparently-empty world map before
   * contacts have a chance to arrive. Defaults to false so existing
   * callers/tests are unaffected.
   */
  isLoading?: boolean;
  /**
   * Forwarded to `BaseMap`'s `resizeTrigger` (issue: mobile node-list
   * collapse toggle). When this value changes, the underlying Leaflet map
   * calls `invalidateSize()` so the canvas fills its new container size
   * after the list pane collapses/expands or the mobile list↔map pane swap
   * fires — otherwise the map can render at its stale size (grey/blank
   * edges) until the next manual resize. Omit ⇒ no resize handler mounted
   * (matches BaseMap's own opt-in default).
   */
  resizeTrigger?: unknown;
}

export const MeshCoreMap: React.FC<MeshCoreMapProps> = ({ contacts, selectedPublicKey, localNodePosition, onNavigateToDm, isLoading = false, resizeTrigger }) => {
  const { t } = useTranslation();
  const { mapTileset, customTilesets, setMapTileset } = useSettings();
  const { timeFormat, dateFormat } = useDisplaySettings();
  const { sourceId } = useSource();
  const csrfFetch = useCsrfFetch();
  const [showPaths, setShowPaths] = useState(true);
  const [showNeighbors, setShowNeighbors] = useState(true);
  // #3636: node-to-node LOS distance measurement tool.
  const [measureActive, setMeasureActive] = useState(false);
  const [neighborEdges, setNeighborEdges] = useState<NeighborEdge[]>([]);

  // Per-node-type visibility filter (issue #3546), persisted like the other map
  // toggles. Missing/true => visible; a category is hidden only when explicitly
  // set false. Mirrors the Map Analysis workspace so behavior matches there.
  const [nodeTypeFilter, setNodeTypeFilter] = useState<Partial<Record<NodeTypeCategory, boolean>>>(() => {
    try {
      const raw = localStorage.getItem('meshmonitor-meshcore-nodeTypeFilter');
      return raw ? (JSON.parse(raw) as Partial<Record<NodeTypeCategory, boolean>>) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem('meshmonitor-meshcore-nodeTypeFilter', JSON.stringify(nodeTypeFilter));
  }, [nodeTypeFilter]);
  const setNodeTypeEnabled = (category: NodeTypeCategory, enabled: boolean) =>
    setNodeTypeFilter((prev) => ({ ...prev, [category]: enabled }));

  // Tile selector + legend overlays — hidden by default, toggled from the Map
  // Features panel. Persisted under the same localStorage keys the other maps
  // use so the preference is unified across every map surface.
  const [showTileSelector, setShowTileSelector] = useState(
    () => localStorage.getItem('meshmonitor-showTileSelector') === 'true',
  );
  const [showLegend, setShowLegend] = useState(
    () => localStorage.getItem('meshmonitor-showLegend') === 'true',
  );
  useEffect(() => {
    localStorage.setItem('meshmonitor-showTileSelector', String(showTileSelector));
  }, [showTileSelector]);
  useEffect(() => {
    localStorage.setItem('meshmonitor-showLegend', String(showLegend));
  }, [showLegend]);

  // Position-history trail overlay (#3852) — the MeshCore analogue of the
  // Meshtastic node-motion trail. Toggle + window length are per-browser
  // (localStorage), matching the other MeshCore map toggles. The window length
  // is clamped to the backend's rolling retention (7 days); points older than
  // that are swept server-side and simply won't be returned.
  const [showPositionHistory, setShowPositionHistory] = useState(
    () => localStorage.getItem('meshmonitor-meshcore-showPositionHistory') === 'true',
  );
  const [positionHistoryHours, setPositionHistoryHours] = useState<number>(() => {
    const raw = localStorage.getItem('meshmonitor-meshcore-positionHistoryHours');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(n, 168) : 24;
  });
  useEffect(() => {
    localStorage.setItem('meshmonitor-meshcore-showPositionHistory', String(showPositionHistory));
  }, [showPositionHistory]);
  useEffect(() => {
    localStorage.setItem('meshmonitor-meshcore-positionHistoryHours', String(positionHistoryHours));
  }, [positionHistoryHours]);
  // publicKey -> ordered (oldest→newest) [lat, lng] trail points.
  const [positionHistory, setPositionHistory] = useState<Map<string, [number, number][]>>(new Map());

  // Polar grid overlay (#4047 follow-up) — the same shared range-ring/azimuth-
  // sector grid NodesTab/DashboardMap/Map Analysis draw, centered on the LOCAL
  // MeshCore node's position. Persisted per-browser like the other MeshCore
  // map toggles above (MeshCoreMap doesn't sit inside a `MapProvider`, so it
  // can't reuse MapContext's server-persisted `showPolarGrid`).
  const [showPolarGrid, setShowPolarGrid] = useState(
    () => localStorage.getItem('meshmonitor-meshcore-showPolarGrid') === 'true',
  );
  useEffect(() => {
    localStorage.setItem('meshmonitor-meshcore-showPolarGrid', String(showPolarGrid));
  }, [showPolarGrid]);

  // Server-side rolling retention window (days) for stored trail points. This
  // is a global setting (`meshcore_position_history_retention_days`, default 7)
  // — points older than this are swept server-side. Loaded once; saved via the
  // shared /api/settings endpoint (requires settings:write, like the packet
  // monitor's max-age control).
  const [retentionDays, setRetentionDays] = useState(7);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.get<Record<string, string>>('/api/settings');
        const raw = settings?.meshcore_position_history_retention_days;
        const n = raw ? parseInt(raw, 10) : NaN;
        if (!cancelled && Number.isFinite(n) && n > 0) setRetentionDays(n);
      } catch {
        // best-effort: fall back to the default display value
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const saveRetentionDays = (days: number) => {
    const clamped = Math.max(1, Math.min(365, Math.round(days)));
    setRetentionDays(clamped);
    api.getBaseUrl().then(baseUrl => {
      csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meshcore_position_history_retention_days: String(clamped) }),
      }).catch(err => console.error('Failed to save position-history retention:', err));
    }).catch(err => console.error('Failed to get base URL:', err));
  };

  // GeoJSON overlay layers (global, file-based) — fetched and toggled here so
  // the MeshCore map matches the NodesTab and Dashboard maps. Layer visibility
  // is global and shared with those maps' controls.
  const [geoJsonLayers, setGeoJsonLayers] = useState<GeoJsonLayer[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<GeoJsonLayer[]>('/api/geojson/layers');
        if (!cancelled) setGeoJsonLayers(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error('Failed to fetch GeoJSON layers:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleGeoJsonLayer = (id: string, visible: boolean) => {
    setGeoJsonLayers(prev => prev.map(l => (l.id === id ? { ...l, visible } : l)));
    api.getBaseUrl().then(baseUrl => {
      csrfFetch(`${baseUrl}/api/geojson/layers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible }),
      }).catch(err => console.error('Failed to update layer visibility:', err));
    }).catch(err => console.error('Failed to get base URL:', err));
  };

  const positioned = useMemo(
    () => contacts.filter(c =>
      typeof c.latitude === 'number' && isFinite(c.latitude)
      && typeof c.longitude === 'number' && isFinite(c.longitude)
      // Skip bogus positions: "Null Island" (0,0) GPS defaults (issue #3763)
      // AND out-of-range junk MeshCore adverts carry (e.g. lat 1853, lng -1598)
      // that would blow the map's fit-bounds out to nothing. The DB store
      // filters these too, but live in-memory contacts reaching the map via
      // getAllNodes() can still carry them.
      && !shouldDiscardPosition(c.latitude, c.longitude, undefined, getDiscardInvalidPositions())),
    [contacts],
  );

  // Markers visible after the node-type filter. Paths/neighbor lines keep using
  // `positioned` so the filter only hides markers — matching the Map Analysis
  // workspace, where the type filter never removes route/neighbor overlays.
  const visibleContacts = useMemo(
    () => positioned.filter(c => nodePassesTypeFilter({ advType: c.advType }, nodeTypeFilter)),
    [positioned, nodeTypeFilter],
  );

  // #3636: measurement endpoints — nearest-node snapping picks from these.
  const measurePoints: MeasurePoint[] = useMemo(
    () => visibleContacts.map(c => ({
      id: c.publicKey,
      lat: c.latitude as number,
      lng: c.longitude as number,
      label: c.advName || c.name,
    })),
    [visibleContacts],
  );

  // Node-marker descriptors for the shared `NodeMarkersLayer` (#4047 Phase 4,
  // WP4). `iconSig`/`buildIcon` mirror the pre-migration `stableIcon(publicKey,
  // \`${name}|${category}\`, () => makeIcon(name, category))` recipe exactly —
  // `variant:'meshcore'` is the moved `makeIcon` body verbatim, so output is
  // pixel-identical. Popup/Tooltip content (Phase 5, unchanged) stays here as
  // `children`.
  const markers: NodeMarkerDescriptor[] = useMemo(
    () => visibleContacts.map(c => {
      const name = c.advName || c.name || 'MeshCore';
      const category = getNodeTypeCategory({ advType: c.advType });
      const model = toNodeCardModel(c, 'meshcore');
      const actions: NodeActionSpec[] = onNavigateToDm
        ? [{ kind: 'navigate-to-dm', onClick: () => onNavigateToDm(c.publicKey) }]
        : [];
      return {
        key: c.publicKey,
        position: [c.latitude!, c.longitude!] as [number, number],
        iconSig: `${name}|${category}`,
        buildIcon: () =>
          createNodeIcon({
            variant: 'meshcore',
            fixedColor: MESHCORE_COLOR,
            roleCategory: category,
            labelName: name,
          }),
        children: (
          <>
            <Tooltip>
              <strong>{name}</strong>
              {typeof c.rssi === 'number' && <><br />RSSI: {c.rssi} dBm</>}
              {typeof c.snr === 'number' && <><br />SNR: {c.snr} dB</>}
              {typeof c.pathLen === 'number' && <><br />Path: {hopCountLabel(c.pathLen)}</>}
            </Tooltip>
            <Popup>
              <NodeCard
                model={model}
                sections={
                  <>
                    <div className="node-popup-grid">
                      <MeshCoreDetails model={model} />
                    </div>
                    <LastHeardFooter lastHeard={model.lastHeard} mode="absolute" timeFormat={timeFormat} dateFormat={dateFormat} />
                    {actions.length > 0 && <NodeActions actions={actions} />}
                  </>
                }
              />
            </Popup>
          </>
        ),
      };
    }),
    [visibleContacts, onNavigateToDm, timeFormat, dateFormat],
  );

  const localPos = useMemo((): [number, number] | null => {
    if (localNodePosition?.lat != null && localNodePosition?.lng != null) {
      return [localNodePosition.lat, localNodePosition.lng];
    }
    const local = positioned.find(c => c.advName?.includes('(local)'));
    if (local) return [local.latitude!, local.longitude!];
    return null;
  }, [localNodePosition, positioned]);

  // DIVERGENT-BY-DESIGN (#4047 Phase 7, §5.1): a star topology from the local
  // node to every contact, colored AND dashed by `pathLen` (hop count). No
  // other map draws local→node lines keyed on path-length — this is the
  // MeshCore-only "hop-count concept" the Phase-7 spec confirmed divergent
  // (not a duplicate of the neighbor-link promotion below, which renders
  // peer↔peer edges, not local→node hop paths). Left inline, not promoted.
  const pathSegments = useMemo(() => {
    if (!showPaths || !localPos) return [];
    return positioned
      .filter(c => !c.advName?.includes('(local)') && typeof c.pathLen === 'number')
      .map(c => ({
        key: c.publicKey,
        from: localPos,
        to: [c.latitude!, c.longitude!] as [number, number],
        color: hopCountColor(c.pathLen),
        label: `${c.advName || c.name || c.publicKey.substring(0, 8)}: ${hopCountLabel(c.pathLen)}`,
        hops: c.pathLen ?? -1,
      }));
  }, [showPaths, localPos, positioned]);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    api.get<{ success: boolean; data: { items: NeighborEdge[] } }>(
      `/api/sources/${sourceId}/meshcore/neighbors?since=0`,
    ).then((resp) => {
      if (!cancelled && resp.success && Array.isArray(resp.data?.items)) {
        setNeighborEdges(resp.data.items);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sourceId]);

  // Fetch movement trails for the currently-positioned, visible nodes whenever
  // the overlay is on (or its window changes). One request per node against
  // `/nodes/:publicKey/position-history?since=`; cheap because the set of
  // positioned nodes is small and the backend dedupes stationary fixes. When
  // the overlay is off we drop the cache so re-enabling refetches fresh.
  const historyKeysSig = visibleContacts.map(c => c.publicKey).join('|');
  useEffect(() => {
    if (!showPositionHistory || !sourceId) {
      setPositionHistory(new Map());
      return;
    }
    let cancelled = false;
    const keys = historyKeysSig ? historyKeysSig.split('|') : [];
    const since = Date.now() - positionHistoryHours * 60 * 60 * 1000;
    void (async () => {
      const next = new Map<string, [number, number][]>();
      await Promise.all(keys.map(async (publicKey) => {
        try {
          const resp = await api.get<{
            success: boolean;
            data: { latitude: number; longitude: number }[];
          }>(`/api/sources/${sourceId}/meshcore/nodes/${publicKey}/position-history?since=${since}`);
          if (resp.success && Array.isArray(resp.data)) {
            // Drop Null Island fixes first, then keep only trails with enough
            // real points to draw a segment (a 2-point response that's all
            // Null Island would otherwise store a degenerate 1-point trail).
            const pts = resp.data
              .filter(p => !shouldDiscardPosition(p.latitude, p.longitude, undefined, getDiscardInvalidPositions()))
              .map(p => [p.latitude, p.longitude] as [number, number]);
            if (pts.length >= 2) next.set(publicKey, pts);
          }
        } catch {
          // best-effort: a failed trail fetch shouldn't break the map
        }
      }));
      if (!cancelled) setPositionHistory(next);
    })();
    return () => { cancelled = true; };
  }, [showPositionHistory, positionHistoryHours, sourceId, historyKeysSig]);

  // Per-node trail segments, colored oldest→newest like the Meshtastic trail.
  // DIVERGENT-BY-DESIGN (#4047 Phase 7, §5.3): unlike NodesTab's single-
  // selected-node rich trail (spline/points-only/arrows/per-segment popups)
  // and MapAnalysis's `PositionTrailsLayer` (many nodes, one hash-colored
  // polyline each, no age gradient), this is MeshCore's own third form —
  // many nodes, arrowless age-gradient segments, reusing only the shared
  // `getPositionHistoryColor` helper. Not a candidate for promotion; the
  // three forms would have to fuse genuinely different features to share
  // rendering. Left inline per the Phase-2 divergence verdict (unchanged).
  const historySegments = useMemo(() => {
    if (!showPositionHistory) return [];
    const segs: { key: string; positions: [number, number][]; color: string }[] = [];
    for (const [publicKey, points] of positionHistory) {
      if (points.length < 2) continue;
      const segCount = points.length - 1;
      for (let i = 0; i < segCount; i++) {
        segs.push({
          key: `hist-${publicKey}-${i}`,
          positions: [points[i], points[i + 1]],
          color: getPositionHistoryColor(i, segCount),
        });
      }
    }
    return segs;
  }, [showPositionHistory, positionHistory]);

  const neighborSegments = useMemo(() => {
    if (!showNeighbors || !neighborEdges?.length) return [];
    const posByKey = new Map<string, [number, number]>();
    for (const c of positioned) {
      posByKey.set(c.publicKey, [c.latitude!, c.longitude!]);
    }
    return neighborEdges
      .map((e) => {
        const a = posByKey.get(e.publicKey);
        const b = posByKey.get(e.neighborPublicKey);
        if (!a || !b) return null;
        const label = `${e.nodeName || e.publicKey.substring(0, 8)} ↔ ${e.neighborName || e.neighborPublicKey.substring(0, 8)}${e.snr != null ? ` (${e.snr.toFixed(1)} dB)` : ''}`;
        return { key: `nb-${e.publicKey}-${e.neighborPublicKey}`, from: a, to: b, label };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [showNeighbors, neighborEdges, positioned]);

  // Neighbor-link descriptors for the shared `NeighborLinksLayer` (#4047
  // Phase 7, WP8). PURE REFACTOR — `pathOptions`/`children` reproduce the
  // pre-migration fixed cyan style and sticky tooltip verbatim (MeshCoreMap
  // is a "fixed style" consumer: unlike DashboardMap/NodesTab it does not
  // vary opacity by SNR). No `arrows` (MeshCore-only today).
  const neighborLinks: NeighborLinkDescriptor[] = useMemo(
    () => neighborSegments.map((s) => ({
      key: s.key,
      positions: [s.from, s.to],
      pathOptions: { color: NEIGHBOR_COLOR, weight: 1.5, opacity: 0.7, dashArray: '6 4' },
      children: <Tooltip sticky>{s.label}</Tooltip>,
    })),
    [neighborSegments],
  );

  const { center, zoom } = useMemo(() => {
    if (selectedPublicKey) {
      const sel = positioned.find(c => c.publicKey === selectedPublicKey);
      if (sel) return { center: [sel.latitude!, sel.longitude!] as [number, number], zoom: 12 };
    }
    if (positioned.length > 0) {
      const c = positioned[0];
      return { center: [c.latitude!, c.longitude!] as [number, number], zoom: 10 };
    }
    return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  }, [positioned, selectedPublicKey]);

  return (
    <div className="meshcore-map-pane" style={{ position: 'relative' }}>
      {/* Caller-keyed remount (#4047 Phase 7, §3.3): MeshCoreMap force-fits by
          remounting the whole shell on center/zoom change (e.g. selecting a
          node) rather than an imperative flyTo — same effect as the
          pre-migration `<MapContainer key={...}>`, moved to key the BaseMap
          element itself. */}
      <BaseMap
        key={`${center[0]}-${center[1]}-${zoom}`}
        center={center}
        zoom={zoom}
        tilesetId={mapTileset}
        customTilesets={customTilesets}
        showTilesetSelector={showTileSelector}
        onTilesetChange={setMapTileset}
        resizeTrigger={resizeTrigger}
      >
        {measureActive && (
          <MeasureDistanceController
            active={measureActive}
            points={measurePoints}
            onExit={() => setMeasureActive(false)}
          />
        )}
        {showLegend && <MapLegend showNodeTypes />}
        {geoJsonLayers.length > 0 && <GeoJsonOverlay layers={geoJsonLayers} />}
        {showPolarGrid && localPos && (
          <PolarGridOverlay center={{ lat: localPos[0], lng: localPos[1] }} />
        )}
        <NodeMarkersLayer markers={markers} />

        {historySegments.map(s => (
          <Polyline
            key={s.key}
            positions={s.positions}
            pathOptions={{ color: s.color, weight: 3, opacity: 0.8 }}
          />
        ))}

        {pathSegments.map(s => (
          <Polyline
            key={`path-${s.key}`}
            positions={[s.from, s.to]}
            pathOptions={{
              color: s.color,
              weight: 3,
              opacity: 0.8,
              dashArray: s.hops === 0 ? undefined : '8 4',
            }}
          >
            <Tooltip sticky>{s.label}</Tooltip>
          </Polyline>
        ))}

        <NeighborLinksLayer links={neighborLinks} />
      </BaseMap>

      {isLoading && <MapLoadingOverlay />}

      <div className="map-controls dashboard-map-controls">
        <div className="map-controls-body">
          <div className="map-controls-title">Features</div>
          {/* #3636: node-to-node LOS distance measurement toggle. */}
          <label className="map-control-item" title="Measure straight-line distance between two nodes">
            <input
              type="checkbox"
              checked={measureActive}
              disabled={measurePoints.length < 2}
              onChange={(e) => setMeasureActive(e.target.checked)}
            />
            <span>Measure Distance</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showPaths}
              onChange={(e) => setShowPaths(e.target.checked)}
            />
            <span>Show Paths</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showNeighbors}
              onChange={(e) => setShowNeighbors(e.target.checked)}
            />
            <span>Show Neighbors</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showPositionHistory}
              onChange={(e) => setShowPositionHistory(e.target.checked)}
            />
            <span>Show Position History</span>
          </label>
          {showPositionHistory && (
            <div className="map-control-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '2px' }}>
              <span style={{ fontSize: '0.85em' }}>
                History: {positionHistoryHours < 24
                  ? `${positionHistoryHours}h`
                  : `${(positionHistoryHours / 24).toFixed(positionHistoryHours % 24 === 0 ? 0 : 1)}d`}
              </span>
              <input
                type="range"
                min={1}
                max={168}
                step={1}
                value={positionHistoryHours}
                onChange={(e) => setPositionHistoryHours(parseInt(e.target.value, 10))}
                aria-label="Position history length (hours)"
              />
              <span style={{ fontSize: '0.85em', marginTop: '4px' }}>Keep history (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                step={1}
                value={retentionDays}
                onChange={(e) => setRetentionDays(parseInt(e.target.value, 10) || 1)}
                onBlur={(e) => saveRetentionDays(parseInt(e.target.value, 10) || 7)}
                aria-label="Position history retention (days)"
                style={{ width: '4rem' }}
              />
            </div>
          )}
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showPolarGrid}
              onChange={(e) => setShowPolarGrid(e.target.checked)}
              disabled={!localPos}
            />
            <span title={!localPos ? t('map.polarGridDisabledTooltip', 'Requires own node position') : undefined}>
              {t('map.showPolarGrid', 'Show Polar Grid')}
            </span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showTileSelector}
              onChange={(e) => setShowTileSelector(e.target.checked)}
            />
            <span>Show Tile Selection</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showLegend}
              onChange={(e) => setShowLegend(e.target.checked)}
            />
            <span>Show Legend</span>
          </label>
          {/* Per-node-type visibility (issue #3546) — hide infrastructure or
              end-user nodes to focus the map. Same categories as the legend. */}
          <div className="map-controls-title" style={{ marginTop: '0.5rem' }}>
            {t('map.nodeType.legendTitle', 'Node Types')}
          </div>
          {MESHCORE_CATEGORIES.map((category) => {
            const meta = NODE_TYPE_CATEGORY_META[category];
            return (
              <label key={category} className="map-control-item">
                <input
                  type="checkbox"
                  checked={nodeTypeFilter[category] !== false}
                  onChange={(e) => setNodeTypeEnabled(category, e.target.checked)}
                />
                <span>{t(meta.labelKey, meta.label)}</span>
              </label>
            );
          })}
          {/* GeoJSON overlay layers — per-layer on/off, mirroring the other maps. */}
          {geoJsonLayers.map(layer => (
            <label key={layer.id} className="map-control-item">
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={(e) => toggleGeoJsonLayer(layer.id, e.target.checked)}
              />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <span style={{
                  display: 'inline-block', width: '8px', height: '8px',
                  borderRadius: '50%', backgroundColor: layer.style.color,
                }} />
                {layer.name}
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
};
