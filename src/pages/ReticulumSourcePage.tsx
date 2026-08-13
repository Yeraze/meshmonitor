/**
 * ReticulumSourcePage — per-source Reticulum dashboard (#3960 Phase 1b WP2).
 *
 * Hosts the multi-pane `ReticulumPage` layout inside the source-dashboard
 * chrome (top bar + login/user menu), mirroring `MeshCoreSourcePage`.
 * Permission gating uses `hasPermission('nodes', 'read')` — the resource
 * the reticulum data routes (`/api/sources/:id/reticulum/destinations`,
 * `/interfaces`) require (build spec §2) — rather than `connection`, since
 * that's the actual gate the underlying routes enforce. When the user lacks
 * it the entire surface is hidden and `useReticulum` is left disabled so no
 * probe requests fire.
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
import { ReticulumPage } from '../components/Reticulum/ReticulumPage';
import type { ReticulumStatus } from '../types/reticulum';
import '../components/AppHeader/AppHeader.css';
import { UiIcon } from '../components/icons';
import styles from './ReticulumSourcePage.module.css';

function ReticulumSourceInner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sourceId, sourceName } = useSource();
  const { authStatus, hasPermission } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;

  // Per-source permission — sourceId is auto-bound via SourceContext. This
  // is the resource the reticulum data routes actually enforce (build spec
  // §2: GET /destinations, /interfaces require `nodes:read`).
  const canReadNodes = hasPermission('nodes', 'read');

  const [showLogin, setShowLogin] = useState(false);
  const [rnsStatus, setRnsStatus] = useState<ReticulumStatus | null>(null);

  if (!sourceId) {
    return (
      <div className={styles.gate}>
        <p>{t('reticulum.no_source', 'No source selected.')}</p>
      </div>
    );
  }

  // No nodes-read permission means the entire surface is hidden. The hook
  // is never mounted, so no `/reticulum/status` probe fires.
  if (!canReadNodes) {
    return (
      <div className={styles.gate}>
        <h2>{t('reticulum.title', 'Reticulum')}</h2>
        <p>{t('reticulum.no_permission', 'You do not have permission to view this Reticulum source.')}</p>
      </div>
    );
  }

  // rnsStatus is null until the first poll resolves — show "Connecting…"
  // instead of "Disconnected" so the header doesn't mislead during initial load.
  const statusLoading = rnsStatus === null;
  const connected = rnsStatus?.connected ?? false;

  return (
    <div className="dashboard-page">
      <header className="dashboard-topbar">
        <button
          className="back-to-sources-btn"
          onClick={() => navigate('/', { state: { showList: true } })}
          title={t('source.sidebar.open_sources', 'Sources')}
        >
          <UiIcon name="back" size={16} /> {t('unified.back_to_sources', 'Sources')}
        </button>
        <div className="dashboard-topbar-logo">
          <img
            src={`${appBasename}/logo.png`}
            alt="MeshMonitor"
            className="dashboard-topbar-logo-img"
          />
          <span className="dashboard-topbar-title dashboard-topbar-title-full">MeshMonitor — Reticulum</span>
          {sourceName && (
            <span className="dashboard-topbar-title dashboard-topbar-title-short">{sourceName}</span>
          )}
        </div>
        <div className="dashboard-topbar-actions">
          <div className="connection-status-container">
            <div className="connection-status">
              <span
                className={`status-indicator ${statusLoading ? 'connecting' : connected ? 'connected' : 'disconnected'}`}
              />
              <span>
                {statusLoading
                  ? t('source.status_connecting', 'Connecting')
                  : connected
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

      <ReticulumPage baseUrl={appBasename} sourceId={sourceId} onStatusChange={setRnsStatus} />

      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}

export default function ReticulumSourcePage() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <MapProvider>
          <ReticulumSourceInner />
        </MapProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
