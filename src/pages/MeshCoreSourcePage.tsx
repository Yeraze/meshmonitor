/**
 * MeshCoreSourcePage — per-source MeshCore dashboard.
 *
 * Hosts the multi-pane MeshCorePage layout inside the source-dashboard
 * chrome (top bar + login/user menu) and points the underlying useMeshCore
 * hook at the per-source `/api/sources/:id/meshcore/*` routes. Permission
 * gating uses `hasPermission(resource, action, { sourceId })` with the
 * sourcey per-source resources (`connection`, `nodes`, `messages`,
 * `configuration`). When the user lacks `connection:read` the entire
 * surface is hidden — and the hook is left disabled so no probe requests
 * fire.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { SettingsProvider } from '../contexts/SettingsContext';
import { ToastProvider } from '../components/ToastContainer';
import { MapProvider } from '../contexts/MapContext';
import { useAuth } from '../contexts/AuthContext';
import { useSource } from '../contexts/SourceContext';
import LoginModal from '../components/LoginModal';
import UserMenu from '../components/UserMenu';
import { appBasename } from '../init';
import { MeshCorePage } from '../components/MeshCore/MeshCorePage';
import type { ConnectionStatus } from '../components/MeshCore/hooks/useMeshCore';
import '../components/MeshCore/MeshCoreTab.css';
import '../components/AppHeader/AppHeader.css';

function MeshCoreSourceInner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sourceId } = useSource();
  const { authStatus, hasPermission } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;

  // Per-source permission — sourceId is auto-bound via SourceContext.
  const canReadConnection = hasPermission('connection', 'read');

  const [showLogin, setShowLogin] = useState(false);
  const [mcStatus, setMcStatus] = useState<ConnectionStatus | null>(null);

  if (!sourceId) {
    return (
      <div className="meshcore-tab">
        <p>{t('meshcore.no_source', 'No source selected.')}</p>
      </div>
    );
  }

  // No connection-read permission means the entire surface is hidden, just
  // like a Meshtastic source the user can't read. The hook is never mounted,
  // so no `/meshcore/status` probe fires.
  if (!canReadConnection) {
    return (
      <div className="meshcore-tab">
        <h2>{t('meshcore.title')}</h2>
        <p>{t('meshcore.no_permission', 'You do not have permission to view this MeshCore source.')}</p>
      </div>
    );
  }

  const connected = mcStatus?.connected ?? false;
  const localNode = mcStatus?.localNode ?? null;
  const localNodeLabel = localNode?.name || null;
  const localNodeMeta = mcStatus?.deviceTypeName || null;

  return (
    <div className="dashboard-page">
      <header className="dashboard-topbar">
        <button
          className="back-to-sources-btn"
          onClick={() => navigate('/', { state: { showList: true } })}
          title={t('source.sidebar.open_sources', 'Sources')}
        >
          {t('unified.back_to_sources', '← Sources')}
        </button>
        <div className="dashboard-topbar-logo">
          <img
            src={`${appBasename}/logo.png`}
            alt="MeshMonitor"
            className="dashboard-topbar-logo-img"
          />
          <span className="dashboard-topbar-title">MeshMonitor — MeshCore</span>
        </div>
        {localNodeLabel && (
          <div className="node-info">
            <span className="node-address" title={localNode?.publicKey}>
              {localNodeMeta ? `${localNodeLabel} (${localNodeMeta})` : localNodeLabel}
            </span>
          </div>
        )}
        <div className="dashboard-topbar-actions">
          <div className="connection-status-container">
            <div className="connection-status">
              <span
                className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}
              />
              <span>
                {connected
                  ? t('header.status.connected', 'Connected')
                  : t('header.status.disconnected', 'Disconnected')}
              </span>
            </div>
          </div>
          {isAuthenticated ? (
            <UserMenu />
          ) : (
            <button className="dashboard-signin-btn" onClick={() => setShowLogin(true)}>
              {t('source.topbar.sign_in')}
            </button>
          )}
        </div>
      </header>

      <MeshCorePage baseUrl={appBasename} sourceId={sourceId} onStatusChange={setMcStatus} />

      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}

export default function MeshCoreSourcePage() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <MapProvider>
          <MeshCoreSourceInner />
        </MapProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
