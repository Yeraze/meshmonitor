/**
 * MeshCorePage — multi-pane MeshCore monitor view.
 *
 * Layout:
 *   ┌─ MeshCoreStatusBar ─────────────────────────────┐
 *   │ (connect / disconnect / status)                 │
 *   ├─┬───────────────────────────────────────────────┤
 *   │ │   MeshCoreSubToolbar  │  current view         │
 *   │ │   (narrow, expandable)│  (nodes/channels/dms/ │
 *   │ │                       │   config/settings)    │
 *   └─┴───────────────────────────────────────────────┘
 *
 * Talks to /api/sources/:id/meshcore/* via useMeshCore.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTxStatus } from '../../hooks/useTxStatus';
import { useMeshCore, ConnectionStatus } from './hooks/useMeshCore';
import { useMeshCoreUnread } from './hooks/useMeshCoreUnread';
import {
  useMeshCoreIgnoredNodes,
  useHiddenMeshCoreKeys,
  useSetMeshCoreIgnoredNode,
  useRemoveMeshCoreIgnoredNode,
  type MeshCoreFilterMode,
} from '../../hooks/useMeshCoreFilters';
import { useReadStateSync } from './hooks/useReadStateSync';
import { MeshCoreStatusBar } from './MeshCoreStatusBar';
import { MeshCoreSubToolbar, MeshCoreView } from './MeshCoreSubToolbar';
import { readSidebarPinned, useSidebarPin } from '../nav/useSidebarPin';
import { MeshCoreNodesView } from './MeshCoreNodesView';
import { MeshCoreChannelsView } from './MeshCoreChannelsView';
import { MeshCoreDirectMessagesView } from './MeshCoreDirectMessagesView';
import { MeshCoreInfoView } from './MeshCoreInfoView';
import { MeshCoreTelemetryView } from './MeshCoreTelemetryView';
import { MeshCorePacketMonitorView } from './MeshCorePacketMonitorView';
import { MeshCoreConfigurationView } from './MeshCoreConfigurationView';
import { MeshCoreSettingsView } from './MeshCoreSettingsView';
import { MeshCoreRoomsView } from './MeshCoreRoomsView';
import { MeshCoreAutomationsView } from './MeshCoreAutomationsView';
import NotificationsTab from '../NotificationsTab';
import { useAuth } from '../../contexts/AuthContext';
import { SaveBarProvider, SaveBarGroup } from '../../contexts/SaveBarContext';
import { useOptionalChannelMuteSettings } from '../../contexts/SettingsContext';
import { SaveBar } from '../SaveBar';
import './MeshCoreTab.css';
import './MeshCorePage.css';
// The automation views (auto-ack, auto-announce, auto-responder, timer
// triggers) lean on the shared settings stylesheet — .setting-item,
// .setting-input, .automation-section-header. Without this import the
// form controls render unstyled.
import '../../styles/settings.css';
import './MeshCoreAutomation.css';

// MeshCoreDeviceType.COMPANION — active node discovery is companion-only
// (same gate as MeshCoreSettingsView).
const DEVICE_TYPE_COMPANION = 1;
const DEVICE_TYPE_REPEATER = 2;

interface MeshCorePageProps {
  baseUrl: string;
  /** Source UUID — routes the hook through /api/sources/:id/meshcore/*. */
  sourceId: string;
  /** When false, the hook is disabled (no polling). Used for permission gating. */
  enabled?: boolean;
  /** When provided, the parent renders the connection chip in its own header
   *  and the inline status bar suppresses its duplicate "Connected to X" text. */
  onStatusChange?: (status: ConnectionStatus | null) => void;
}

