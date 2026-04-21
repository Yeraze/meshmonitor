/**
 * DashboardPage — MeshMonitor 4.0 landing page.
 *
 * Wraps the inner dashboard in a SettingsProvider so map tile preferences
 * are available, then wires together DashboardSidebar + DashboardMap with
 * per-source data fetched via the useDashboardData hooks.
 */

import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import { useCsrf } from '../contexts/CsrfContext';
import {
  useDashboardSources,
  useSourceStatuses,
  useDashboardSourceData,
} from '../hooks/useDashboardData';
import DashboardSidebar from '../components/Dashboard/DashboardSidebar';
import DashboardMap from '../components/Dashboard/DashboardMap';
import LoginModal from '../components/LoginModal';
import UserMenu from '../components/UserMenu';
import { NewsPopup } from '../components/NewsPopup';
import { ToastProvider } from '../components/ToastContainer';
import api from '../services/api';
import { logger } from '../utils/logger';
import { appBasename } from '../init';
import '../styles/dashboard.css';

// ---------------------------------------------------------------------------
// DashboardInner — rendered inside SettingsProvider
// ---------------------------------------------------------------------------

function DashboardInner() {
  const { t } = useTranslation();
  const { authStatus } = useAuth();
  const { getToken } = useCsrf();
  const queryClient = useQueryClient();
  const { mapTileset, customTilesets, defaultMapCenterLat, defaultMapCenterLon } = useSettings();

  /**
   * Invalidate the source list cache after a mutation so the sidebar
   * reflects the new/edited/toggled/deleted source immediately instead of
   * waiting for the 15s poll interval. Same key as `useDashboardSources`.
   */
  const refreshSources = () => {
    queryClient.invalidateQueries({ queryKey: ['dashboard', 'sources'] });
  };

  const isAuthenticated = authStatus?.authenticated ?? false;
  const isAdmin = authStatus?.user?.isAdmin ?? false;

  const defaultCenter = {
    lat: defaultMapCenterLat ?? 30.0,
    lng: defaultMapCenterLon ?? -90.0,
  };

  // ----- state -----
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  // Mobile drawer state — hamburger toggles; source selection auto-closes.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // News popup state — auto-opens on unread news, can be reopened via sidebar footer button.
  const [showNewsPopup, setShowNewsPopup] = useState(false);
  const [forceShowAllNews, setForceShowAllNews] = useState(false);

  // Source add/edit modal state
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('4403');
  const [formVnEnabled, setFormVnEnabled] = useState(false);
  const [formVnPort, setFormVnPort] = useState('');
  const [formVnAllowAdmin, setFormVnAllowAdmin] = useState(false);
  const [formHeartbeat, setFormHeartbeat] = useState('30'); // seconds, 0 = disabled (issue 2609)
  const [formError, setFormError] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  // ----- data -----
  const { data: sources = [], isSuccess } = useDashboardSources();
  const sourceIds = sources.map((s) => s.id);
  const statusMap = useSourceStatuses(sourceIds);
  const sourceData = useDashboardSourceData(selectedSourceId);

  // Auto-select first enabled source when list loads
  useEffect(() => {
    if (!isSuccess || sources.length === 0 || selectedSourceId !== null) return;
    const firstEnabled = sources.find((s) => s.enabled);
    setSelectedSourceId(firstEnabled?.id ?? sources[0].id);
  }, [isSuccess, sources, selectedSourceId]);

  // Auto-show news popup when authenticated user has unread news.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await api.getUnreadNews();
        if (cancelled) return;
        if (response.items && response.items.length > 0) {
          setForceShowAllNews(false);
          setShowNewsPopup(true);
        }
      } catch (err) {
        logger.debug('Failed to fetch unread news:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // Build node-count map. Each source's count comes from its /status response
  // (added in sourceRoutes.ts), polled in parallel by useSourceStatuses. The
  // currently-selected source uses the live `sourceData.nodes.length` so the
  // counter updates immediately as new nodes arrive instead of waiting for the
  // next status poll.
  const nodeCounts = new Map<string, number>(
    sources.map((s) => {
      if (s.id === selectedSourceId) return [s.id, sourceData.nodes.length];
      const status = statusMap.get(s.id);
      return [s.id, status?.nodeCount ?? 0];
    }),
  );

  // ----- admin actions -----
  const onAddSource = () => {
    setEditingSourceId(null);
    setFormName('');
    setFormHost('');
    setFormPort('4403');
    setFormVnEnabled(false);
    setFormVnPort('');
    setFormVnAllowAdmin(false);
    setFormHeartbeat('30');
    setFormError('');
    setShowSourceModal(true);
  };

  const onEditSource = (id: string) => {
    const source = sources.find((s) => s.id === id);
    if (!source) return;
    const cfg = source.config as Record<string, any> | undefined;
    setEditingSourceId(id);
    setFormName(source.name);
    setFormHost(cfg?.host ?? '');
    setFormPort(String(cfg?.port ?? 4403));
    const vn = cfg?.virtualNode as { enabled?: boolean; port?: number; allowAdminCommands?: boolean } | undefined;
    setFormVnEnabled(vn?.enabled === true);
    setFormVnPort(vn?.port != null ? String(vn.port) : '');
    setFormVnAllowAdmin(vn?.allowAdminCommands === true);
    setFormHeartbeat(String(cfg?.heartbeatIntervalSeconds ?? 0));
    setFormError('');
    setShowSourceModal(true);
  };

  const onSaveSource = async () => {
    if (!formName.trim()) { setFormError(t('source.form.error_name_required')); return; }
    if (!formHost.trim()) { setFormError(t('source.form.error_host_required')); return; }
    const port = parseInt(formPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) { setFormError(t('source.form.error_port_range')); return; }

    // Heartbeat interval (issue 2609): 0 = disabled, otherwise a positive
    // number of seconds. We clamp to a sane range to prevent pathological
    // configurations (sub-second floods or 24h naps that defeat the point).
    const heartbeatSeconds = parseInt(formHeartbeat, 10);
    if (isNaN(heartbeatSeconds) || heartbeatSeconds < 0 || heartbeatSeconds > 3600) {
      setFormError(t('source.form.error_heartbeat_range'));
      return;
    }

    let vnConfig: { enabled: boolean; port: number; allowAdminCommands: boolean } | undefined;
    if (formVnEnabled) {
      const vnPort = parseInt(formVnPort, 10);
      if (isNaN(vnPort) || vnPort < 1 || vnPort > 65535) {
        setFormError(t('source.form.error_vn_port_range'));
        return;
      }
      if (vnPort === port) {
        setFormError(t('source.form.error_vn_port_collision'));
        return;
      }
      vnConfig = { enabled: true, port: vnPort, allowAdminCommands: formVnAllowAdmin };
    }

    setFormSaving(true);
    setFormError('');
    try {
      const csrfToken = getToken();
      const cfg: Record<string, any> = { host: formHost.trim(), port };
      if (heartbeatSeconds > 0) cfg.heartbeatIntervalSeconds = heartbeatSeconds;
      if (vnConfig) cfg.virtualNode = vnConfig;
      const body = {
        name: formName.trim(),
        type: 'meshtastic_tcp',
        config: cfg,
        enabled: true,
      };
      const url = editingSourceId
        ? `${appBasename}/api/sources/${editingSourceId}`
        : `${appBasename}/api/sources`;
      const method = editingSourceId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken || '',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setFormError((err as any).error ?? t('source.form.error_save_failed'));
        return;
      }
      setShowSourceModal(false);
      refreshSources();
    } catch {
      setFormError(t('source.form.error_network'));
    } finally {
      setFormSaving(false);
    }
  };

  const onToggleSource = async (id: string, enabled: boolean) => {
    const csrfToken = getToken();
    const res = await fetch(`${appBasename}/api/sources/${id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken || '',
      },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) refreshSources();
  };

  const onDeleteSource = (id: string) => {
    setDeleteConfirm(id);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    const csrfToken = getToken();
    const res = await fetch(`${appBasename}/api/sources/${deleteConfirm}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken || '',
      },
    });
    if (selectedSourceId === deleteConfirm) {
      setSelectedSourceId(null);
    }
    setDeleteConfirm(null);
    if (res.ok) refreshSources();
  };

  // ----- render -----
  return (
    <div className="dashboard-page">
      {/* Top bar */}
      <header className="dashboard-topbar">
        <button
          className="dashboard-topbar-hamburger"
          aria-label={mobileSidebarOpen ? t('source.sidebar.close_sources') : t('source.sidebar.open_sources')}
          aria-expanded={mobileSidebarOpen}
          onClick={() => setMobileSidebarOpen((v) => !v)}
        >
          {mobileSidebarOpen ? '✕' : '☰'}
        </button>
        <div className="dashboard-topbar-logo">
          <img src={`${appBasename}/logo.png`} alt={t('source.topbar.logo_alt')} className="dashboard-topbar-logo-img" />
          <span className="dashboard-topbar-title">MeshMonitor</span>
        </div>
        <div className="dashboard-topbar-actions">
          {isAuthenticated ? (
            <UserMenu />
          ) : (
            <button
              className="dashboard-signin-btn"
              onClick={() => setShowLogin(true)}
            >
              {t('source.topbar.sign_in')}
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="dashboard-body">
        <DashboardSidebar
          sources={sources}
          statusMap={statusMap}
          nodeCounts={nodeCounts}
          selectedSourceId={selectedSourceId}
          onSelectSource={setSelectedSourceId}
          isAdmin={isAdmin}
          isAuthenticated={isAuthenticated}
          onAddSource={onAddSource}
          onEditSource={onEditSource}
          onToggleSource={onToggleSource}
          onDeleteSource={onDeleteSource}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
          onNewsClick={() => {
            setForceShowAllNews(true);
            setShowNewsPopup(true);
          }}
        />

        <DashboardMap
          nodes={sourceData.nodes}
          traceroutes={sourceData.traceroutes}
          neighborInfo={sourceData.neighborInfo}
          channels={sourceData.channels}
          tilesetId={mapTileset}
          customTilesets={customTilesets}
          defaultCenter={defaultCenter}
          sourceId={selectedSourceId}
        />
      </div>

      {/* Login modal */}
      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />

      {/* News popup — auto-opens on unread news, reopened via sidebar footer. */}
      <NewsPopup
        isOpen={showNewsPopup}
        onClose={() => {
          setShowNewsPopup(false);
          setForceShowAllNews(false);
        }}
        forceShowAll={forceShowAllNews}
        isAuthenticated={isAuthenticated}
      />

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="dashboard-confirm-overlay">
          <div className="dashboard-confirm-dialog">
            <h3>{t('source.delete')}</h3>
            <p>{t('source.delete_confirm')}</p>
            <div className="dashboard-confirm-actions">
              <button onClick={() => setDeleteConfirm(null)}>{t('common.cancel')}</button>
              <button onClick={confirmDelete}>{t('source.kebab.delete')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit source modal */}
      {showSourceModal && (
        <div className="dashboard-confirm-overlay" onClick={() => setShowSourceModal(false)}>
          <div className="dashboard-confirm-dialog" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3>{editingSourceId ? t('source.edit') : t('source.add')}</h3>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.name')}</span>
              <input
                className="dashboard-form-input"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t('source.form.name_placeholder')}
                autoFocus
              />
            </label>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.host')}</span>
              <input
                className="dashboard-form-input"
                type="text"
                value={formHost}
                onChange={(e) => setFormHost(e.target.value)}
                placeholder={t('source.form.host_placeholder')}
              />
            </label>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.tcp_port')}</span>
              <input
                className="dashboard-form-input"
                type="number"
                value={formPort}
                onChange={(e) => setFormPort(e.target.value)}
                placeholder="4403"
              />
            </label>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">{t('source.form.heartbeat')}</span>
              <input
                className="dashboard-form-input"
                type="number"
                min={0}
                max={3600}
                value={formHeartbeat}
                onChange={(e) => setFormHeartbeat(e.target.value)}
                placeholder="0"
              />
              <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                {t('source.form.heartbeat_help')}
              </p>
            </label>

            <fieldset style={{ border: '1px solid var(--ctp-surface1)', borderRadius: 6, padding: '8px 12px 12px', margin: '8px 0' }}>
              <legend style={{ fontSize: 12, padding: '0 6px', color: 'var(--ctp-subtext0)' }}>{t('source.form.virtual_node')}</legend>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={formVnEnabled}
                  onChange={(e) => setFormVnEnabled(e.target.checked)}
                />
                {t('source.form.enable_virtual_node')}
              </label>
              {formVnEnabled && (
                <>
                  <label className="dashboard-form-field" style={{ marginTop: 8 }}>
                    <span className="dashboard-form-label">{t('source.form.virtual_node_port')}</span>
                    <input
                      className="dashboard-form-input"
                      type="number"
                      value={formVnPort}
                      onChange={(e) => setFormVnPort(e.target.value)}
                      placeholder="4403"
                    />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={formVnAllowAdmin}
                      onChange={(e) => setFormVnAllowAdmin(e.target.checked)}
                    />
                    {t('source.form.allow_admin_commands')}
                  </label>
                  <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                    {t('source.form.allow_admin_help')}
                  </p>
                </>
              )}
            </fieldset>

            {formError && (
              <p style={{ color: 'var(--ctp-red)', fontSize: 12, margin: '8px 0 0' }}>{formError}</p>
            )}

            <div className="dashboard-confirm-actions" style={{ marginTop: 16 }}>
              <button onClick={() => setShowSourceModal(false)}>{t('common.cancel')}</button>
              <button onClick={onSaveSource} disabled={formSaving} style={{ background: 'var(--ctp-blue)', color: 'var(--ctp-base)' }}>
                {formSaving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DashboardPage — public export; wraps in SettingsProvider
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <DashboardInner />
      </ToastProvider>
    </SettingsProvider>
  );
}
