/**
 * The empty state for a view whose source has no running manager (#4173
 * review N5). Telemetry, Security and the MeshCore Packet Monitor show this
 * when the server answers `code: 'SOURCE_NOT_CONNECTED'`, in place of the
 * raw error text ("No MeshCore manager for source …", "HTTP 404").
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import styles from './SourceNotConnectedNotice.module.css';

export const SourceNotConnectedNotice: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className={styles.notice} role="status" data-testid="source-not-connected">
      <UiIcon name="power" size={28} className={styles.icon} />
      <p className={styles.title}>{t('source.not_connected.title')}</p>
      <p className={styles.body}>{t('source.not_connected.body')}</p>
    </div>
  );
};

export default SourceNotConnectedNotice;
