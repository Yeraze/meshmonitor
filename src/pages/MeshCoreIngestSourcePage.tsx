/**
 * MeshCoreIngestSourcePage — per-source page for a `meshcore_mqtt` source (#5096).
 *
 * Mirrors MeshCoreSourcePage's chrome (top bar, sign-in, connection chip) but
 * hosts MeshCoreIngestView instead of MeshCorePage. Before this, an ingest
 * source fell through main.tsx's routing to the Meshtastic `<App />` shell and
 * showed Meshtastic tabs for a MeshCore source.
 *
 * There is no local-node label in the header: an ingest source is not a node on
 * the mesh, it reads other observers' reports. `getLocalNode()` returns null by
 * design, so the header shows the region feed's identity instead.
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
import { MeshCoreIngestView } from '../components/MeshCore/MeshCoreIngestView';
import '../components/MeshCore/MeshCoreTab.css';
import '../components/AppHeader/AppHeader.css';
import { UiIcon } from '../components/icons';

function MeshCoreIngestInner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sourceId, sourceName } = useSource();
  const { authStatus, hasPermission } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;

  // Same per-source gate the device-backed MeshCore page uses, so permissions
  // behave identically across both kinds of MeshCore source.
  const canReadConnection = hasPermission('connection', 'read');

  const [showLogin, setShowLogin] = useState(false);

  if (!sourceId) {
    return (
      <div className="meshcore-tab">
        <p>{t('meshcore.no_source', 'No source selected.')}</p>
      </div>
    );
  }

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
          {sourceName && <span className="dashboard-topbar-title">{sourceName}</span>}
        </div>
        <div className="dashboard-topbar-actions">
          {isAuthenticated ? (
            <UserMenu />
          ) : (
            <button className="dashboard-signin-btn" onClick={() => setShowLogin(true)}>
              {t('source.topbar.sign_in')}
            </button>
          )}
        </div>
      </header>

      {canReadConnection ? (
        <MeshCoreIngestView sourceId={sourceId} baseUrl={appBasename} />
      ) : (
        <div className="meshcore-tab">
          <h2>{t('meshcore.title')}</h2>
          <p>
            {t(
              'meshcore.no_permission',
              'You do not have permission to view this MeshCore source.',
            )}
          </p>
        </div>
      )}

      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}

export default function MeshCoreIngestSourcePage() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <MapProvider>
          <MeshCoreIngestInner />
        </MapProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
