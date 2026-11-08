import React from 'react';
import { useTranslation } from 'react-i18next';
import { MapSidebar } from '../map/MapSidebar';
import { PacketFlightsControl } from '../map/PacketFlightsControl';
import { DuctingControl } from '../map/DuctingControl';
import MapLegend from '../MapLegend';
import { TilesetSelector } from '../TilesetSelector';
import { NumberInput } from '../common/NumberInput';
import { UiIcon } from '../icons';
import {
  MESHCORE_CATEGORIES,
  NODE_TYPE_CATEGORY_META,
  type NodeTypeCategory,
} from '../../utils/nodeTypeCategory';
import type { PacketFlightStats } from '../../utils/packetFlightEdges';
import type { GeoJsonLayer } from '../../server/services/geojsonService.js';
import type { TilesetId } from '../../config/tilesets';

/**
 * The MeshCore map's sidebar body (Map controls). State lives in `MeshCoreMap`;
 * this component only renders it, so the map file stays about the map.
 */
export interface MeshCoreMapControlsProps {
  sourceId: string | null;
  /** 3D view is active: Leaflet-only controls are disabled. */
  effective3D: boolean;
  canUse3D: boolean;
  viewMode: '2d' | '3d';
  setViewMode: (mode: '2d' | '3d') => void;

  measureActive: boolean;
  setMeasureActive: (v: boolean) => void;
  measurePointCount: number;

  showPaths: boolean;
  setShowPaths: (v: boolean) => void;
  showNeighbors: boolean;
  setShowNeighbors: (v: boolean) => void;

  showCrossSourceLinks: boolean;
  setShowCrossSourceLinks: (v: boolean) => void;

  showLocalMarkers: boolean;
  setShowLocalMarkers: (v: boolean) => void;
  /** Caller holds `waypoints:write` on this source. */
  canWriteLocalMarkers: boolean;
  placingLocalMarker: boolean;
  onAddLocalMarker: () => void;

  showPacketFlights: boolean;
  setShowPacketFlights: (v: boolean) => void;
  packetFlightRate: number;
  setPacketFlightRate: (v: number) => void;
  packetFlightsStats: PacketFlightStats | null;

  showDucting: boolean;
  setShowDucting: (v: boolean) => void;
  ductingHoursAhead: number;
  setDuctingHoursAhead: (v: number) => void;

  showPositionHistory: boolean;
  setShowPositionHistory: (v: boolean) => void;
  positionHistoryHours: number;
  setPositionHistoryHours: (v: number) => void;
  retentionDays: number;
  setRetentionDays: (v: number) => void;
  saveRetentionDays: (days: number) => void;

  hidePositionlessAdverts: boolean;
  setHidePositionlessAdverts: (v: boolean) => void;

  showPolarGrid: boolean;
  setShowPolarGrid: (v: boolean) => void;
  hasLocalPosition: boolean;

  showTileSelector: boolean;
  setShowTileSelector: (v: boolean) => void;
  showLegend: boolean;
  setShowLegend: (v: boolean) => void;
  mapTileset: TilesetId;
  setMapTileset: (id: TilesetId) => void;

  nodeTypeFilter: Partial<Record<NodeTypeCategory, boolean>>;
  setNodeTypeEnabled: (category: NodeTypeCategory, enabled: boolean) => void;

  geoJsonLayers: GeoJsonLayer[];
  toggleGeoJsonLayer: (id: string, visible: boolean) => void;

  /**
   * Seam for extra feature toggles (the estimated-positions controls land
   * here), rendered after the built-in feature toggles.
   */
  extraFeatureControls?: React.ReactNode;
}

