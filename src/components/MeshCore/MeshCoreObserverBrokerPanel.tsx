/**
 * MeshCore Analyzer Observer — per-broker status panel (#5014 Phase 2 WP3
 * §4.7). Mounted by MeshCoreObserverSection immediately after block [A] (the
 * aggregate publish-status summary): block [A] stays the aggregate, this is
 * its per-broker breakdown.
 *
 * D-6 silence convention: renders nothing when the status hasn't loaded yet,
 * when the request failed, or when the source has no configured brokers —
 * none of those are errors worth a visible complaint on a status surface.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '../../utils/datetime';
import { UiIcon } from '../icons';
import { useObserverStatus } from './hooks/useObserverStatus';
import sectionStyles from './MeshCoreObserverSection.module.css';
import styles from './MeshCoreObserverBrokerPanel.module.css';

export interface MeshCoreObserverBrokerPanelProps {
  sourceId: string;
  /** Parent has already checked configuration:read; false suspends polling. */
  enabled?: boolean;
}

export const MeshCoreObserverBrokerPanel: React.FC<MeshCoreObserverBrokerPanelProps> = ({
  sourceId,
  enabled = true,
}) => {
  const { t } = useTranslation();
  const { status, error } = useObserverStatus(sourceId, { enabled });

  if (error) return null;
  if (!status || !Array.isArray(status.brokers) || status.brokers.length === 0) return null;

  return (
    <div className={sectionStyles.section}>
      <h4>{t('meshcore.observer.brokers_heading', 'Brokers')}</h4>

      {status.running === false && (
        <p className={sectionStyles.hint}>
          {t(
            'meshcore.observer.publisher_not_running',
            'Publisher not running — showing configured brokers.',
          )}
        </p>
      )}

      <div className={styles.brokerList}>
        {status.brokers.map((broker) => (
          <div key={broker.key} className={styles.brokerCard}>
            <div className={styles.brokerTitle}>{broker.label ?? broker.url}</div>
            {broker.label && <div className={styles.brokerUrl}>{broker.url}</div>}

            <div className={sectionStyles.statusValue}>
              <UiIcon name={broker.connected ? 'statusOn' : 'statusOff'} size={14} />{' '}
              {broker.connected
                ? t('meshcore.observer.status_connected', 'Connected to broker')
                : t('meshcore.observer.status_disconnected', 'Not connected to broker')}
            </div>

            {!broker.configured && (
              <div className={`${sectionStyles.statusValue} ${sectionStyles.warning}`} role="alert">
                {t(
                  'meshcore.observer.broker_not_configured',
                  "This broker's URL, region, or audience is incomplete.",
                )}
              </div>
            )}

            {!broker.keyStored && (
              <div className={`${sectionStyles.statusValue} ${sectionStyles.warning}`} role="alert">
                {broker.authMode === 'password'
                  ? t(
                      'meshcore.observer.no_credentials_running',
                      'No usable broker username/password — the publisher will not connect. Enter them below.',
                    )
                  : t(
                      'meshcore.observer.no_key_running',
                      'No usable signing key — the publisher will not connect. Import or paste one below.',
                    )}
              </div>
            )}

            <div className={sectionStyles.statusGrid}>
              <div className={sectionStyles.statusLabel}>
                {t('meshcore.observer.published_count', 'Packets published')}
              </div>
              <div className={sectionStyles.statusValue}>{broker.publishes}</div>

              <div className={sectionStyles.statusLabel}>
                {t('meshcore.observer.dropped_count', 'Packets dropped')}
              </div>
              <div className={sectionStyles.statusValue}>
                {broker.dropped}
                {broker.dropped > 0 && (
                  <span className={sectionStyles.hint}>
                    {' '}
                    {t('meshcore.observer.dropped_help', 'Packets heard while the broker socket was down.')}
                  </span>
                )}
              </div>

              <div className={sectionStyles.statusLabel}>{t('meshcore.observer.last_publish', 'Last publish')}</div>
              <div className={sectionStyles.statusValue}>
                {broker.lastPublishAt ? formatRelativeTime(broker.lastPublishAt) : t('common.never', 'Never')}
              </div>

              {/* Static credentials never expire, so the row is meaningless in
                  password mode — mirrors block [A]. tokenExpiresAt is unix
                  SECONDS; lastPublishAt above is already milliseconds. */}
              {broker.authMode !== 'password' && (
                <>
                  <div className={sectionStyles.statusLabel}>
                    {t('meshcore.observer.token_expires', 'Auth token expires')}
                  </div>
                  <div className={sectionStyles.statusValue}>
                    {broker.tokenExpiresAt ? new Date(broker.tokenExpiresAt * 1000).toLocaleString() : '—'}
                  </div>
                </>
              )}
            </div>

            {broker.lastError && (
              <div className={`${sectionStyles.statusValue} ${sectionStyles.error}`} role="alert">
                <UiIcon name="alert" size={14} /> {t('meshcore.observer.last_error', 'Last error')}: {broker.lastError}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
