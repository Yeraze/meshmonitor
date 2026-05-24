/**
 * MqttSourcePageShell — chrome for per-source MQTT detail dashboards.
 *
 * Provides the topbar + tab strip that wraps the Map and Settings panes
 * for both `mqtt_broker` and `mqtt_bridge` source detail pages. The two
 * source types differ only in (a) the title text and (b) the contents of
 * each tab — everything else (back-to-sources button, login/user menu,
 * connection-status pill, tab navigation, deep-link `?tab=` handling)
 * lives here so the two pages can't drift apart.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import LoginModal from '../LoginModal';
import UserMenu from '../UserMenu';
import { appBasename } from '../../init';
import '../AppHeader/AppHeader.css';
import './MqttSourcePageShell.css';

export interface MqttSourcePageTab {
  id: string;
  label: string;
  content: ReactNode;
}

export interface MqttSourcePageShellProps {
  /** Title shown in the topbar, e.g. "MeshMonitor — MQTT Broker". */
  title: string;
  /** Source name from useSource(); shown next to the title. */
  sourceName: string | null;
  /** Whether the source is currently connected/listening. */
  connected: boolean;
  /** Tabs to render. The first tab is the default when no `?tab=` is set. */
  tabs: MqttSourcePageTab[];
}

export function MqttSourcePageShell({
  title,
  sourceName,
  connected,
  tabs,
}: MqttSourcePageShellProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;

  const [searchParams, setSearchParams] = useSearchParams();
  const [showLogin, setShowLogin] = useState(false);

  const defaultTabId = tabs[0]?.id ?? '';
  const activeTabId = useMemo(() => {
    const requested = searchParams.get('tab');
    if (requested && tabs.some((tab) => tab.id === requested)) {
      return requested;
    }
    return defaultTabId;
  }, [searchParams, tabs, defaultTabId]);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  const onSelectTab = (tabId: string) => {
    const next = new URLSearchParams(searchParams);
    if (tabId === defaultTabId) {
      next.delete('tab');
    } else {
      next.set('tab', tabId);
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="dashboard-page mqtt-source-page">
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
          <span className="dashboard-topbar-title">{title}</span>
        </div>
        {sourceName && (
          <div className="node-info">
            <span className="node-address">{sourceName}</span>
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

      <nav className="mqtt-source-tabs" role="tablist" aria-label={title}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`mqtt-source-tab${tab.id === activeTabId ? ' active' : ''}`}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="mqtt-source-tab-content" role="tabpanel">
        {activeTab?.content}
      </div>

      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
