/**
 * ReticulumPathsView — path-table + probe + remote-fleet monitoring for a
 * Reticulum source (#3960 Phase 4 WP4).
 *
 * Template: `ReticulumInterfacesView.tsx` / `ReticulumDestinationsView.tsx`
 * (table layout, CSS module with semantic `--color-*` tokens only, inline
 * `t(key, fallback)` i18n, mono hash styling).
 *
 * Two surfaces:
 *  - A path table (destination -> via/next hop -> via-interface -> hops ->
 *    age), with a per-row "Probe" action (rnprobe-style reachability check,
 *    `nodes:write` gated — mirrors the backend's `POST /paths/probe` guard).
 *  - A remote-fleet panel: enter/select a destination hash and query its
 *    Transport Node `/status` + `/path` on demand (`nodes:read`, same as the
 *    rest of this page — no additional gate). There is no server-exposed
 *    list of configured remote targets in Phase 4 (`remoteAllowed` lives in
 *    `sources.config`, forwarded to the bridge, and is never echoed back on
 *    `GET /status` — build spec §4.2's documented fallback), so this is a
 *    free-text hash entry rather than a picker.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReticulumPathRow, ReticulumProbeResult, ReticulumRemoteStatus } from '../../types/reticulum';
import { useSettings } from '../../contexts/SettingsContext';
import { useAuth } from '../../contexts/AuthContext';
import { formatRelativeTime } from '../../utils/datetime';
import { UiIcon } from '../icons';
import styles from './ReticulumPathsView.module.css';

export interface ReticulumPathsViewProps {
  paths: ReticulumPathRow[];
  loading?: boolean;
  probeResult: ReticulumProbeResult | null;
  probingHash: string | null;
  onProbe: (destinationHash: string, timeoutS?: number) => Promise<ReticulumProbeResult | null>;
  remoteStatus: ReticulumRemoteStatus | null;
  remoteStatusLoading: boolean;
  onQueryRemoteStatus: (destinationHash: string, timeoutS?: number) => Promise<ReticulumRemoteStatus | null>;
}

function truncateHash(hash: string): string {
  return hash.length > 12 ? `${hash.substring(0, 12)}…` : hash;
}

export const ReticulumPathsView: React.FC<ReticulumPathsViewProps> = ({
  paths,
  loading = false,
  probeResult,
  probingHash,
  onProbe,
  remoteStatus,
  remoteStatusLoading,
  onQueryRemoteStatus,
}) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat } = useSettings();
  const { hasPermission } = useAuth();
  const canProbe = hasPermission('nodes', 'write');

  const [remoteHashInput, setRemoteHashInput] = useState('');

  const handleQuery = () => {
    const hash = remoteHashInput.trim();
    if (hash.length === 0) return;
    void onQueryRemoteStatus(hash);
  };

  return (
    <div className={styles.view} data-testid="reticulum-paths-view">
      <section className={styles.tableSection}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('reticulum.paths.col_destination', 'Destination')}</th>
                <th>{t('reticulum.paths.col_via', 'Via')}</th>
                <th>{t('reticulum.paths.col_interface', 'Interface')}</th>
                <th>{t('reticulum.paths.col_hops', 'Hops')}</th>
                <th>{t('reticulum.paths.col_age', 'Age')}</th>
                {canProbe && <th>{t('reticulum.paths.col_probe', 'Probe')}</th>}
              </tr>
            </thead>
            <tbody>
              {paths.length === 0 ? (
                <tr>
                  <td colSpan={canProbe ? 6 : 5} className={styles.emptyState}>
                    {loading
                      ? t('reticulum.paths.loading', 'Loading paths…')
                      : t('reticulum.paths.empty', 'No paths reported yet.')}
                  </td>
                </tr>
              ) : paths.map(row => {
                const isProbing = probingHash === row.destinationHash;
                const result = probeResult?.destinationHash === row.destinationHash ? probeResult : null;
                return (
                  <tr key={row.destinationHash} data-testid={`reticulum-path-row-${row.destinationHash}`}>
                    <td>
                      <span className={styles.hashText} title={row.destinationHash}>
                        {truncateHash(row.destinationHash)}
                      </span>
                    </td>
                    <td>
                      {row.viaHash ? (
                        <span className={styles.hashText} title={row.viaHash}>
                          {truncateHash(row.viaHash)}
                        </span>
                      ) : '—'}
                    </td>
                    <td>{row.interfaceName ?? '—'}</td>
                    <td>{row.hops ?? '—'}</td>
                    <td>{formatRelativeTime(row.updatedAt, timeFormat, dateFormat)}</td>
                    {canProbe && (
                      <td className={styles.probeCell}>
                        <button
                          type="button"
                          className={styles.probeBtn}
                          disabled={isProbing}
                          onClick={() => void onProbe(row.destinationHash)}
                          title={t('reticulum.paths.probe_action', 'Probe {{hash}}', { hash: truncateHash(row.destinationHash) })}
                        >
                          <UiIcon name="test" size={13} />
                          {isProbing
                            ? t('reticulum.paths.probing', 'Probing…')
                            : t('reticulum.paths.probe', 'Probe')}
                        </button>
                        {result && (
                          <span
                            className={`${styles.probeResult} ${result.ok ? styles.probeResultOk : styles.probeResultFail}`}
                            data-testid={`reticulum-path-probe-result-${row.destinationHash}`}
                          >
                            <UiIcon name={result.ok ? 'statusOn' : 'error'} size={11} />
                            {result.ok
                              ? t('reticulum.paths.probe_ok', '{{rtt}}ms · {{hops}} hops', {
                                  rtt: result.rttMs ?? '—',
                                  hops: result.hops ?? '—',
                                })
                              : t('reticulum.paths.probe_fail', '{{error}}', { error: result.error ?? t('reticulum.paths.probe_no_reply', 'No reply') })}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.remotePanel} data-testid="reticulum-remote-status-panel">
        <h3 className={styles.remoteTitle}>
          <UiIcon name="radioSignal" size={15} />
          {t('reticulum.paths.remote_title', 'Remote Fleet')}
        </h3>
        <p className={styles.remoteHint}>
          {t('reticulum.paths.remote_hint', 'Query a remote Transport Node’s status and path table on demand. Nothing here is stored.')}
        </p>
        <div className={styles.remoteForm}>
          <input
            type="text"
            className={styles.remoteInput}
            value={remoteHashInput}
            onChange={e => setRemoteHashInput(e.target.value)}
            placeholder={t('reticulum.paths.remote_placeholder', 'Destination hash…')}
            aria-label={t('reticulum.paths.remote_placeholder', 'Destination hash…')}
          />
          <button
            type="button"
            className={styles.remoteQueryBtn}
            disabled={remoteStatusLoading || remoteHashInput.trim().length === 0}
            onClick={handleQuery}
          >
            <UiIcon name="search" size={13} />
            {remoteStatusLoading
              ? t('reticulum.paths.remote_querying', 'Querying…')
              : t('reticulum.paths.remote_query', 'Query')}
          </button>
        </div>

        {remoteStatus && (
          <div className={styles.remoteResult} data-testid="reticulum-remote-status-result">
            {remoteStatus.ok ? (
              <>
                <span className={styles.remoteResultOk}>
                  <UiIcon name="statusOn" size={12} />
                  {t('reticulum.paths.remote_ok', '{{hash}} is reachable', { hash: truncateHash(remoteStatus.destinationHash) })}
                </span>
                <span className={styles.remoteResultDetail}>
                  {t('reticulum.paths.remote_interfaces', '{{count}} interface(s)', {
                    count: remoteStatus.status?.interfaces.length ?? 0,
                  })}
                  {' · '}
                  {t('reticulum.paths.remote_links', '{{count}} link(s)', { count: remoteStatus.status?.linkCount ?? 0 })}
                  {' · '}
                  {t('reticulum.paths.remote_paths', '{{count}} known path(s)', { count: remoteStatus.path?.length ?? 0 })}
                </span>
              </>
            ) : (
              <span className={styles.remoteResultFail}>
                <UiIcon name="error" size={12} />
                {remoteStatus.error ?? t('reticulum.paths.remote_unreachable', 'No response from remote node')}
              </span>
            )}
          </div>
        )}
      </section>
    </div>
  );
};

export default ReticulumPathsView;
