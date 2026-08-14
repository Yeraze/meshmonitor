/**
 * ReticulumMap — peer positions shared via Sideband telemetry (#3960 Phase 3).
 *
 * Deliberately lean vs `MeshCoreMap`: Reticulum has no neighbor-link graph,
 * no hop-count star, and no promiscuous position history — a peer only appears
 * here when it shares Sideband `SID_LOCATION` telemetry with our identity
 * (design §7). So this composes the shared `BaseMap` + `NodeMarkersLayer`
 * with a self-contained popup (no NodeCard model coupling), null-island
 * filtered, and shows an explicit empty state when no peer is sharing.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Popup, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import { BaseMap } from '../map/BaseMap';
import { MapLoadingOverlay } from '../map/MapLoadingOverlay';
import { NodeMarkersLayer, type NodeMarkerDescriptor } from '../map/layers/NodeMarkersLayer';
import { createNodeIcon } from '../map/markerIcons';
import { shouldDiscardPosition } from '../../utils/nullIsland';
import { getDiscardInvalidPositions } from '../../utils/positionDisplayConfig';
import type { ReticulumDestinationRow } from '../../types/reticulum';
import styles from './ReticulumMap.module.css';

const RETICULUM_COLOR = '#94e2d5';
const DEFAULT_CENTER: [number, number] = [0, 0];
const DEFAULT_ZOOM = 2;

interface ReticulumMapProps {
  /** Announced destinations; those carrying a shared Sideband position render. */
  destinations: ReticulumDestinationRow[];
  loading?: boolean;
  resizeTrigger?: unknown;
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

export const ReticulumMap: React.FC<ReticulumMapProps> = ({ destinations, loading = false, resizeTrigger }) => {
  const { t } = useTranslation();
  const { mapTileset, customTilesets, setMapTileset, activeStyleJson } = useSettings();

  const positioned = useMemo(
    () => destinations.filter(d =>
      typeof d.latitude === 'number' && isFinite(d.latitude)
      && typeof d.longitude === 'number' && isFinite(d.longitude)
      && !shouldDiscardPosition(d.latitude, d.longitude, undefined, getDiscardInvalidPositions())),
    [destinations],
  );

  const markers: NodeMarkerDescriptor[] = useMemo(
    () => positioned.map(d => {
      const name = d.displayName || shortHash(d.destinationHash);
      return {
        key: d.destinationHash,
        position: [d.latitude as number, d.longitude as number] as [number, number],
        iconSig: `${name}|reticulum`,
        buildIcon: () => createNodeIcon({
          variant: 'meshcore',
          fixedColor: RETICULUM_COLOR,
          labelName: name,
        }),
        children: (
          <>
            <Tooltip>
              <strong>{name}</strong>
              {d.appName && <><br />{d.appName}</>}
              {typeof d.rssi === 'number' && <><br />RSSI: {d.rssi} dBm</>}
            </Tooltip>
            <Popup>
              <div className={styles.popup}>
                <div className={styles.popupName}>{name}</div>
                <dl className={styles.popupGrid}>
                  <dt>{t('reticulum.map.hash', 'Hash')}</dt><dd className={styles.mono}>{shortHash(d.destinationHash)}</dd>
                  {d.appName && (<><dt>{t('reticulum.map.app', 'App')}</dt><dd>{d.appName}</dd></>)}
                  {typeof d.hops === 'number' && (<><dt>{t('reticulum.map.hops', 'Hops')}</dt><dd>{d.hops}</dd></>)}
                  {typeof d.rssi === 'number' && (<><dt>RSSI</dt><dd>{d.rssi} dBm</dd></>)}
                  {typeof d.snr === 'number' && (<><dt>SNR</dt><dd>{d.snr} dB</dd></>)}
                  {typeof d.altitude === 'number' && (<><dt>{t('reticulum.map.altitude', 'Altitude')}</dt><dd>{d.altitude} m</dd></>)}
                  {typeof d.speed === 'number' && (<><dt>{t('reticulum.map.speed', 'Speed')}</dt><dd>{d.speed} m/s</dd></>)}
                </dl>
              </div>
            </Popup>
          </>
        ),
      };
    }),
    [positioned, t],
  );

  const { center, zoom } = useMemo(() => {
    if (positioned.length > 0) {
      const d = positioned[0];
      return { center: [d.latitude as number, d.longitude as number] as [number, number], zoom: 10 };
    }
    return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  }, [positioned]);

  return (
    <div className={styles.mapPane}>
      <BaseMap
        key={`${center[0]}-${center[1]}-${zoom}`}
        center={center}
        zoom={zoom}
        tilesetId={mapTileset}
        customTilesets={customTilesets}
        styleJson={activeStyleJson ?? undefined}
        onTilesetChange={setMapTileset}
        resizeTrigger={resizeTrigger}
      >
        <NodeMarkersLayer markers={markers} />
      </BaseMap>

      {loading && <MapLoadingOverlay />}

      {!loading && positioned.length === 0 && (
        <div className={styles.emptyState} role="status">
          {t('reticulum.map.empty', 'No peers are sharing position/telemetry with this identity yet.')}
        </div>
      )}
    </div>
  );
};

export default ReticulumMap;
