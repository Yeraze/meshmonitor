import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { MeshcoreFindings } from './securityTypes';
import styles from './SecurityFindings.module.css';

interface Props {
  ownKey: MeshcoreFindings['ownKey'];
  /** Show the acknowledge button (needs `security:write`). */
  canAcknowledge: boolean;
  acknowledging?: boolean;
  onAcknowledge: () => void;
}

/**
 * Own-key change card. Renders only while an unacknowledged change record
 * exists; it stays until a `security:write` user acknowledges it.
 */
export const OwnKeyChangeCard: React.FC<Props> = ({ ownKey, canAcknowledge, acknowledging = false, onAcknowledge }) => {
  const { t } = useTranslation();
  if (!ownKey.detectedAt || !ownKey.previousKey) return null;
  return (
    <section className={styles.card} role="alert" data-testid="security-own-key-change">
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>
          <UiIcon name="securityAlert" size={18} />
          {t('security.mc_own_key_title', 'This device changed its public key')}
        </h3>
        {canAcknowledge && (
          <button type="button" className={styles.button} onClick={onAcknowledge} disabled={acknowledging}>
            {t('security.mc_own_key_acknowledge', 'Acknowledge')}
          </button>
        )}
      </div>
      <p className={styles.cardBody}>
        {t(
          'security.mc_own_key_body',
          'The identity this source reports is not the one MeshMonitor saw before. Other nodes that trust the old key will not recognise this device until they learn the new one.',
        )}
      </p>
      <dl className={styles.keyRows}>
        <dt>{t('security.mc_own_key_previous', 'Previous key')}</dt>
        <dd>{ownKey.previousKey}</dd>
        <dt>{t('security.mc_own_key_current', 'Current key')}</dt>
        <dd>{ownKey.currentKey ?? '-'}</dd>
        <dt>{t('security.mc_own_key_detected', 'Detected')}</dt>
        <dd>{new Date(ownKey.detectedAt).toLocaleString()}</dd>
      </dl>
      {ownKey.pkiKeyMismatch && (
        <p className={styles.note}>
          {t('security.mc_own_key_pki_note', 'The stored direct-message key belongs to the previous identity.')}
        </p>
      )}
    </section>
  );
};