export const MeshCorePage: React.FC<MeshCorePageProps> = ({ baseUrl, sourceId, enabled, onStatusChange }) => {
  const { t } = useTranslation();
  const { authStatus } = useAuth();
  const isAdmin = authStatus?.user?.isAdmin ?? false;
  const meshCore = useMeshCore({ baseUrl, sourceId, enabled });
  const { status, nodes, contacts, messages, loading, hasLoadedOnce, error, actions } = meshCore;

  // MeshCore strict receive-only mode (#4547 Phase 2 WP1). Phase 1 made
  // GET /api/device/tx-status MeshCore-aware, so `isTxDisabled` for a
  // MeshCore sourceId already means "receive-only is on" — no separate hook
  // needed (see MESHCORE_RECEIVE_ONLY_PHASE2_SPEC.md §3.0). Called exactly
  // once here and threaded down as a plain boolean prop; every consumer
  // shares the same TanStack cache entry, so the toggle save's
  // `invalidateQueries({ queryKey: ['txStatus'] })` updates them all in one
  // tick with no page reload.
  const { isTxDisabled: receiveOnly } = useTxStatus({ baseUrl, sourceId });

  const [view, setView] = useState<MeshCoreView>('nodes');
  // Same Pin sidebar behaviour as the Meshtastic sidebar (#5481): one global
  // pin, the nav starts expanded when pinned, and an unpinned nav collapses
  // after a nav click.
  const { isPinned: navPinned, togglePin: toggleNavPin } = useSidebarPin();
  const [toolbarExpanded, setToolbarExpanded] = useState(readSidebarPinned);
  const selectView = useCallback((next: MeshCoreView) => {
    setView(next);
    if (!navPinned) setToolbarExpanded(false);
  }, [navPinned]);
  const handleToggleNavPin = useCallback(() => {
    if (toggleNavPin()) setToolbarExpanded(true);
  }, [toggleNavPin]);
  const [pendingDmContact, setPendingDmContact] = useState<string | null>(null);

  // Wire the durable per-user read-state transport once per mounted source
  // (#4607). The store is deliberately fetch-free so it can stay a plain
  // module; this is the single place that gives it a CSRF-aware fetcher and
  // pulls the server snapshot into its synchronous cache.
  useReadStateSync({ sourceId });

  // Unread red-dots for the Channels + Node Details (DMs) sidebar icons (#3891).
  // Ignore / Block (#5408): nodes with an entry are hidden from the node list,
  // the map and Node Details. Adverts still update their rows server-side;
  // only display is suppressed. One place, so all three views agree.
  const ignoredNodesQuery = useMeshCoreIgnoredNodes(sourceId, { enabled: enabled ?? true });
  const hiddenKeys = useHiddenMeshCoreKeys(ignoredNodesQuery.data);
  const visibleNodes = useMemo(
    () => (hiddenKeys.size === 0 ? nodes : nodes.filter((n) => !hiddenKeys.has(n.publicKey.toLowerCase()))),
    [nodes, hiddenKeys],
  );
  const visibleContacts = useMemo(
    () => (hiddenKeys.size === 0 ? contacts : contacts.filter((c) => !hiddenKeys.has(c.publicKey.toLowerCase()))),
    [contacts, hiddenKeys],
  );
  const { mutateAsync: setIgnoredNodeAsync } = useSetMeshCoreIgnoredNode(sourceId);
  const { mutateAsync: removeIgnoredNodeAsync } = useRemoveMeshCoreIgnoredNode(sourceId);
  const handleSetIgnoredNode = useCallback(
    (publicKey: string, mode: MeshCoreFilterMode, name: string | null) =>
      setIgnoredNodeAsync({ publicKey, mode, name }),
    [setIgnoredNodeAsync],
  );
  const handleRemoveIgnoredNode = useCallback(
    (publicKey: string) => removeIgnoredNodeAsync(publicKey),
    [removeIgnoredNodeAsync],
  );

  // Muted channels never light the sidebar Channels dot (#5487).
  const channelMute = useOptionalChannelMuteSettings();
  const unread = useMeshCoreUnread({
    baseUrl,
    sourceId,
    messages,
    contacts,
    selfKey: status?.localNode?.publicKey,
    enabled: enabled ?? true,
    isChannelMuted: channelMute?.isChannelMuted,
  });

  const navigateToDm = useCallback((publicKey: string) => {
    setPendingDmContact(publicKey);
    setView('dms');
  }, []);

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  useEffect(() => {
    if (view !== 'dms') setPendingDmContact(null);
  }, [view]);

  return (
    <div className="meshcore-page">
      <MeshCoreStatusBar
        status={status}
        loading={loading}
        onOpenSettings={() => setView('settings')}
        actions={actions}
        hideConnectionText={!!onStatusChange}
        receiveOnly={receiveOnly}
      />

      {error && (
        <div className="meshcore-error-bar">
          <span>{error}</span>
          <button onClick={actions.clearError}>
            {t('common.dismiss', 'Dismiss')}
          </button>
        </div>
      )}

      <div className="meshcore-page-body">
        <MeshCoreSubToolbar
          view={view}
          onSelect={selectView}
          expanded={toolbarExpanded}
          onToggleExpanded={() => setToolbarExpanded(v => !v)}
          pinned={navPinned}
          onTogglePin={handleToggleNavPin}
          showInfo
          unread={{ channels: unread.channels, dms: unread.dms }}
        />
        <div className="meshcore-content">
          {view === 'nodes' && (
            <MeshCoreNodesView
              nodes={visibleNodes}
              contacts={visibleContacts}
              onImportContact={actions.importContact}
              onNavigateToDm={navigateToDm}
              onToggleFavorite={actions.setNodeFavorite}
              onDiscoverNodes={actions.discoverNodes}
              canDiscover={(status?.connected ?? false) && status?.deviceType === DEVICE_TYPE_COMPANION}
              mapIsLoading={!hasLoadedOnce}
              receiveOnly={receiveOnly}
              isRepeaterSource={status?.deviceType === DEVICE_TYPE_REPEATER}
            />
          )}
          {view === 'channels' && (
            <MeshCoreChannelsView
              messages={messages}
              contacts={contacts}
              status={status}
              actions={actions}
              baseUrl={baseUrl}
              sourceId={sourceId}
              onNodeNameClick={navigateToDm}
              receiveOnly={receiveOnly}
            />
          )}
          {view === 'rooms' && (
            <MeshCoreRoomsView
              messages={messages}
              contacts={contacts}
              status={status}
              actions={actions}
              baseUrl={baseUrl}
              sourceId={sourceId}
              onNodeNameClick={navigateToDm}
              receiveOnly={receiveOnly}
            />
          )}
          {view === 'dms' && (
            <MeshCoreDirectMessagesView
              messages={messages}
              contacts={contacts}
              nodes={nodes}
              status={status}
              actions={actions}
              baseUrl={baseUrl}
              sourceId={sourceId}
              initialSelectedContact={pendingDmContact}
              receiveOnly={receiveOnly}
              ignoredNodes={ignoredNodesQuery.data}
              onSetIgnoredNode={handleSetIgnoredNode}
              onRemoveIgnoredNode={handleRemoveIgnoredNode}
            />
          )}
          {view === 'telemetry' && (
            <MeshCoreTelemetryView baseUrl={baseUrl} />
          )}
          {view === 'packets' && (
            <MeshCorePacketMonitorView
              baseUrl={baseUrl}
              sourceId={sourceId}
              isRepeaterSource={status?.deviceType === DEVICE_TYPE_REPEATER}
            />
          )}
          {view === 'info' && (
            <MeshCoreInfoView baseUrl={baseUrl} sourceId={sourceId} status={status} onSyncTime={actions.syncDeviceTime} />
          )}
          {view === 'configuration' && (
            <MeshCoreConfigurationView
              status={status}
              actions={actions}
              baseUrl={baseUrl}
              sourceId={sourceId}
              receiveOnly={receiveOnly}
            />
          )}
          {view === 'automations' && (
            <SaveBarProvider>
              <SaveBarGroup id="meshcore-automation">
                <MeshCoreAutomationsView
                  baseUrl={baseUrl}
                  sourceId={sourceId}
                  receiveOnly={receiveOnly}
                />
              </SaveBarGroup>
              <SaveBar />
            </SaveBarProvider>
          )}
          {view === 'notifications' && (
            <div className="meshcore-notifications-view">
              <NotificationsTab isAdmin={isAdmin} />
            </div>
          )}
          {view === 'settings' && (
            <SaveBarProvider>
              <SaveBarGroup id="meshcore-settings">
                <MeshCoreSettingsView
                  status={status}
                  loading={loading}
                  actions={actions}
                  baseUrl={baseUrl}
                  sourceId={sourceId}
                  receiveOnly={receiveOnly}
                />
              </SaveBarGroup>
              <SaveBar />
            </SaveBarProvider>
          )}
        </div>
      </div>
    </div>
  );
};

export default MeshCorePage;
