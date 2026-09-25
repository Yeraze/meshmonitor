/**
 * CoverageMap — RF reception map for the Coverage Report (#5277, Phase 1
 * WP4). Composes `BaseMap` per CLAUDE.md's "new map surfaces MUST compose
 * BaseMap" rule; the fit-bounds controller follows the `RouterClusterMap`
 * pattern (`FitClusterBounds`).
 *
 * One `CircleMarker` per fix (a physical position, `groupReceptionsIntoFixes`
 * from `src/utils/coverage.ts`), coloured by the BEST reception among the
 * receivers currently in scope (Decision D4) using the SAME theme palette
 * `snrToColor`/`rssiToColor` share (`overlayColors.snrColors`) — shared
 * across protocols (spec §5 U4), no MeshCore-specific colour metric. Receiver
 * markers are larger, distinctly stroked `CircleMarker`s with a permanent
 * label `Tooltip`. Clicking a fix opens a `Popup` listing every reception
 * WITHIN THE CURRENT FILTER (Decision D5) — `fix.receptions` already reflects
 * whatever the caller queried, so no extra per-fix query is made here.
 *
 * MeshCore (#5277 Phase 3 WP3, spec §2.6): a MeshCore row's popup path line
 * reads "Direct" (hopsAway 0) or "N hops via <lastHop>" from
 * `parseMeshCorePathKey(pathKey)` (upper-cased, hash width kept) — never
 * `relayHex`, which decodes a Meshtastic `relayNode` byte and is meaningless
 * for a MeshCore path. The sender header and popup receiver fallback label
 * both go through `formatCoverageNodeId` so a MeshCore pubkey abbreviates
 * the same way it does in `CoverageReceiverFilter`. A `mqtt_gateway` marker
 * backed by a MeshCore row (an Observer feed) keeps the same dashed gateway
 * marker style but labels itself "Observer" instead of "Gateway".
 *
 * Gaps + grid (#5277 Phase 4a WP2, spec §2a.6): `gaps` draws a dashed
 * `Polyline` per likely gap, rendered BEFORE the receiver/fix markers in JSX
 * so it sits under them (Leaflet stacks by add order). `view === 'grid'`
 * swaps the per-fix dots for coloured `Rectangle` cells (`gridCells`,
 * same `snrToColor`/`rssiToColor` palette as the dots); receiver markers are
 * unaffected by the view toggle. `BaseMap` is always given `preferCanvas`
 * (Decision A6): Canvas keeps click/popup/tooltip interactivity while
 * panning/zooming stays smooth with thousands of fix dots plus the grid
 * rectangles and gap polylines on top.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import { CircleMarker, Polyline, Popup, Rectangle, Tooltip, useMap } from 'react-leaflet';
import { BaseMap } from '../map/BaseMap';
import { useSettings } from '../../contexts/SettingsContext';
import { snrToColor, rssiToColor } from '../../utils/mapHelpers';
import { calculateDistance, formatDistance } from '../../utils/distance';
import { formatCoverageNodeId, parseMeshCorePathKey } from '../../utils/coverage';
import type { CoverageFix, CoverageMetric } from '../../utils/coverage';
import type { CoverageReceptionDto, CoverageReceiverDto } from '../../types/coverage';
import type { CoverageGap, CoverageGridCell, CoverageMapView } from '../../types/coverageAnalysis';
import { receiverKey } from '../../utils/coverageReceiverFilter';
import {
  dedupeReceiverMarkers,
  buildDedupedReceiverIndex,
  collapseFixReceptionsBySource,
  physicalReceiverKey,
} from '../../utils/coverageMapGrouping';
import styles from './CoverageMap.module.css';

const RECEIVER_STROKE = '#ffffff';
const RECEIVER_FILL = '#89b4fa';
const GATEWAY_STROKE = '#89b4fa';
const GATEWAY_FILL = '#313244';
/** Fallback for the gap-line colour when `--color-text-muted` can't be read
 *  yet (SSR-less jsdom test environment, or before the first effect runs).
 *  Matches the catppuccin-mocha `overlayColors.snrColors.noData` swatch used
 *  elsewhere on this map, so the gap line reads as "neutral" like everything
 *  else on a dark theme before the real token resolves. */
const DEFAULT_GAP_COLOR = '#6c7086';

