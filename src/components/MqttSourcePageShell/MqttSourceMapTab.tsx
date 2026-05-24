/**
 * MqttSourceMapTab — the Map tab for MQTT source detail pages.
 *
 * Fetches per-source nodes / traceroutes / neighbor-info / channels via
 * useDashboardSourceData and hands them to the existing DashboardMap
 * component (which already accepts a sourceId for per-source filtering).
 * Tileset and default-center come from SettingsContext.
 */

import { useTranslation } from 'react-i18next';
import DashboardMap from '../Dashboard/DashboardMap';
import { useDashboardSourceData } from '../../hooks/useDashboardData';
import { useSettings } from '../../contexts/SettingsContext';

export interface MqttSourceMapTabProps {
  sourceId: string;
}

export function MqttSourceMapTab({ sourceId }: MqttSourceMapTabProps) {
  const { t } = useTranslation();
  const { mapTileset, customTilesets, defaultMapCenterLat, defaultMapCenterLon, maxNodeAgeHours } = useSettings();
  const { nodes, neighborInfo, traceroutes, channels, isLoading, isError } = useDashboardSourceData(sourceId);

  if (isLoading && nodes.length === 0) {
    return (
      <div style={{ padding: '2rem' }}>
        <p>{t('source.mqtt.map.loading', 'Loading map data…')}</p>
      </div>
    );
  }

  if (isError && nodes.length === 0) {
    return (
      <div style={{ padding: '2rem' }}>
        <p>{t('source.mqtt.map.error', 'Could not load map data for this source.')}</p>
      </div>
    );
  }

  const defaultCenter = {
    lat: defaultMapCenterLat ?? 30.0,
    lng: defaultMapCenterLon ?? -90.0,
  };

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative' }}>
      <DashboardMap
        nodes={nodes}
        neighborInfo={neighborInfo}
        traceroutes={traceroutes}
        channels={channels}
        tilesetId={mapTileset}
        customTilesets={customTilesets}
        defaultCenter={defaultCenter}
        sourceId={sourceId}
        maxNodeAgeHours={maxNodeAgeHours}
      />
    </div>
  );
}