export const MeshCoreMapControls: React.FC<MeshCoreMapControlsProps> = (p) => {
  const { t } = useTranslation();
  const unavailableIn3DTitle = p.effective3D ? 'Not available in 3D' : undefined;
  return (
    <MapSidebar storageKey="mm-meshcore-map-sidebar" title="Map controls">
      <div className="map-controls dashboard-map-controls">
        <div className="map-controls-body">
          <div className="map-controls-title">Features</div>
          {/* #3636: node-to-node LOS distance measurement toggle. */}
          <label className="map-control-item" title="Measure straight-line distance between two nodes">
            <input
              type="checkbox"
              checked={p.measureActive}
              disabled={p.effective3D || p.measurePointCount < 2}
              onChange={(e) => p.setMeasureActive(e.target.checked)}
            />
            <span>Measure Distance</span>
          </label>
          {/* #4704: 2D/3D toggle, only offered when the server can serve DEM
              terrain tiles (elevation enabled + terrarium tiles). */}
          {p.canUse3D && (
            <label className="map-control-item" title="Show terrain in a pitched 3D view">
              <input
                type="checkbox"
                checked={p.viewMode === '3d'}
                onChange={(e) => p.setViewMode(e.target.checked ? '3d' : '2d')}
              />
              <span>3D Terrain</span>
            </label>
          )}
          <label className="map-control-item" title={unavailableIn3DTitle}>
            <input
              type="checkbox"
              checked={p.showPaths}
              disabled={p.effective3D}
              onChange={(e) => p.setShowPaths(e.target.checked)}
            />
            <span>Show Paths</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={p.showNeighbors}
              onChange={(e) => p.setShowNeighbors(e.target.checked)}
            />
            <span>Show Neighbors</span>
          </label>
          {/* Cross-source "heard here" edges (#5561): this source's radio heard
              by, or hearing, another of our sources. Needs a source. */}
          {p.sourceId && (
            <label
              className="map-control-item"
              title={t(
                'map.cross_source.toggle_hint',
                'One-way edges: one of your sources was heard by another. Dotted = likely relay (inferred). Dashed = heard by an MQTT gateway.',
              )}
            >
              <input
                type="checkbox"
                checked={p.showCrossSourceLinks}
                onChange={(e) => p.setShowCrossSourceLinks(e.target.checked)}
              />
              <span>{t('map.cross_source.toggle', 'Show Cross-Source Links')}</span>
            </label>
          )}
          {/* Local markers (#5686): planning notes, never sent to the mesh. */}
          {p.sourceId && (
            <label className="map-control-item" title={unavailableIn3DTitle}>
              <input
                type="checkbox"
                checked={p.showLocalMarkers}
                disabled={p.effective3D}
                onChange={(e) => p.setShowLocalMarkers(e.target.checked)}
              />
              <span>{t('map.showLocalMarkers', 'Show Local Markers')}</span>
            </label>
          )}
          {p.sourceId && p.canWriteLocalMarkers && (
            <button
              type="button"
              className="waypoint-create-button"
              onClick={p.onAddLocalMarker}
              disabled={p.placingLocalMarker || p.effective3D}
              title={t('localMarkers.addTitle', 'Place a local marker by clicking on the map. It is never sent to the mesh.')}
            >
              <UiIcon name="plus" /> {t('localMarkers.add', 'Local marker')}
            </button>
          )}
          {/* #4835: live packet traffic (dots flying to the receiver). */}
          <PacketFlightsControl
            checked={p.showPacketFlights}
            onCheckedChange={p.setShowPacketFlights}
            rate={p.packetFlightRate}
            onRateChange={p.setPacketFlightRate}
            stats={p.packetFlightsStats}
            disabledTitle={unavailableIn3DTitle}
          />
          {/* #5972: tropospheric ducting overlay. Renders nothing unless an
              admin turned the overlay on. */}
          {p.sourceId && (
            <DuctingControl
              checked={p.showDucting}
              onCheckedChange={p.setShowDucting}
              hoursAhead={p.ductingHoursAhead}
              onHoursAheadChange={p.setDuctingHoursAhead}
              sourceId={p.sourceId}
              disabledTitle={unavailableIn3DTitle}
            />
          )}
          <label className="map-control-item" title={unavailableIn3DTitle}>
            <input
              type="checkbox"
              checked={p.showPositionHistory}
              disabled={p.effective3D}
              onChange={(e) => p.setShowPositionHistory(e.target.checked)}
            />
            <span>Show Position History</span>
          </label>
          {p.showPositionHistory && (
            <div className="map-control-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '2px' }}>
              <span style={{ fontSize: '0.85em' }}>
                History: {p.positionHistoryHours < 24
                  ? `${p.positionHistoryHours}h`
                  : `${(p.positionHistoryHours / 24).toFixed(p.positionHistoryHours % 24 === 0 ? 0 : 1)}d`}
              </span>
              <input
                type="range"
                min={1}
                max={168}
                step={1}
                value={p.positionHistoryHours}
                onChange={(e) => p.setPositionHistoryHours(parseInt(e.target.value, 10))}
                aria-label="Position history length (hours)"
              />
              <span style={{ fontSize: '0.85em', marginTop: '4px' }}>Keep history (days)</span>
              <NumberInput
                min={1}
                max={365}
                step={1}
                integer
                value={p.retentionDays}
                onChange={p.setRetentionDays}
                // Saves on blur; blank or out-of-range text is not saved (#5649).
                onBlur={(e) => {
                  if (e.currentTarget.dataset.numberInvalid === 'true') return;
                  p.saveRetentionDays(p.retentionDays);
                }}
                aria-label="Position history retention (days)"
                style={{ width: '4rem' }}
              />
            </div>
          )}
          <label
            className="map-control-item"
            title={t(
              'map.hidePositionlessAdvertsHelp',
              'Hide MeshCore nodes whose latest advert carried no position. They are otherwise drawn at their last known position. Nodes with a live telemetry position stay.',
            )}
          >
            <input
              type="checkbox"
              checked={p.hidePositionlessAdverts}
              onChange={(e) => p.setHidePositionlessAdverts(e.target.checked)}
            />
            <span>{t('map.hidePositionlessAdverts', 'Hide nodes without a current position advert')}</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={p.showPolarGrid}
              onChange={(e) => p.setShowPolarGrid(e.target.checked)}
              disabled={!p.hasLocalPosition || p.effective3D}
            />
            <span title={!p.hasLocalPosition ? t('map.polarGridDisabledTooltip', 'Requires own node position') : undefined}>
              {t('map.showPolarGrid', 'Show Polar Grid')}
            </span>
          </label>
          {p.extraFeatureControls}
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={p.showTileSelector}
              onChange={(e) => p.setShowTileSelector(e.target.checked)}
            />
            <span>Show Tile Selection</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={p.showLegend}
              onChange={(e) => p.setShowLegend(e.target.checked)}
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
                  checked={p.nodeTypeFilter[category] !== false}
                  onChange={(e) => p.setNodeTypeEnabled(category, e.target.checked)}
                />
                <span>{t(meta.labelKey, meta.label)}</span>
              </label>
            );
          })}
          {/* GeoJSON overlay layers — per-layer on/off, mirroring the other maps. */}
          {p.geoJsonLayers.map(layer => (
            <label key={layer.id} className="map-control-item">
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={(e) => p.toggleGeoJsonLayer(layer.id, e.target.checked)}
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
      {p.showTileSelector && (
        <TilesetSelector
          selectedTilesetId={p.mapTileset}
          onTilesetChange={p.setMapTileset}
          embedded
        />
      )}
      {p.showLegend && <MapLegend showNodeTypes embedded />}
    </MapSidebar>
  );
};

export default MeshCoreMapControls;
