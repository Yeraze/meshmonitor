/**
 * CoverageMap — RF reception map for the Coverage Report (#5277, Phase 1
 * WP4). Composes `BaseMap` per CLAUDE.md's "new map surfaces MUST compose
 * BaseMap" rule; the fit-bounds controller follows the `RouterClusterMap`
 * pattern (`FitClusterBounds`).
 *
 * One `CircleMarker` per fix (a physical position, `groupReceptionsIntoFixes`
 * from `src/utils/coverage.ts`), coloured by the BEST reception among the
 * receivers currently in scope (Decision D4) using the SAME theme palette
 * `snrToColor`/`rssiToColor` share (`overlayColors.snrColors`). Receiver
 * markers are larger, distinctly stroked `CircleMarker`s with a permanent
 * label `Tooltip`. Clicking a fix opens a `Popup` listing every reception
 * WITHIN THE CURRENT FILTER (Decision D5) — `fix.receptions` already reflects
 * whatever the caller queried, so no extra per-fix query is made here.
 */
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import { CircleMarker, Tooltip, Popup, useMap } from 'react-leaflet';
import { BaseMap } from '../map/BaseMap';
import { useSettings } from '../../contexts/SettingsContext';
import { snrToColor, rssiToColor } from '../../utils/mapHelpers';
import { calculateDistance, formatDistance } from '../../utils/distance';
import type { CoverageFix, CoverageMetric } from '../../utils/coverage';
import type { CoverageReceptionDto, CoverageReceiverDto } from '../../types/coverage';
import styles from './CoverageMap.module.css';

const RECEIVER_STROKE = '#ffffff';
const RECEIVER_FILL = '#89b4fa';

/** `0x` + the last byte of the relaying node's nodeNum, uppercase — same
 *  convention as RelayNodeModal / PacketMonitorPanel. */
