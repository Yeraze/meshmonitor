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
import React, { useCallback, useEffect, useState } from 'react';
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
import { MeshCoreSubToolbar } from './MeshCoreSubToolbar';
import { resolveMeshCoreView, useMeshCoreViewAccess, type MeshCoreView } from './meshCoreViewAccess';
import { readSidebarPinned, useSidebarPin } from '../nav/useSidebarPin';
import { MeshCoreNodesView } from './MeshCoreNodesView';
import { takePendingMeshCoreContact } from '../../utils/meshcoreContactFocus';
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
import { SecurityTab } from '../SecurityTab';
import { useAuth } from '../../contexts/AuthContext';
import { SaveBarProvider, SaveBarGroup } from '../../contexts/SaveBarContext';
import { useOptionalMuteSettings } from '../../contexts/SettingsContext';
import { SaveBar } from '../SaveBar';
import { SourceNavLayout } from '../nav/SourceNavLayout';
import './MeshCoreTab.css';
import './MeshCorePage.css';
import { usePushNotificationNavigation } from '../../hooks/usePushNotificationNavigation';
import { resolveMeshCoreNotificationTarget } from './meshcoreNotificationNav';
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
  onStatusChange?: (status: ConnectionStatus | null, loaded: boolean, connecting: boolean) => void;
}

