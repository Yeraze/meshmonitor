/**
 * Walkabout hex map (#5891 P2, spec §2.10).
 * The only client file that may import `h3-js`; reached only through
 * `walkaboutHexMapLazy.ts`, so the library stays in its own lazy chunk.
 *
 * Each H3 cell is one canvas `Polygon`, filled by the best SNR the walker's
 * radio heard there. The H3 resolution follows the map zoom; the fit-to-bounds
 * key never includes it, so a res change never re-fits or refetches in a loop.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cellToBoundary } from 'h3-js';
import { Polygon, Polyline, Popup, useMapEvents } from 'react-leaflet';
import { BaseMap } from '../map/BaseMap';
import { FitBoundsOnce } from '../map/FitBoundsOnce';
import { useBaseMapSettings } from '../map/useBaseMapSettings';
import { useSettings } from '../../contexts/SettingsContext';
import { UiIcon } from '../icons';
import {
  useWalkaboutCellNodes,
  useWalkaboutCells,
  useWalkaboutTrack,
} from '../../hooks/useWalkabout';
import {
  WALKABOUT_SNR_MEDIUM_DB,
  WALKABOUT_SNR_STRONG_DB,
  WALKABOUT_SNR_WEAK_DB,
  walkaboutBucket,
  walkaboutResForZoom,
  type WalkaboutBucket,
} from '../../utils/walkabout';
import { getUserDisplayName } from '../../utils/nodeHelpers';
import { formatCoverageNodeId } from '../../utils/coverage';
import type { WalkaboutCellDto, WalkaboutH3Res, WalkaboutMapQuery } from '../../types/walkabout';
import styles from './WalkaboutHexMap.module.css';

export interface WalkaboutHexMapProps {
  sourceId: string;
  query: WalkaboutMapQuery;
  /** Changes when source or window/session changes. Never includes res. */
  fitKey: string;
}

/** Bucket -> `overlayColors.snrColors` key (spec §1.2). */
const BUCKET_COLOR_KEY = {
  strong: 'excellent',
  medium: 'good',
  weak: 'fair',
  none: 'poor',
  unknown: 'noData',
} as const satisfies Record<WalkaboutBucket, string>;

const CELL_NODES_CAP = 200;
const FIT_MAX_ZOOM = 16;

/** Follows the map zoom and reports the H3 resolution it implies. */
const ZoomResController: React.FC<{ onRes: (res: WalkaboutH3Res) => void }> = ({ onRes }) => {
  const map = useMapEvents({
    zoomend: () => onRes(walkaboutResForZoom(map.getZoom())),
  });
  return null;
};

interface OpenCell {
  cell: string;
  latlng: [number, number];
  receptionCount: number;
}