function relayHex(relayNode: number | null): string {
  if (relayNode == null) return '?';
  return `0x${relayNode.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** Fit the map view to every fix + visible receiver, once per data set. */
const FitCoverageBounds: React.FC<{ points: Array<[number, number]> }> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(points[0], 13);
      return;
    }
    const bounds = L.latLngBounds(points);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [map, points]);
  return null;
};

interface CoverageMapProps {
  fixes: Array<CoverageFix<CoverageReceptionDto>>;
  receivers: CoverageReceiverDto[];
  metric: CoverageMetric;
}

export const CoverageMap: React.FC<CoverageMapProps> = ({ fixes, receivers, metric }) => {
  const { t } = useTranslation();
  const {
    mapTileset,
    overlayColors,
    customTilesets,
    distanceUnit,
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
  } = useSettings();

  const receiverById = useMemo(
    () => new Map(receivers.map((r) => [r.receiverId, r] as const)),
    [receivers],
  );

  const visibleReceivers = useMemo(
    () => receivers.filter((r) => r.latitude != null && r.longitude != null),
    [receivers],
  );

  const boundsPoints = useMemo<Array<[number, number]>>(() => {
    const points: Array<[number, number]> = fixes.map((f) => [f.latitude, f.longitude]);
    for (const r of visibleReceivers) points.push([r.latitude as number, r.longitude as number]);
    return points;
  }, [fixes, visibleReceivers]);

  const center: [number, number] =
    defaultMapCenterLat != null && defaultMapCenterLon != null
      ? [defaultMapCenterLat, defaultMapCenterLon]
      : [0, 0];
  const zoom = defaultMapCenterZoom ?? 2;

  const scale = overlayColors.snrColors;

  return (
    <div className={styles.mapWrap} data-testid="coverage-map">
      <BaseMap
        center={center}
        zoom={zoom}
        tilesetId={mapTileset}
        customTilesets={customTilesets}
        scrollWheelZoom
      >
        <FitCoverageBounds points={boundsPoints} />

        {visibleReceivers.map((r) => (
          <CircleMarker
            key={`receiver-${r.sourceId}-${r.receiverId}`}
            center={[r.latitude as number, r.longitude as number]}
            radius={9}
            pathOptions={{ color: RECEIVER_STROKE, weight: 2, fillColor: RECEIVER_FILL, fillOpacity: 0.9 }}
          >
            <Tooltip permanent direction="top" offset={[0, -10]} className={styles.receiverLabel}>
              {r.longName || r.shortName || r.receiverId}
            </Tooltip>
          </CircleMarker>
        ))}

        {fixes.map((fix) => {
          const value = metric === 'snr' ? fix.bestSnr : fix.bestRssi;
          const color = metric === 'snr' ? snrToColor(value, scale) : rssiToColor(value, scale);
          return (
            <CircleMarker
              key={`fix-${fix.senderId}-${fix.packetKey}`}
              center={[fix.latitude, fix.longitude]}
              radius={6}
              pathOptions={{ color: '#000000', weight: 1, fillColor: color, fillOpacity: 0.85 }}
            >
              <Popup>
                <div className={styles.popup} data-testid="coverage-fix-popup">
                  <div className={styles.popupTitle}>
                    {t('analysis.coverage.popup_title', 'Fix — {{count}} reception(s)', {
                      count: fix.receptions.length,
                    })}
                  </div>
                  <ul className={styles.popupList}>
                    {fix.receptions.map((r) => {
                      const receiver = receiverById.get(r.receiverId);
                      const receiverLabel = receiver?.longName || receiver?.shortName || r.receiverId;
                      const direct = r.hopsAway === 0;
                      const pathLabel = direct
                        ? t('analysis.coverage.direct', 'Direct')
                        : r.hopsAway != null
                          ? t(
                              'analysis.coverage.relayed',
                              'Relayed ({{hops}} hops, via {{relay}})',
                              { hops: r.hopsAway, relay: relayHex(r.relayNode) },
                            )
                          : t('analysis.coverage.unknown_path', 'Unknown path');
                      const distanceLabel =
                        r.receiverLatitude != null && r.receiverLongitude != null
                          ? formatDistance(
                              calculateDistance(
                                fix.latitude,
                                fix.longitude,
                                r.receiverLatitude,
                                r.receiverLongitude,
                              ),
                              distanceUnit,
                            )
                          : '—';
                      return (
                        <li key={`${r.id}`} className={styles.popupItem}>
                          <div className={styles.popupReceiver}>{receiverLabel}</div>
                          <div className={styles.popupMeta}>
                            {r.snr != null
                              ? t('analysis.coverage.snr_value', 'SNR {{value}} dB', { value: r.snr.toFixed(1) })
                              : t('analysis.coverage.snr_unknown', 'SNR —')}
                            {' · '}
                            {r.rssi != null
                              ? t('analysis.coverage.rssi_value', 'RSSI {{value}} dBm', { value: r.rssi })
                              : t('analysis.coverage.rssi_unknown', 'RSSI —')}
                          </div>
                          <div className={styles.popupMeta}>{pathLabel}</div>
                          <div className={styles.popupMeta}>
                            {t('analysis.coverage.distance', 'Distance: {{value}}', { value: distanceLabel })}
                          </div>
                          <div className={styles.popupMeta}>{new Date(r.receivedAt).toLocaleString()}</div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </BaseMap>

      <div className={styles.legend} data-testid="coverage-legend">
        <div className={styles.legendTitle}>
          {metric === 'snr'
            ? t('analysis.coverage.legend_snr', 'SNR')
            : t('analysis.coverage.legend_rssi', 'RSSI')}
        </div>
        <LegendRow color={scale.excellent} label={t('analysis.coverage.legend_excellent', 'Excellent')} />
        <LegendRow color={scale.good} label={t('analysis.coverage.legend_good', 'Good')} />
        <LegendRow color={scale.fair} label={t('analysis.coverage.legend_fair', 'Fair')} />
        <LegendRow color={scale.poor} label={t('analysis.coverage.legend_poor', 'Poor')} />
        <LegendRow color={scale.noData} label={t('analysis.coverage.legend_no_data', 'No data')} />
        <div className={styles.legendNote}>
          {t(
            'analysis.coverage.legend_relay_note',
            "For receptions with 1 or more hops, colour shows the last relay's link, not the sender's position.",
          )}
        </div>
      </div>
    </div>
  );
};

const LegendRow: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <div className={styles.legendRow}>
    <span className={styles.legendSwatch} style={{ backgroundColor: color }} />
    <span>{label}</span>
  </div>
);

export default CoverageMap;