export const MeshCorePage: React.FC<MeshCorePageProps> = ({ baseUrl, sourceId, enabled, onStatusChange }) => {
  const { t } = useTranslation();
  const { authStatus } = useAuth();
  const isAdmin = authStatus?.user?.isAdmin ?? false;
  const meshCore = useMeshCore({ baseUrl, sourceId, enabled });
  const { status, nodes, contacts, messages, reactionResolutions, loading, hasLoadedOnce, error, actions } = meshCore;

  // MeshCore strict receive-only mode (#4547 Phase 2 WP1). Phase 1 made
  // GET /api/device/tx-status MeshCore-aware, so `isTxDisabled` for a
  // MeshCore sourceId already means "receive-only is on" — no separate hook
  // needed (see MESHCORE_RECEIVE_ONLY_PHASE2_SPEC.md §3.0). Called exactly
  // once here and threaded down as a plain boolean prop; every consumer
  // shares the same TanStack cache entry, so the toggle save's
  // `invalidateQueries({ queryKey: ['txStatus'] })` updates them all in one
  // tick with no page reload.
  const { isTxDisabled: receiveOnly } = useTxStatus({ baseUrl, sourceId });

  // `requestedView` is what was asked for; `view` is what is shown. A tab the
  // viewer has no grant for (#5666) resolves to the Nodes tab instead of a
  // blank pane, whichever way it was asked for: a nav click, the status bar's
  // Connect button, or a jump to Node Details. Derived, so the asked-for tab
  // appears once the grants have loaded.
  // `#configuration` opens straight on Configuration: the source form's
  // Analyzer Observer note links here (#5831).
  const [requestedView, setView] = useState<MeshCoreView>(() =>
    typeof window !== 'undefined' && window.location.hash === '#configuration' ? 'configuration' : 'nodes',
  );
  const visibleViews = useMeshCoreViewAccess();
  const view = resolveMeshCoreView(requestedView, visibleViews);
  const canOpenSettings = visibleViews.includes('settings');
  const canOpenDeviceConfiguration = visibleViews.includes('configuration');
  const openDeviceConfiguration = useCallback(() => setView('configuration'), []);
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
  // Security tab "Send notification" (#6281): a draft for the pending DM
  // contact. Consumed once by the message stream, which seeds its compose
  // draft; never sent for the user.
  const [pendingDmDraft, setPendingDmDraft] = useState<string | null>(null);
  // #5964: Node Details → Show on Map. Same hand-off shape as
  // `pendingDmContact`: set the key, switch to the Nodes view (list + map),
  // and drop the key once the view changes away again.
  const [pendingMapNode, setPendingMapNode] = useState<string | null>(null);

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

  // Muted channels never light the sidebar Channels dot (#5487); muted DM peers and
  // rooms light no dot either (#6261).
  const channelMute = useOptionalMuteSettings();
  const unread = useMeshCoreUnread({
    baseUrl,
    sourceId,
    messages,
    contacts,
    selfKey: status?.localNode?.publicKey,
    enabled: enabled ?? true,
    isChannelMuted: channelMute?.isChannelMuted,
    isDMMuted: channelMute?.isDMMuted,
  });

  const navigateToDm = useCallback((publicKey: string) => {
    setPendingDmContact(publicKey);
    setView('dms');
  }, []);

  // `nodeKey` is `mc:<64-hex>`; open that contact's DM with the draft pre-filled.
  const openDmWithDraft = useCallback((nodeKey: string, draft: string) => {
    setPendingDmContact(nodeKey.startsWith('mc:') ? nodeKey.slice(3) : nodeKey);
    setPendingDmDraft(draft);
    setView('dms');
  }, []);

  const showNodeOnMap = useCallback((publicKey: string) => {
    setPendingMapNode(publicKey);
    setView('nodes');
  }, []);

  useEffect(() => {
    // `loaded`: the first snapshot settled. A source with no manager never
    // gets a status, so the header needs this to stop saying "Connecting"
    // (#4173 N6). `connecting`: a connect is in flight — the same test the
    // status bar's "Connecting…" button label uses.
    onStatusChange?.(status, hasLoadedOnce, loading && !status?.connected);
  }, [status, hasLoadedOnce, loading, onStatusChange]);

  useEffect(() => {
    if (view !== 'dms') {
      setPendingDmContact(null);
      setPendingDmDraft(null);
    }
    if (view !== 'nodes') setPendingMapNode(null);
    if (view !== 'channels') setPendingChannelIdx(null);
    if (view !== 'rooms') setPendingRoom(null);
  }, [view]);

  // Deep link from outside the page (Mesh Issues, #6263): select the contact
  // through the same hand-off Show on Map uses. Declared after the view
  // effect above so its pending key is not cleared on the first commit.
  useEffect(() => {
    const key = takePendingMeshCoreContact();
    if (key) showNodeOnMap(key);
  }, [sourceId, showNodeOnMap]);

  // Notification click-through (#6253): open the channel, room or DM the
  // notification was about. Payloads for another source are left alone.
  const { pendingNavigation, clearPendingNavigation } = usePushNotificationNavigation();
  const [pendingChannelIdx, setPendingChannelIdx] = useState<number | null>(null);
  const [pendingRoom, setPendingRoom] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingNavigation) return;
    if (pendingNavigation.sourceId && pendingNavigation.sourceId !== sourceId) return;
    const target = resolveMeshCoreNotificationTarget(pendingNavigation, contacts);
    if (target.kind === 'channel') {
      setPendingChannelIdx(target.channelIdx);
      setView('channels');
    } else if (target.kind === 'room') {
      setPendingRoom(target.publicKey);
      setView('rooms');
    } else if (target.kind === 'dm') {
      navigateToDm(target.publicKey);
    }
    clearPendingNavigation();
  }, [pendingNavigation, sourceId, contacts, navigateToDm, clearPendingNavigation]);

  return (
    <div className="meshcore-page">
      <MeshCoreStatusBar
        status={status}
        loading={loading}
        // Connect lives on the Settings tab. Without that tab, connect directly;
        // POST /connect checks `connection:write` itself.
        onOpenSettings={() => (canOpenSettings ? setView('settings') : void actions.connect())}
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

      {/* Shared with ReticulumPage: SourceNavLayout owns the nav + content
          row, including the phone flip that docks the nav as a bottom bar. */}
      <SourceNavLayout
        contentClassName="meshcore-content"
        nav={(
          <MeshCoreSubToolbar
            view={view}
            onSelect={selectView}
            expanded={toolbarExpanded}
            onToggleExpanded={() => setToolbarExpanded(v => !v)}
            pinned={navPinned}
            onTogglePin={handleToggleNavPin}
            showInfo
            unread={{ channels: unread.channels, dms: unread.dms, rooms: unread.rooms }}
          />
        )}
      >
        {view === 'nodes' && (
          <MeshCoreNodesView
            nodes={nodes}
            contacts={contacts}
            ignoredKeys={hiddenKeys}
            onImportContact={actions.importContact}
            // Contact-share tokens (#6370) need a Companion's contact list.
            onImportContactToken={status?.deviceType === DEVICE_TYPE_COMPANION ? actions.importContactToken : undefined}
            onNavigateToDm={navigateToDm}
            onToggleFavorite={actions.setNodeFavorite}
            onDiscoverNodes={actions.discoverNodes}
            canDiscover={(status?.connected ?? false) && status?.deviceType === DEVICE_TYPE_COMPANION}
            mapIsLoading={!hasLoadedOnce}
            receiveOnly={receiveOnly}
            isRepeaterSource={status?.deviceType === DEVICE_TYPE_REPEATER}
            focusPublicKey={pendingMapNode}
          />
        )}
        {view === 'channels' && (
          <MeshCoreChannelsView
            messages={messages}
            reactionResolutions={reactionResolutions}
            contacts={contacts}
            status={status}
            actions={actions}
            baseUrl={baseUrl}
            sourceId={sourceId}
            onNodeNameClick={navigateToDm}
            receiveOnly={receiveOnly}
            initialChannelIdx={pendingChannelIdx}
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
            initialRoom={pendingRoom}
          />
        )}
        {view === 'dms' && (
          <MeshCoreDirectMessagesView
            messages={messages}
            reactionResolutions={reactionResolutions}
            contacts={contacts}
            nodes={nodes}
            status={status}
            actions={actions}
            baseUrl={baseUrl}
            sourceId={sourceId}
            initialSelectedContact={pendingDmContact}
            initialDraft={pendingDmDraft}
            onInitialDraftConsumed={() => setPendingDmDraft(null)}
            receiveOnly={receiveOnly}
            ignoredNodes={ignoredNodesQuery.data}
            onSetIgnoredNode={handleSetIgnoredNode}
            onRemoveIgnoredNode={handleRemoveIgnoredNode}
            onShowOnMap={showNodeOnMap}
          />
        )}
        {view === 'telemetry' && (
          <MeshCoreTelemetryView baseUrl={baseUrl} currentNodeId={status?.localNode?.publicKey ?? null} />
        )}
        {view === 'packets' && (
          <MeshCorePacketMonitorView
            baseUrl={baseUrl}
            sourceId={sourceId}
            isRepeaterSource={status?.deviceType === DEVICE_TYPE_REPEATER}
            contacts={contacts}
            onNodeClick={navigateToDm}
          />
        )}
        {view === 'info' && (
          <MeshCoreInfoView baseUrl={baseUrl} sourceId={sourceId} status={status} onSyncTime={actions.syncDeviceTime} />
        )}
        {view === 'configuration' && (
          // The Analyzer Observer's broker list saves through the SaveBar (#5831).
          <SaveBarProvider>
            <MeshCoreConfigurationView
              status={status}
              actions={actions}
              baseUrl={baseUrl}
              sourceId={sourceId}
              receiveOnly={receiveOnly}
              loading={loading}
            />
            <SaveBar />
          </SaveBarProvider>
        )}
        {view === 'automations' && (
          <SaveBarProvider>
            <SaveBarGroup id="meshcore-automation">
              <MeshCoreAutomationsView
                baseUrl={baseUrl}
                sourceId={sourceId}
                receiveOnly={receiveOnly}
                isCompanionSource={status?.deviceType === DEVICE_TYPE_COMPANION}
              />
            </SaveBarGroup>
            <SaveBar />
          </SaveBarProvider>
        )}
        {view === 'notifications' && (
          <div className="meshcore-notifications-view">
            <NotificationsTab isAdmin={isAdmin} meshcoreDeviceType={status?.deviceType} />
          </div>
        )}
        {view === 'security' && (
          <SecurityTab
            sourceId={sourceId}
            sourceType="meshcore"
            deviceType={status?.deviceType}
            onOpenNode={navigateToDm}
            onOpenDmWithDraft={openDmWithDraft}
          />
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
                contacts={contacts}
                receiveOnly={receiveOnly}
                canOpenDeviceConfiguration={canOpenDeviceConfiguration}
                onOpenDeviceConfiguration={openDeviceConfiguration}
              />
            </SaveBarGroup>
            <SaveBar />
          </SaveBarProvider>
        )}
      </SourceNavLayout>
    </div>
  );
};

export default MeshCorePage;