const CellPopupBody: React.FC<{
  sourceId: string;
  query: WalkaboutMapQuery;
  open: OpenCell;
}> = ({ sourceId, query, open }) => {
  const { t } = useTranslation();
  const heard = open.receptionCount > 0;
  const { data, isLoading, isError } = useWalkaboutCellNodes(sourceId, query, heard ? open.cell : null);

  if (!heard) {
    return (
      <div className={styles.popup}>
        <div className={styles.popupTitle}>
          {t('analysis.walkabout.map.walked_nothing_heard', 'Walked here, nothing heard')}
        </div>
      </div>
    );
  }
  if (isLoading) {
    return <div className={styles.popup}>{t('analysis.walkabout.map.loading', 'Loading...')}</div>;
  }
  if (isError || !data) {
    return <div className={styles.popup}>{t('analysis.walkabout.map.load_error', 'Could not load nodes.')}</div>;
  }
  const n = data.nodes.length;
  const countText = data.truncated ? `${CELL_NODES_CAP}+` : String(n);
  const title =
    n === 1 && !data.truncated
      ? t('analysis.walkabout.map.node_heard', '1 node heard here')
      : t('analysis.walkabout.map.nodes_heard', '{{n}} nodes heard here', { n: countText });
  return (
    <div className={styles.popup}>
      <div className={styles.popupTitle}>{title}</div>
      <ul className={styles.popupList}>
        {data.nodes.map((node) => {
          const name = getUserDisplayName(
            {
              longName: node.longName,
              shortName: node.shortName,
              id: node.nodeId ?? (node.publicKey ? formatCoverageNodeId(node.publicKey) : null),
            },
            node.nodeNum ?? 0,
          );
          const snr =
            node.bestSnr == null
              ? t('analysis.walkabout.map.snr_none', 'SNR —')
              : t('analysis.walkabout.map.snr_db', '{{snr}} dB', { snr: node.bestSnr });
          return (
            <li key={node.nodeId ?? node.publicKey ?? String(node.nodeNum)} className={styles.popupRow}>
              <span className={styles.popupName} title={name}>{name}</span>
              <span className={styles.popupMeta}>
                {snr} · {'×'}{node.receptionCount}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const WalkaboutHexMap: React.FC<WalkaboutHexMapProps> = ({ sourceId, query, fitKey }) => {
  const { t } = useTranslation();
  const baseMapSettings = useBaseMapSettings();
  const { overlayColors, defaultMapCenterLat, defaultMapCenterLon, defaultMapCenterZoom } = useSettings();

  const center: [number, number] =
    defaultMapCenterLat != null && defaultMapCenterLon != null
      ? [defaultMapCenterLat, defaultMapCenterLon]
      : [0, 0];
  const zoom = defaultMapCenterZoom ?? 2;

  const [res, setRes] = useState<WalkaboutH3Res>(() => walkaboutResForZoom(zoom));
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);

  const { data, isPlaceholderData, isLoading } = useWalkaboutCells(sourceId, query, res);
  const sessionId = query.kind === 'session' ? query.sessionId : null;
  const track = useWalkaboutTrack(sourceId, sessionId);

  const cells = data?.cells;
  const boundsPoints = useMemo<Array<[number, number]>>(() => {
    const b = data?.bounds;
    return b ? [[b.bboxSouth, b.bboxWest], [b.bboxNorth, b.bboxEast]] : [];
  }, [data?.bounds]);

  // Outlines are memoised per cell id, so a refetch of the same cells is free.
  const outlines = useMemo(() => {
    const m = new Map<string, Array<[number, number]>>();
    for (const c of cells ?? []) m.set(c.cell, cellToBoundary(c.cell) as Array<[number, number]>);
    return m;
  }, [cells]);

  const palette = overlayColors.snrColors;
  const colorOf = useCallback(
    (c: WalkaboutCellDto) => palette[BUCKET_COLOR_KEY[walkaboutBucket(c)]],
    [palette],
  );

  const onRes = useCallback((r: WalkaboutH3Res) => setRes(r), []);

  const hasUnknown = (cells ?? []).some((c) => walkaboutBucket(c) === 'unknown');
  const empty = !!data && !isPlaceholderData && data.cells.length === 0;
  const legendRows: Array<{ bucket: WalkaboutBucket; label: string }> = [
    {
      bucket: 'strong',
      label: t('analysis.walkabout.map.legend_strong', 'Strong ({{min}} dB or better)', { min: WALKABOUT_SNR_STRONG_DB }),
    },
    {
      bucket: 'medium',
      label: t('analysis.walkabout.map.legend_medium', 'Medium ({{min}} to {{max}} dB)', {
        min: WALKABOUT_SNR_MEDIUM_DB,
        max: WALKABOUT_SNR_STRONG_DB,
      }),
    },
    {
      bucket: 'weak',
      label: t('analysis.walkabout.map.legend_weak', 'Weak ({{min}} to {{max}} dB)', {
        min: WALKABOUT_SNR_WEAK_DB,
        max: WALKABOUT_SNR_MEDIUM_DB,
      }),
    },
    {
      bucket: 'none',
      label: t('analysis.walkabout.map.legend_none', 'None (below {{min}} dB, or nothing heard)', {
        min: WALKABOUT_SNR_WEAK_DB,
      }),
    },
  ];
  if (hasUnknown) {
    legendRows.push({ bucket: 'unknown', label: t('analysis.walkabout.map.legend_unknown', 'Heard, no SNR') });
  }

  return (
    <div className={styles.wrap} data-testid="walkabout-hex-map">
      {data?.truncated && (
        <div className={styles.banner} role="status">
          <UiIcon name="alert" size={14} />{' '}
          {t(
            'analysis.walkabout.map.truncated',
            'Showing part of this window. Pick a session or a shorter window.',
          )}
        </div>
      )}
      {!!data && data.hiddenReceptionCount > 0 && (
        <div className={styles.banner} role="status">
          <UiIcon name="alert" size={14} />{' '}
          {t(
            'analysis.walkabout.map.hidden_receptions',
            '{{count}} receptions from nodes you cannot see on the map are not shown.',
            { count: data.hiddenReceptionCount },
          )}
        </div>
      )}
      {empty && (
        <div className={styles.banner} role="status">
          {t('analysis.walkabout.map.empty', 'No walkabout data in this window.')}
        </div>
      )}
      <div className={styles.mapBox}>
        <BaseMap center={center} zoom={zoom} {...baseMapSettings} scrollWheelZoom preferCanvas>
          <ZoomResController onRes={onRes} />
          {!isPlaceholderData && boundsPoints.length > 0 && (
            <FitBoundsOnce points={boundsPoints} fitKey={fitKey} maxZoom={FIT_MAX_ZOOM} />
          )}
          {track.data && track.data.positions.length > 1 && (
            <Polyline
              positions={track.data.positions}
              pathOptions={{ color: overlayColors.walkaboutTrack, weight: 3 }}
            />
          )}
          {(cells ?? []).map((c) => {
            const outline = outlines.get(c.cell);
            if (!outline) return null;
            const color = colorOf(c);
            return (
              <Polygon
                key={c.cell}
                positions={outline}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.45, weight: 1 }}
                eventHandlers={{
                  click: (e: { latlng: { lat: number; lng: number } }) =>
                    setOpenCell({
                      cell: c.cell,
                      latlng: [e.latlng.lat, e.latlng.lng],
                      receptionCount: c.receptionCount,
                    }),
                }}
              />
            );
          })}
          {openCell && (
            <Popup
              key={openCell.cell}
              position={openCell.latlng}
              maxWidth={240}
              eventHandlers={{ remove: () => setOpenCell(null) }}
            >
              <CellPopupBody sourceId={sourceId} query={query} open={openCell} />
            </Popup>
          )}
        </BaseMap>
        {isLoading && (
          <div className={styles.loading} role="status">
            {t('analysis.walkabout.map.loading', 'Loading...')}
          </div>
        )}
      </div>
      <div className={styles.legend} data-testid="walkabout-legend">
        <div className={styles.legendNote}>
          {t(
            'analysis.walkabout.map.legend_note',
            'Colour shows the best signal heard in each hex, from the last hop.',
          )}
        </div>
        <div className={styles.legendRows}>
          {legendRows.map((row) => (
            <span key={row.bucket} className={styles.legendRow} data-bucket={row.bucket}>
              <span
                className={styles.legendSwatch}
                style={{ backgroundColor: palette[BUCKET_COLOR_KEY[row.bucket]] }}
              />
              {row.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default WalkaboutHexMap;
