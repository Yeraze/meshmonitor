/**
 * ReticulumInfoView — status/health panel for a Reticulum source (#3960
 * Phase 1b WP5).
 *
 * R2 (build spec §0, "log-tail DESCOPE, INCLUDE WP-B"): no `CliConsoleBody`
 * bridge-log tail — there is no bridge log protocol/route for one to back
 * onto, and `CliConsoleBody` is a command console, not a tailer. This view
 * is a read-only summary of the most recently polled `/status` snapshot
 * (`useReticulum`, 30s cadence — R4 "no realtime"): connected state, attach
 * `mode`, interface/destination counts, and the RNS daemon / bridge version
 * strings WP-B cached from the bridge's last `welcome`/`status` frame. No
 * transport ID (Phase 3, R2).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ReticulumStatus } from '../../types/reticulum';
import { UiIcon } from '../icons';
import styles from './ReticulumInfoView.module.css';

interface ReticulumInfoViewProps {
  status: ReticulumStatus | null;
  loading?: boolean;
}

export const ReticulumInfoView: React.FC<ReticulumInfoViewProps> = ({ status, loading }) => {
  const { t } = useTranslation();

  if (!status) {
    return (
      <div className={styles.view} data-testid="reticulum-info-view">
        <div className={styles.empty}>
          {loading
            ? t('reticulum.info.loading', 'Loading status…')
            : t('reticulum.info.no_status', 'No status available yet.')}
        </div>
      </div>
    );
  }

  const connected = status.connected;
  const modeLabel = status.mode === 'attach'
    ? t('reticulum.info.mode_attach', 'Attach (shared rnsd)')
    : status.mode === 'tcp_peer'
      ? t('reticulum.info.mode_tcp_peer', 'TCP peer')
      : t('reticulum.info.mode_unknown', 'Unknown');

  return (
    <div className={styles.view} data-testid="reticulum-info-view">
      <section className={styles.card} data-testid="reticulum-info-connection">
        <header className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <UiIcon name="info" size={16} />
            <span>{t('reticulum.info.connection', 'Connection')}</span>
          </div>
          <span
            className={`${styles.chip} ${connected ? styles.chipOnline : styles.chipOffline}`}
            data-testid="reticulum-info-status-chip"
          >
            <UiIcon name={connected ? 'statusOn' : 'statusOff'} size={12} />
            {connected
              ? t('reticulum.status.connected', 'Connected')
              : t('reticulum.status.disconnected', 'Disconnected')}
          </span>
        </header>
        <dl className={styles.statGrid}>
          <div className={styles.stat}>
            <dt>
              <UiIcon name="wifi" size={13} />
              {t('reticulum.info.attach_mode', 'Attach mode')}
            </dt>
            <dd data-testid="reticulum-info-mode">{modeLabel}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.card} data-testid="reticulum-info-inventory">
        <header className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <UiIcon name="network" size={16} />
            <span>{t('reticulum.info.inventory', 'Inventory')}</span>
          </div>
        </header>
        <dl className={styles.statGrid}>
          <div className={styles.stat}>
            <dt>
              <UiIcon name="server" size={13} />
              {t('reticulum.info.interfaces', 'Interfaces')}
            </dt>
            <dd data-testid="reticulum-info-interface-count">{status.interfaceCount}</dd>
          </div>
          <div className={styles.stat}>
            <dt>
              <UiIcon name="nodes" size={13} />
              {t('reticulum.info.destinations', 'Destinations')}
            </dt>
            <dd data-testid="reticulum-info-destination-count">{status.destinationCount}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.card} data-testid="reticulum-info-versions">
        <header className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <UiIcon name="code" size={16} />
            <span>{t('reticulum.info.versions', 'Versions')}</span>
          </div>
        </header>
        <dl className={styles.statGrid}>
          <div className={styles.stat}>
            <dt>{t('reticulum.info.rns_version', 'RNS version')}</dt>
            <dd data-testid="reticulum-info-rns-version">{status.rnsVersion ?? '—'}</dd>
          </div>
          <div className={styles.stat}>
            <dt>{t('reticulum.info.bridge_version', 'Bridge version')}</dt>
            <dd data-testid="reticulum-info-bridge-version">
              {status.bridgeVersion ?? t('reticulum.info.version_unknown', 'unknown')}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
};

export default ReticulumInfoView;
