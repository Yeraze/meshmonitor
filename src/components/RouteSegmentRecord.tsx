import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import { formatDistance } from '../utils/distance';
import { formatDateTime } from '../utils/datetime';
import type { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import type { RouteSegmentView } from '../services/api';
import styles from './RouteSegmentRecord.module.css';

/**
 * One labelled route-segment record card (#5101 P2 WP5). Used for both the
 * "Longest Active" and "Record Holder" cards in InfoTab, once per non-null
 * `byTransport` entry (labelled) or once for the unlabelled top-level record
 * on an MQTT-only source. See `TRANSPORT_BREAKDOWN_P2_SPEC.md` §4.6.
 */
export interface RouteSegmentRecordProps {
  segment: RouteSegmentView;
  /** Transport label shown above the record; omit on MQTT-only sources. */
  transportLabel?: string;
  /** t('info.last_seen') or t('info.achieved'). */
  timeLabel: string;
  distanceUnit: 'km' | 'mi';
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  /** Record card only: renders the trophy icon next to the distance. */
  showTrophy?: boolean;
  /** Shown only when `segment.transportMechanism === null` (pre-#5101 row). */
  legacyNote?: string;
  /** Renders the Clear Record button when provided. */
  onClear?: () => void;
  clearLabel?: string;
  testId?: string;
}

export default function RouteSegmentRecord({
  segment,
  transportLabel,
  timeLabel,
  distanceUnit,
  timeFormat,
  dateFormat,
  showTrophy = false,
  legacyNote,
  onClear,
  clearLabel,
  testId,
}: RouteSegmentRecordProps): React.ReactElement {
  const { t } = useTranslation();
  const showLegacyNote = Boolean(legacyNote) && segment.transportMechanism === null;

  return (
    <div
      className={styles.record}
      data-testid={testId}
      aria-label={transportLabel ? t('info.route_record_label', { transport: transportLabel }) : undefined}
    >
      {transportLabel && <p className={styles.transportLabel}>{transportLabel}</p>}
      <p>
        <strong>{t('info.distance')}</strong> {formatDistance(segment.distanceKm, distanceUnit)}
        {showTrophy && (
          <>
            {' '}
            <UiIcon name="trophy" />
          </>
        )}
      </p>
      <p><strong>{t('info.from')}</strong> {segment.fromNodeName} ({segment.fromNodeId})</p>
      <p><strong>{t('info.to')}</strong> {segment.toNodeName} ({segment.toNodeId})</p>
      <p className={styles.timeLine}>
        {timeLabel} {formatDateTime(new Date(segment.timestamp), timeFormat, dateFormat)}
      </p>
      {showLegacyNote && <p className={styles.legacyNote}>{legacyNote}</p>}
      {onClear && (
        <button onClick={onClear} className={`danger-button ${styles.clearButton}`}>
          {clearLabel}
        </button>
      )}
    </div>
  );
}
