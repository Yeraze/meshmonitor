/**
 * ReticulumDestinationDetail — the shared destination "details" grid used by
 * both the Locations map popup and the Connections graph's selection panel
 * (#6119). Extracted from `ReticulumMap`'s inline popup so the two surfaces
 * show identical fields. Presentational only.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ReticulumDestinationRow } from '../../types/reticulum';
import styles from './ReticulumMap.module.css';

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

export interface ReticulumDestinationDetailProps {
  destination: ReticulumDestinationRow;
  /** Overrides the heading (e.g. a relay's resolved/truncated label). */
  name?: string;
}

export const ReticulumDestinationDetail: React.FC<ReticulumDestinationDetailProps> = ({ destination: d, name }) => {
  const { t } = useTranslation();
  const heading = name || d.displayName || shortHash(d.destinationHash);
  return (
    <div className={styles.popup}>
      <div className={styles.popupName}>{heading}</div>
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
  );
};

export default ReticulumDestinationDetail;