/** Leaflet's canvas renderer paints `pathOptions.color` directly onto a 2D
 *  canvas context, which does not understand `var(--token)` strings the way
 *  an SVG `stroke` attribute would — the resolved literal is required. Reads
 *  `--color-text-muted` the same way `LinkQualityChart` reads its chart
 *  colours: once on mount, then again on any theme/class change via a
 *  `MutationObserver` on `<html>`. */
function useGapLineColor(): string {
  const [color, setColor] = useState(DEFAULT_GAP_COLOR);
  useEffect(() => {
    const readColor = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue('--color-text-muted').trim();
      if (value) setColor(value);
    };
    readColor();
    const observer = new MutationObserver(readColor);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
  return color;
}

/** "2 min 30 s" / "2 min" / "45 s". Gaps are capped at
 *  `COVERAGE_GAP_MAX_SEC` (30 min), so no hours component is needed. Local
 *  to this component per spec §2a.10 ("pre-formatted by WP2 ... no extra
 *  keys for units"). */
function formatGapDuration(durationSec: number): string {
  const totalSec = Math.max(0, Math.round(durationSec));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes === 0) return `${seconds} s`;
  if (seconds === 0) return `${minutes} min`;
  return `${minutes} min ${seconds} s`;
}

/** "−4.5 dB" / "−87.0 dBm" — one decimal for both metrics, since a grid
 *  cell's median can land between two integer readings (an even-count
 *  median averages its two middle values). */
function formatGridValue(metric: CoverageMetric, value: number): string {
  return metric === 'snr' ? `${value.toFixed(1)} dB` : `${value.toFixed(1)} dBm`;
}

/** `0x` + the last byte of the relaying node's nodeNum, uppercase — same
 *  convention as RelayNodeModal / PacketMonitorPanel. */
