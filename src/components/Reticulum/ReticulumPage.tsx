/**
 * ReticulumPage — multi-pane Reticulum monitor view (#3960 Phase 1b WP2).
 *
 * Layout (mirrors `MeshCorePage`):
 *   ┌─ status bar (connected / mode / counts) ─────────┐
 *   ├─┬──────────────────────────────────────────────────┤
 *   │ │  ReticulumSubToolbar  │  current view            │
 *   │ │  (narrow, expandable) │  (destinations/interfaces/│
 *   │ │                       │   info/settings)          │
 *   └─┴──────────────────────────────────────────────────┘
 *
 * Talks to /api/sources/:id/reticulum/* via `useReticulum` (WP1). The four
 * view slots below are stubs — WP3 (`ReticulumDestinationsView`), WP4
 * (`ReticulumInterfacesView`), and WP5 (`ReticulumInfoView` +
 * `ReticulumSettingsView`) drop their real components into the marked seams
 * without needing to touch this file's structure.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useReticulum } from './hooks/useReticulum';
import { ReticulumSubToolbar } from './ReticulumSubToolbar';
import type { ReticulumStatus, ReticulumView } from '../../types/reticulum';
import { UiIcon } from '../icons';
import styles from './ReticulumPage.module.css';

interface ReticulumPageProps {
  baseUrl: string;
  /** Source UUID — routes the hook through /api/sources/:id/reticulum/*. */
  sourceId: string;
  /** When false, the hook is disabled (no polling). Used for permission gating. */
  enabled?: boolean;
  /** When provided, the parent renders its own connection chip (see
   *  `ReticulumSourcePage`'s topbar) and can mirror this page's status. */
  onStatusChange?: (status: ReticulumStatus | null) => void;
}

export const ReticulumPage: React.FC<ReticulumPageProps> = ({ baseUrl: _baseUrl, sourceId, enabled, onStatusChange }) => {
  const { t } = useTranslation();
  const { status, destinations, interfaces, loading, error, refresh } = useReticulum({ sourceId, enabled });

  const [view, setView] = useState<ReticulumView>('destinations');
  const [toolbarExpanded, setToolbarExpanded] = useState(false);

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  const connected = status?.connected ?? false;

  return (
    <div className={styles.page}>
      <div className={styles.statusBar}>
        <div className={styles.statusBarLeft}>
          <span className={`${styles.statusDot} ${connected ? styles.statusDotConnected : ''}`} />
          <span className={styles.statusText}>
            {status === null
              ? t('reticulum.status.connecting', 'Connecting…')
              : connected
                ? t('reticulum.status.connected', 'Connected')
                : t('reticulum.status.disconnected', 'Disconnected')}
          </span>
          {status?.mode && (
            <span className={styles.statusMeta}>{status.mode}</span>
          )}
          {status && (
            <span className={styles.statusMeta}>
              {t('reticulum.status.counts', '{{destinations}} destinations · {{interfaces}} interfaces', {
                destinations: status.destinationCount,
                interfaces: status.interfaceCount,
              })}
            </span>
          )}
        </div>
        <div className={styles.statusBarRight}>
          <button onClick={() => void refresh()} disabled={loading} title={t('common.refresh', 'Refresh')}>
            <UiIcon name="refresh" size={14} />
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.errorBar}>
          <span>{error}</span>
          <button onClick={() => void refresh()}>{t('common.retry', 'Retry')}</button>
        </div>
      )}

      <div className={styles.pageBody}>
        <ReticulumSubToolbar
          view={view}
          onSelect={setView}
          expanded={toolbarExpanded}
          onToggleExpanded={() => setToolbarExpanded(v => !v)}
        />
        <div className={styles.content}>
          {view === 'destinations' && (
            /* WP3: ReticulumDestinationsView */
            <div className={styles.placeholder}>
              {t('reticulum.destinations.placeholder', '{{count}} destinations', { count: destinations.length })}
            </div>
          )}
          {view === 'interfaces' && (
            /* WP4: ReticulumInterfacesView */
            <div className={styles.placeholder}>
              {t('reticulum.interfaces.placeholder', '{{count}} interfaces', { count: interfaces.length })}
            </div>
          )}
          {view === 'info' && (
            /* WP5: ReticulumInfoView */
            <div className={styles.placeholder}>
              {status
                ? t('reticulum.info.placeholder', 'connected={{connected}} mode={{mode}}', {
                    connected: status.connected,
                    mode: status.mode ?? 'unknown',
                  })
                : t('reticulum.info.loading', 'Loading status…')}
            </div>
          )}
          {view === 'settings' && (
            /* WP5: ReticulumSettingsView */
            <div className={styles.placeholder}>
              {t('reticulum.settings.placeholder', 'Settings')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReticulumPage;
