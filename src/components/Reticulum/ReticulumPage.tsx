/**
 * ReticulumPage — multi-pane Reticulum monitor view (#3960 Phase 1b WP2).
 *
 * Layout (mirrors `MeshCorePage`):
 *   ┌─ status bar (connected / mode / counts) ─────────┐
 *   ├─┬──────────────────────────────────────────────────┤
 *   │ │  ReticulumSubToolbar  │  current view            │
 *   │ │  (narrow, expandable) │  (destinations/dms/       │
 *   │ │                       │   interfaces/info/       │
 *   │ │                       │   settings)               │
 *   └─┴──────────────────────────────────────────────────┘
 *
 * Talks to /api/sources/:id/reticulum/* via `useReticulum` (WP1, extended
 * Phase 2 WP5 with LXMF conversations/messages). The view slots below are
 * stubs turned real components across several work packages: WP3
 * (`ReticulumDestinationsView`), WP4 (`ReticulumInterfacesView`), and WP5
 * (`ReticulumInfoView`, `ReticulumSettingsView`, `ReticulumDmsView`) drop
 * their real components into the marked seams without needing to touch this
 * file's structure.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useReticulum } from './hooks/useReticulum';
import { ReticulumSubToolbar } from './ReticulumSubToolbar';
import { ReticulumDestinationsView } from './ReticulumDestinationsView';
import { ReticulumInterfacesView } from './ReticulumInterfacesView';
import { ReticulumDmsView } from './ReticulumDmsView';
import { ReticulumInfoView } from './ReticulumInfoView';
import { ReticulumSettingsView } from './ReticulumSettingsView';
import { ReticulumMap } from './ReticulumMap';
import { ReticulumConfigurationView } from './ReticulumConfigurationView';
import { ReticulumPathsView } from './ReticulumPathsView';
import { SaveBarProvider, SaveBarGroup } from '../../contexts/SaveBarContext';
import { SaveBar } from '../SaveBar';
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

export const ReticulumPage: React.FC<ReticulumPageProps> = ({ baseUrl, sourceId, enabled, onStatusChange }) => {
  const { t } = useTranslation();
  const {
    status, destinations, interfaces, loading, error, refresh, toggleFavorite,
    conversations, conversationsLoading, activePeerHash, messages, messagesLoading, hasMoreMessages,
    loadConversation, loadMoreMessages, sendMessage, identity,
    paths, probeResult, probingHash, probe, remoteStatus, remoteStatusLoading, queryRemoteStatus,
  } = useReticulum({ sourceId, enabled });

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
          sourceMode={status?.mode ?? null}
        />
        <div className={styles.content}>
          {view === 'destinations' && (
            <ReticulumDestinationsView
              destinations={destinations}
              onToggleFavorite={toggleFavorite}
              loading={loading}
            />
          )}
          {view === 'dms' && (
            <ReticulumDmsView
              sourceId={sourceId}
              conversations={conversations}
              conversationsLoading={conversationsLoading}
              activePeerHash={activePeerHash}
              messages={messages}
              messagesLoading={messagesLoading}
              hasMoreMessages={hasMoreMessages}
              identity={identity}
              destinations={destinations}
              onSelectConversation={loadConversation}
              onLoadMoreMessages={loadMoreMessages}
              onSend={sendMessage}
            />
          )}
          {view === 'interfaces' && (
            <ReticulumInterfacesView
              interfaces={interfaces}
              baseUrl={baseUrl}
              sourceId={sourceId}
              loading={loading}
            />
          )}
          {view === 'paths' && (
            <ReticulumPathsView
              paths={paths}
              loading={loading}
              probeResult={probeResult}
              probingHash={probingHash}
              onProbe={probe}
              remoteStatus={remoteStatus}
              remoteStatusLoading={remoteStatusLoading}
              onQueryRemoteStatus={queryRemoteStatus}
            />
          )}
          {view === 'map' && (
            <ReticulumMap destinations={destinations} paths={paths} loading={loading} />
          )}
          {view === 'configuration' && (
            <ReticulumConfigurationView sourceId={sourceId} />
          )}
          {view === 'info' && (
            <ReticulumInfoView status={status} loading={loading} />
          )}
          {view === 'settings' && (
            <SaveBarProvider>
              <SaveBarGroup id="reticulum-settings">
                <ReticulumSettingsView sourceId={sourceId} />
              </SaveBarGroup>
              <SaveBar />
            </SaveBarProvider>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReticulumPage;
