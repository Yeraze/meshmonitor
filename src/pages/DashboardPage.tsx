/**
 * DashboardPage — MeshMonitor 4.0 landing page.
 *
 * Wraps the inner dashboard in a SettingsProvider so map tile preferences
 * are available, then wires together DashboardSidebar + DashboardMap with
 * per-source data fetched via the useDashboardData hooks.
 */

import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import { useCsrf } from '../contexts/CsrfContext';
import {
  useDashboardSources,
  useSourceStatuses,
  useDashboardSourceData,
  useDashboardUnifiedData,
  useUnifiedStatus,
  UNIFIED_SOURCE_ID,
} from '../hooks/useDashboardData';
import type { DashboardSource } from '../hooks/useDashboardData';
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
  const { mapTileset, customTilesets, defaultMapCenterLat, defaultMapCenterLon, maxNodeAgeHours, defaultLandingPage } = useSettings();
  const navigate = useNavigate();
  const location = useLocation();

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

  // Source IDs with an in-flight /connect request — drives the "Connecting..."
  // button label and status dot while the POST is outstanding (issue #2773).
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());

  // Source add/edit modal state
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [formType, setFormType] = useState<'meshtastic_tcp' | 'meshcore'>('meshtastic_tcp');
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('4403');
  const [formVnEnabled, setFormVnEnabled] = useState(false);
  const [formVnPort, setFormVnPort] = useState('');
  const [formVnAllowAdmin, setFormVnAllowAdmin] = useState(false);
  const [formHeartbeat, setFormHeartbeat] = useState('30'); // seconds, 0 = disabled (issue 2609)
  const [formAutoConnect, setFormAutoConnect] = useState(true); // issue #2773
  // MeshCore-specific (slice 4): companion-USB v1 — serial path + device type.
  // TCP transport added in v2: same Companion firmware reachable over a TCP
  // socket (e.g. esp-link, ser2net, native TCP-capable MeshCore firmware).
  const [formMcTransport, setFormMcTransport] = useState<'usb' | 'tcp'>('usb');
  const [formMcSerialPort, setFormMcSerialPort] = useState('');
  const [formMcTcpHost, setFormMcTcpHost] = useState('');
  const [formMcTcpPort, setFormMcTcpPort] = useState('4403');
  const [formMcDeviceType, setFormMcDeviceType] = useState<'companion' | 'repeater'>('companion');
  const [formError, setFormError] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  // ----- data -----
  const { data: sources = [], isSuccess } = useDashboardSources();
  const sourceIds = sources.map((s) => s.id);

  // Apply admin-configured default landing page (issue #2917). When the
  // user lands on `/`, redirect to /source/:sourceId/ if the setting points
  // at a real source. The "Sources" button always passes
  // location.state.showList=true so users can return to the unified view
  // even if a default has been configured.
  const skipDefaultLanding = (location.state as { showList?: boolean } | null)?.showList === true;
  useEffect(() => {
    if (skipDefaultLanding) return;
    if (!isSuccess) return;
    if (!defaultLandingPage || defaultLandingPage === 'unified') return;
    const target = sources.find((s) => s.id === defaultLandingPage);
    if (!target) return;
    navigate(`/source/${target.id}/`, { replace: true });
  }, [skipDefaultLanding, isSuccess, defaultLandingPage, sources, navigate]);
  const statusMap = useSourceStatuses(sourceIds);
  const unifiedStatus = useUnifiedStatus();

  // Show a synthetic "Unified" entry in the sidebar only when the user has
  // configured 2+ sources — otherwise it would just duplicate the single
  // source's data and add UI noise.
  const showUnified = sources.length >= 2;
  const isUnifiedSelected = selectedSourceId === UNIFIED_SOURCE_ID;

  // Run both data hooks but disable whichever is not active so we don't fan
  // out N parallel fetches when the user is on a single-source view.
  const singleSourceData = useDashboardSourceData(isUnifiedSelected ? null : selectedSourceId);
  const unifiedSourceData = useDashboardUnifiedData(sourceIds, isUnifiedSelected);
  const sourceData = isUnifiedSelected ? unifiedSourceData : singleSourceData;

  // Synthetic Unified pseudo-source for the sidebar. Recognized by its sentinel ID
  // so DashboardSidebar can hide admin/open controls that don't apply.
  const unifiedSource: DashboardSource | null = showUnified
    ? {
        id: UNIFIED_SOURCE_ID,
        name: t('source.unified', 'Unified'),
        type: '__unified__',
        enabled: true,
      }
    : null;
  const sidebarSources: DashboardSource[] = unifiedSource ? [unifiedSource, ...sources] : sources;

  // Auto-select first enabled source when list loads. Default to Unified when
  // the user has multiple sources — that's the most useful at-a-glance view.
  useEffect(() => {
    if (!isSuccess || sources.length === 0 || selectedSourceId !== null) return;
    if (showUnified) {
      setSelectedSourceId(UNIFIED_SOURCE_ID);
      return;
    }
    const firstEnabled = sources.find((s) => s.enabled);
    setSelectedSourceId(firstEnabled?.id ?? sources[0].id);
  }, [isSuccess, sources, selectedSourceId, showUnified]);

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
  // next status poll. The Unified entry uses the deduped count from
  // /api/unified/status — a single source of truth that stays stable as the
  // user clicks between sources (issue #2805). Falls back to the live merged
  // count when Unified is selected and the polled value hasn't arrived yet.
  const nodeCounts = new Map<string, number>(
    sources.map((s) => {
      if (s.id === selectedSourceId) return [s.id, sourceData.nodes.length];
      const status = statusMap.get(s.id);
      return [s.id, status?.nodeCount ?? 0];
    }),
  );
  if (unifiedSource) {
    const polled = unifiedStatus?.nodeCount;
    const fallback = isUnifiedSelected ? unifiedSourceData.nodes.length : 0;
    nodeCounts.set(UNIFIED_SOURCE_ID, polled ?? fallback);
  }

  // ----- admin actions -----
  const onAddSource = () => {
    setEditingSourceId(null);
    setFormType('meshtastic_tcp');
    setFormName('');
    setFormHost('');
    setFormPort('4403');
    setFormVnEnabled(false);
    setFormVnPort('');
    setFormVnAllowAdmin(false);
    setFormHeartbeat('30');
    setFormAutoConnect(true);
    setFormMcTransport('usb');
    setFormMcSerialPort('');
    setFormMcTcpHost('');
    setFormMcTcpPort('4403');
    setFormMcDeviceType('companion');
    setFormError('');
    setShowSourceModal(true);
  };

  const onEditSource = (id: string) => {
    const source = sources.find((s) => s.id === id);
    if (!source) return;
    const cfg = source.config as Record<string, any> | undefined;
    setEditingSourceId(id);
    setFormType(source.type === 'meshcore' ? 'meshcore' : 'meshtastic_tcp');
    setFormName(source.name);
    setFormHost(cfg?.host ?? '');
    setFormPort(String(cfg?.port ?? 4403));
    const vn = cfg?.virtualNode as { enabled?: boolean; port?: number; allowAdminCommands?: boolean } | undefined;
    setFormVnEnabled(vn?.enabled === true);
    setFormVnPort(vn?.port != null ? String(vn.port) : '');
    setFormVnAllowAdmin(vn?.allowAdminCommands === true);
    setFormHeartbeat(String(cfg?.heartbeatIntervalSeconds ?? 0));
    // Default to true when unset (legacy sources pre-#2773 auto-connected).
    setFormAutoConnect(cfg?.autoConnect !== false);
    // MeshCore-specific config. transport=tcp is a v2 addition; legacy rows
    // with no transport field are treated as USB (the original v1 default).
    const mcTransport: 'usb' | 'tcp' = cfg?.transport === 'tcp' ? 'tcp' : 'usb';
    setFormMcTransport(mcTransport);
    setFormMcSerialPort(cfg?.serialPort ?? cfg?.port ?? '');
    setFormMcTcpHost(cfg?.tcpHost ?? '');
    setFormMcTcpPort(cfg?.tcpPort != null ? String(cfg.tcpPort) : '4403');
    setFormMcDeviceType(cfg?.deviceType === 'repeater' ? 'repeater' : 'companion');
    setFormError('');
    setShowSourceModal(true);
  };

  const onSaveSource = async () => {
    if (!formName.trim()) { setFormError(t('source.form.error_name_required')); return; }

    let cfg: Record<string, any>;
    if (formType === 'meshcore') {
      // MeshCore source: USB/serial or TCP. Both transports flow through the
      // same MeshCoreManager via the Python bridge — only the connect params
      // differ. BLE remains out of scope.
      if (formMcTransport === 'tcp') {
        const host = formMcTcpHost.trim();
        if (!host) {
          setFormError(t('meshcore.form.error_tcp_host_required', 'Host is required'));
          return;
        }
        const tcpPort = parseInt(formMcTcpPort, 10);
        if (isNaN(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
          setFormError(t('source.form.error_port_range'));
          return;
        }
        cfg = {
          transport: 'tcp',
          tcpHost: host,
          tcpPort,
          deviceType: formMcDeviceType,
          autoConnect: formAutoConnect,
        };
      } else {
        const port = formMcSerialPort.trim();
        if (!port) {
          setFormError(t('meshcore.form.error_port_required', 'Serial port is required'));
          return;
        }
        cfg = {
          transport: 'usb',
          port,
          deviceType: formMcDeviceType,
          autoConnect: formAutoConnect,
        };
      }
    } else {
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
        vnConfig = { enabled: true, port: vnPort, allowAdminCommands: formVnAllowAdmin };
      }

      cfg = { host: formHost.trim(), port };
      if (heartbeatSeconds > 0) cfg.heartbeatIntervalSeconds = heartbeatSeconds;
      if (vnConfig) cfg.virtualNode = vnConfig;
      // Persist autoConnect explicitly so the server can distinguish legacy
      // sources (undefined → treat as true) from ones the user opted out of.
      cfg.autoConnect = formAutoConnect;
    }

    setFormSaving(true);
    setFormError('');
    try {
      const csrfToken = getToken();
      const body = {
        name: formName.trim(),
        type: formType,
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

  // Manually start the manager for a source whose autoConnect is disabled
  // (issue #2773). The /connect POST returns as soon as the manager is
  // registered, but the upstream TCP handshake happens asynchronously — so we
  // keep `connectingIds` set (and aggressively poll /status) until the status
  // endpoint reports connected=true, or a timeout elapses. Without this the
  // dashboard would sit on "Connecting…" for up to DASHBOARD_POLL_INTERVAL
  // (15s) before the next normal status poll fires.
  const onConnectSource = async (id: string) => {
    setConnectingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      const csrfToken = getToken();
      const res = await fetch(`${appBasename}/api/sources/${id}/connect`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken || '',
        },
      });
      if (!res.ok) return;

      refreshSources();

      // Poll the per-source status endpoint up to 20s, bailing early on
      // connect success. Uses refetchQueries (not invalidate) so the loop
      // doesn't have to re-check cache state each tick — the refetched value
      // lands in the cache and fuels the next iteration's check.
      const deadlineMs = Date.now() + 20_000;
      while (Date.now() < deadlineMs) {
        await queryClient.refetchQueries({ queryKey: ['dashboard', 'status', id], type: 'active' });
        const cached = queryClient.getQueriesData<{ connected?: boolean } | null>({ queryKey: ['dashboard', 'status', id] });
        const connected = cached.some(([, data]) => data?.connected === true);
        if (connected) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      setConnectingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Counterpart to onConnectSource — stops the manager without disabling the
  // source. Exposed in the kebab menu when the source has autoConnect=false
  // and is currently connected.
  const onDisconnectSource = async (id: string) => {
    const csrfToken = getToken();
    const res = await fetch(`${appBasename}/api/sources/${id}/disconnect`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken || '',
      },
    });
    if (res.ok) {
      refreshSources();
      // Force an immediate status refetch so the "Connected" dot flips to
      // "Idle" without waiting for the next 15s poll tick.
      queryClient.refetchQueries({ queryKey: ['dashboard', 'status', id], type: 'active' });
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
          sources={sidebarSources}
          statusMap={statusMap}
          unifiedStatus={unifiedStatus}
          nodeCounts={nodeCounts}
          selectedSourceId={selectedSourceId}
          onSelectSource={setSelectedSourceId}
          isAdmin={isAdmin}
          isAuthenticated={isAuthenticated}
          onAddSource={onAddSource}
          onEditSource={onEditSource}
          onToggleSource={onToggleSource}
          onDeleteSource={onDeleteSource}
          onConnectSource={onConnectSource}
          onDisconnectSource={onDisconnectSource}
          connectingIds={connectingIds}
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
          maxNodeAgeHours={maxNodeAgeHours}
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

            {/* Type selector (slice 4): only meaningful when adding — type is
                immutable on edit because backend tables and managers are
                bound to the type that was chosen at creation time. */}
            {!editingSourceId && (
              <label className="dashboard-form-field">
                <span className="dashboard-form-label">{t('source.form.type', 'Type')}</span>
                <select
                  className="dashboard-form-input"
                  value={formType}
                  onChange={(e) => setFormType(e.target.value as 'meshtastic_tcp' | 'meshcore')}
                >
                  <option value="meshtastic_tcp">{t('source.form.type_meshtastic', 'Meshtastic (TCP)')}</option>
                  <option value="meshcore">{t('source.form.type_meshcore', 'MeshCore (USB)')}</option>
                </select>
              </label>
            )}

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

            {formType === 'meshcore' ? (
              <>
                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('meshcore.form.transport', 'Transport')}</span>
                  <select
                    className="dashboard-form-input"
                    value={formMcTransport}
                    onChange={(e) => setFormMcTransport(e.target.value as 'usb' | 'tcp')}
                  >
                    <option value="usb">{t('meshcore.form.transport_usb', 'USB / Serial')}</option>
                    <option value="tcp">{t('meshcore.form.transport_tcp', 'TCP')}</option>
                  </select>
                </label>

                {formMcTransport === 'tcp' ? (
                  <>
                    <label className="dashboard-form-field">
                      <span className="dashboard-form-label">{t('source.form.host')}</span>
                      <input
                        className="dashboard-form-input"
                        type="text"
                        value={formMcTcpHost}
                        onChange={(e) => setFormMcTcpHost(e.target.value)}
                        placeholder={t('source.form.host_placeholder')}
                      />
                      <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                        {t('meshcore.form.tcp_host_help', 'Hostname or IP of the MeshCore companion reachable over TCP (e.g. esp-link, ser2net, or native TCP firmware).')}
                      </p>
                    </label>

                    <label className="dashboard-form-field">
                      <span className="dashboard-form-label">{t('source.form.tcp_port')}</span>
                      <input
                        className="dashboard-form-input"
                        type="number"
                        value={formMcTcpPort}
                        onChange={(e) => setFormMcTcpPort(e.target.value)}
                        placeholder="4403"
                      />
                    </label>
                  </>
                ) : (
                  <label className="dashboard-form-field">
                    <span className="dashboard-form-label">{t('meshcore.form.serial_port', 'Serial Port')}</span>
                    <input
                      className="dashboard-form-input"
                      type="text"
                      value={formMcSerialPort}
                      onChange={(e) => setFormMcSerialPort(e.target.value)}
                      placeholder="/dev/ttyACM0"
                    />
                    <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                      {t('meshcore.form.serial_port_help', 'OS path of the USB-connected MeshCore companion (e.g. /dev/ttyACM0, COM3).')}
                    </p>
                  </label>
                )}

                <label className="dashboard-form-field">
                  <span className="dashboard-form-label">{t('meshcore.form.device_type', 'Device Type')}</span>
                  <select
                    className="dashboard-form-input"
                    value={formMcDeviceType}
                    onChange={(e) => setFormMcDeviceType(e.target.value as 'companion' | 'repeater')}
                  >
                    <option value="companion">{t('meshcore.device_type.companion', 'Companion')}</option>
                    <option value="repeater">{t('meshcore.device_type.repeater', 'Repeater')}</option>
                  </select>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '8px 0 4px' }}>
                  <input
                    type="checkbox"
                    checked={formAutoConnect}
                    onChange={(e) => setFormAutoConnect(e.target.checked)}
                  />
                  {t('source.form.auto_connect')}
                </label>
                <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '0 0 8px 24px' }}>
                  {t('source.form.auto_connect_help')}
                </p>
              </>
            ) : (
            <>
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

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '8px 0 4px' }}>
              <input
                type="checkbox"
                checked={formAutoConnect}
                onChange={(e) => setFormAutoConnect(e.target.checked)}
              />
              {t('source.form.auto_connect')}
            </label>
            <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '0 0 8px 24px' }}>
              {t('source.form.auto_connect_help')}
            </p>

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
            </>
            )}

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
