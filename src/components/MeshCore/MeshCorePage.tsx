/**
 * MeshCorePage — multi-pane MeshCore monitor view.
 *
 * Replaces the flat MeshCoreTab. Layout:
 *   ┌─ MeshCoreStatusBar ─────────────────────────────┐
 *   │ (connect / disconnect / status)                 │
 *   ├─┬───────────────────────────────────────────────┤
 *   │ │   MeshCoreSubToolbar  │  current view         │
 *   │ │   (narrow, expandable)│  (nodes/channels/dms/ │
 *   │ │                       │   config/settings)    │
 *   └─┴───────────────────────────────────────────────┘
 *
 * Talks to /api/meshcore/* (singleton) or /api/sources/:id/meshcore/*
 * (per-source dashboard) via useMeshCore, depending on whether `sourceId`
 * is passed in.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMeshCore, ConnectionStatus } from './hooks/useMeshCore';
import { MeshCoreStatusBar } from './MeshCoreStatusBar';
import { MeshCoreSubToolbar, MeshCoreView } from './MeshCoreSubToolbar';
import { MeshCoreNodesView } from './MeshCoreNodesView';
import { MeshCoreChannelsView } from './MeshCoreChannelsView';
import { MeshCoreDirectMessagesView } from './MeshCoreDirectMessagesView';
import { MeshCoreConfigurationView } from './MeshCoreConfigurationView';
import { MeshCoreSettingsView } from './MeshCoreSettingsView';
import './MeshCoreTab.css';
import './MeshCorePage.css';

interface MeshCorePageProps {
  baseUrl: string;
  /** When set, routes the hook through /api/sources/:id/meshcore/*. */
  sourceId?: string;
  /** When false, the hook is disabled (no polling). Used for permission gating. */
  enabled?: boolean;
  /** When provided, the parent renders the connection chip in its own header
   *  and the inline status bar suppresses its duplicate "Connected to X" text. */
  onStatusChange?: (status: ConnectionStatus | null) => void;
}

export const MeshCorePage: React.FC<MeshCorePageProps> = ({ baseUrl, sourceId, enabled, onStatusChange }) => {
  const { t } = useTranslation();
  const meshCore = useMeshCore({ baseUrl, sourceId, enabled });
  const { status, nodes, contacts, messages, loading, error, actions } = meshCore;

  const [view, setView] = useState<MeshCoreView>('nodes');
  const [toolbarExpanded, setToolbarExpanded] = useState(false);

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  return (
    <div className="meshcore-page">
      <MeshCoreStatusBar
        status={status}
        loading={loading}
        onOpenSettings={() => setView('settings')}
        actions={actions}
        hideConnectionText={!!onStatusChange}
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
          onSelect={setView}
          expanded={toolbarExpanded}
          onToggleExpanded={() => setToolbarExpanded(v => !v)}
        />
        <div className="meshcore-content">
          {view === 'nodes' && (
            <MeshCoreNodesView nodes={nodes} contacts={contacts} />
          )}
          {view === 'channels' && (
            <MeshCoreChannelsView messages={messages} contacts={contacts} status={status} actions={actions} />
          )}
          {view === 'dms' && (
            <MeshCoreDirectMessagesView
              messages={messages}
              contacts={contacts}
              status={status}
              actions={actions}
            />
          )}
          {view === 'configuration' && (
            <MeshCoreConfigurationView status={status} actions={actions} />
          )}
          {view === 'settings' && (
            <MeshCoreSettingsView
              status={status}
              loading={loading}
              actions={actions}
              perSource={!!sourceId}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default MeshCorePage;

// Back-compat alias so existing `import { MeshCoreTab } from '...'` keeps working.
export const MeshCoreTab = MeshCorePage;