function relayHex(relayNode: number | null): string {
  if (relayNode == null) return '?';
  return `0x${relayNode.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** "Name (id)" when a display name is known, else just the id. `senderNames`
 *  is keyed by senderId with an already-resolved long/short-name fallback
 *  (built by the caller from `/senders`, since that's the only endpoint
 *  that carries names — receptions/receivers don't). The id itself goes
 *  through `formatCoverageNodeId`: a Meshtastic `!id` is unchanged, a
 *  MeshCore pubkey abbreviates to its first 8 hex chars. */
function fixSenderLabel(senderId: string, senderNames: Map<string, string>): string {
  const name = senderNames.get(senderId);
  const displayId = formatCoverageNodeId(senderId);
  return name ? `${name} (${displayId})` : displayId;
}

/** MeshCore popup path line (spec §2.6): "Direct" when zero-hop, else
 *  "N hops via <lastHop>" from the path key's last-hop hash, upper-cased
 *  with its hash width kept. Never calls `relayHex` — that decodes a
 *  Meshtastic `relayNode` byte, which MeshCore rows don't carry. */
function meshCorePathLabel(r: CoverageReceptionDto, t: ReturnType<typeof useTranslation>['t']): string {
  if (r.hopsAway === 0) return t('analysis.coverage.direct', 'Direct');
  if (r.hopsAway == null) return t('analysis.coverage.unknown_path', 'Unknown path');
  const parsed = parseMeshCorePathKey(r.pathKey);
  if (parsed?.lastHop) {
    return t('analysis.coverage.via_meshcore_path', '{{hops}} hops via {{lastHop}}', {
      hops: r.hopsAway,
      lastHop: parsed.lastHop.toUpperCase(),
    });
  }
  return t('analysis.coverage.relayed_unknown', 'Relayed ({{hops}} hops)', { hops: r.hopsAway });
}

/** Fit the map view to every fix + visible receiver, once per FILTER SET
 *  (`fitKey`, built by the caller from sender/receivers/hops/hopsMode/time
 *  range — never the refresh anchor). A manual Refresh re-fetches the same
 *  filter set on a new `points` array reference, which must NOT yank the
 *  view out from under a user who has since panned/zoomed; only a change to
 *  the filters themselves (a new `fitKey`) re-fits. */
const FitCoverageBounds: React.FC<{ points: Array<[number, number]>; fitKey: string }> = ({ points, fitKey }) => {
  const map = useMap();
  const lastFittedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (points.length === 0) return;
    if (lastFittedKeyRef.current === fitKey) return;
    lastFittedKeyRef.current = fitKey;
    if (points.length === 1) {
      map.setView(points[0], 13);
      return;
    }
    const bounds = L.latLngBounds(points);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [map, points, fitKey]);
  return null;
};

interface CoverageMapProps {
  fixes: Array<CoverageFix<CoverageReceptionDto>>;
  receivers: CoverageReceiverDto[];
  metric: CoverageMetric;
  /** senderId -> best display name (longName || shortName), from `/senders`.
   *  A sender with no entry falls back to its bare `!id` in the popup. */
  senderNames: Map<string, string>;
  /** Identifies the current filter set (sender, receivers, hops, hopsMode,
   *  time preset/custom range) but NOT the refresh anchor — see
   *  `FitCoverageBounds`. The map view re-fits when this changes, not on
   *  every `fixes`/`receivers` update. */
  fitKey: string;
  /** Likely-gap polylines (#5277 P4a WP2, spec §2a.6). Drawn under the
   *  receiver/fix markers when present; empty/omitted draws nothing. The
   *  caller decides when a non-empty array is meaningful (one sender
   *  selected). */
  gaps?: CoverageGap[];
  /** 'dots' (default): one CircleMarker per fix, coloured by best value.
   *  'grid': fix dots hidden, `gridCells` rectangles shown instead. Receiver
   *  markers render in both views. */
  view?: CoverageMapView;
  /** Cells to render when `view === 'grid'`. Ignored otherwise. */
  gridCells?: CoverageGridCell[];
}

export const CoverageMap: React.FC<CoverageMapProps> = ({
  fixes,
  receivers,
  metric,
  senderNames,
  fitKey,
  gaps = [],
  view = 'dots',
  gridCells = [],
}) => {
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
  const gapColor = useGapLineColor();
  const metricLabel =
    metric === 'snr'
      ? t('analysis.coverage.metric_snr', 'SNR')
      : t('analysis.coverage.metric_rssi', 'RSSI');

  // Physical markers: the same gateway seen via two MQTT sources collapses
  // to one marker (Decision D7 — keyed `receiverKind|receiverId`, NOT the
  // composite source key above).
  const dedupedMarkers = useMemo(() => dedupeReceiverMarkers(receivers), [receivers]);
  const dedupedByPhysicalKey = useMemo(() => buildDedupedReceiverIndex(dedupedMarkers), [dedupedMarkers]);

  // sourceName lookup for the popup's "via Source A, Source B" line — the
  // only place a reception's bare sourceId resolves to a display name.
  const sourceNameByReceiverKey = useMemo(
    () => new Map(receivers.map((r) => [receiverKey(r.sourceId, r.receiverId), r.sourceName] as const)),
    [receivers],
  );

  const boundsPoints = useMemo<Array<[number, number]>>(() => {
    const points: Array<[number, number]> = fixes.map((f) => [f.latitude, f.longitude]);
    for (const m of dedupedMarkers) points.push([m.latitude, m.longitude]);
    return points;
  }, [fixes, dedupedMarkers]);

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
        preferCanvas
      >
        <FitCoverageBounds points={boundsPoints} fitKey={fitKey} />

        {/* Gap lines drawn first so they sit UNDER every marker/rectangle
            added after them (Leaflet stacks by layer-add order). */}
        {gaps.map((gap) => (
          <Polyline
            key={`gap-${gap.from.packetKey}-${gap.to.packetKey}`}
            positions={[
              [gap.from.latitude, gap.from.longitude],
              [gap.to.latitude, gap.to.longitude],
            ]}
            pathOptions={{ color: gapColor, weight: 2, dashArray: '6 6' }}
          >
            <Tooltip direction="top" sticky>
              {t(
                'analysis.coverage.gap_tooltip',
                'Likely gap: {{duration}}, about {{missed}} fixes missed',
                { duration: formatGapDuration(gap.durationSec), missed: gap.missedEstimate },
              )}
            </Tooltip>
          </Polyline>
        ))}

        {view === 'grid' &&
          gridCells.map((cell) => {
            const color =
              metric === 'snr' ? snrToColor(cell.medianValue, scale) : rssiToColor(cell.medianValue, scale);
            return (
              <Rectangle
                key={`grid-${cell.key}`}
                bounds={[
                  [cell.south, cell.west],
                  [cell.north, cell.east],
                ]}
                pathOptions={{ color: '#000000', weight: 1, opacity: 0.3, fillColor: color, fillOpacity: 0.55 }}
              >
                <Tooltip direction="top" sticky>
                  {cell.medianValue != null
                    ? t('analysis.coverage.grid_tooltip', 'Median {{metric}} {{value}} · {{count}} fixes', {
                        metric: metricLabel,
                        value: formatGridValue(metric, cell.medianValue),
                        count: cell.fixCount,
                      })
                    : t('analysis.coverage.grid_no_value', 'No {{metric}} data · {{count}} fixes', {
                        metric: metricLabel,
                        count: cell.fixCount,
                      })}
                </Tooltip>
              </Rectangle>
            );
          })}

        {dedupedMarkers.map((m) => {
          const isGateway = m.receiverKind === 'mqtt_gateway';
          const isObserver = isGateway && m.protocol === 'meshcore';
          const kindLabel = isObserver
            ? t('analysis.coverage.kind_observer', 'Observer')
            : isGateway
              ? t('analysis.coverage.kind_gateway', 'Gateway')
              : t('analysis.coverage.kind_local', 'Local');
          return (
            <CircleMarker
              key={`receiver-${m.key}`}
              center={[m.latitude, m.longitude]}
              radius={isGateway ? 6 : 9}
              pathOptions={
                isGateway
                  ? {
                      color: GATEWAY_STROKE,
                      weight: 2,
                      dashArray: '4,3',
                      fillColor: GATEWAY_FILL,
                      fillOpacity: 0.85,
                    }
                  : { color: RECEIVER_STROKE, weight: 2, fillColor: RECEIVER_FILL, fillOpacity: 0.9 }
              }
            >
              {/* Hundreds of permanent gateway tooltips would bury the map
                 (spec §2.9); only local receivers keep theirs always on. */}
              <Tooltip
                permanent={!isGateway}
                direction="top"
                offset={[0, -10]}
                className={styles.receiverLabel}
              >
                {m.label} · {kindLabel}
              </Tooltip>
            </CircleMarker>
          );
        })}

        {view !== 'grid' && fixes.map((fix) => {
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
                    {t('analysis.coverage.popup_title', '{{sender}} — {{count}} reception(s)', {
                      sender: fixSenderLabel(fix.senderId, senderNames),
                      count: fix.receptions.length,
                    })}
                  </div>
                  <div className={styles.popupTime} data-testid="coverage-fix-popup-time">
                    {new Date(fix.receivedAt).toLocaleString()}
                  </div>
                  <ul className={styles.popupList}>
                    {collapseFixReceptionsBySource(fix.receptions, sourceNameByReceiverKey).map((c) => {
                      const r = c.best;
                      const receiverInfo = dedupedByPhysicalKey.get(physicalReceiverKey(c.receiverKind, c.receiverId));
                      const receiverLabel = receiverInfo?.label ?? formatCoverageNodeId(c.receiverId);
                      const isMeshCore = r.protocol === 'meshcore';
                      const isGateway = c.receiverKind === 'mqtt_gateway';
                      const isObserver = isGateway && isMeshCore;
                      const direct = r.hopsAway === 0;
                      // MeshCore rows never carry a Meshtastic `relayNode` byte —
                      // their path label comes from `pathKey` instead (spec §2.6).
                      const pathLabel = isMeshCore
                        ? meshCorePathLabel(r, t)
                        : direct
                          ? t('analysis.coverage.direct', 'Direct')
                          : r.hopsAway != null
                            ? r.relayNode
                              ? t(
                                  'analysis.coverage.relayed',
                                  'Relayed ({{hops}} hops, via {{relay}})',
                                  { hops: r.hopsAway, relay: relayHex(r.relayNode) },
                                )
                              : // Relay byte 0 is firmware's NO_RELAY_NODE: the relayer is unknown.
                                t('analysis.coverage.relayed_unknown', 'Relayed ({{hops}} hops)', {
                                  hops: r.hopsAway,
                                })
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
                        <li key={c.key} className={styles.popupItem}>
                          <div className={styles.popupReceiver}>
                            {receiverLabel}
                            {isGateway && (
                              <span className={styles.gatewayBadge}>
                                {isObserver
                                  ? t('analysis.coverage.kind_observer', 'Observer')
                                  : t('analysis.coverage.kind_gateway', 'Gateway')}
                              </span>
                            )}
                          </div>
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
                          {c.sourceLabels.length > 1 && (
                            <div className={styles.popupMeta}>
                              {t('analysis.coverage.popup_via_sources', 'via {{sources}}', {
                                sources: c.sourceLabels.join(', '),
                              })}
                            </div>
                          )}
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
