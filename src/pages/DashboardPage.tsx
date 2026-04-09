/**
 * DashboardPage — MeshMonitor 4.0 landing page.
 *
 * Wraps the inner dashboard in a SettingsProvider so map tile preferences
 * are available, then wires together DashboardSidebar + DashboardMap with
 * per-source data fetched via the useDashboardData hooks.
 */

import { useState, useEffect } from 'react';
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
import { appBasename } from '../init';
import '../styles/dashboard.css';

// ---------------------------------------------------------------------------
// DashboardInner — rendered inside SettingsProvider
// ---------------------------------------------------------------------------

function DashboardInner() {
  const { authStatus } = useAuth();
  const { getToken } = useCsrf();
  const { mapTileset, customTilesets, defaultMapCenterLat, defaultMapCenterLon } = useSettings();

  const isAuthenticated = authStatus?.authenticated ?? false;
  const isAdmin = authStatus?.user?.isAdmin ?? false;
  const username = authStatus?.user?.username ?? null;

  const defaultCenter = {
    lat: defaultMapCenterLat ?? 30.0,
    lng: defaultMapCenterLon ?? -90.0,
  };

  // ----- state -----
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Source add/edit modal state
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('4403');
  const [formVnEnabled, setFormVnEnabled] = useState(false);
  const [formVnPort, setFormVnPort] = useState('');
  const [formVnAllowAdmin, setFormVnAllowAdmin] = useState(false);
  const [formHeartbeat, setFormHeartbeat] = useState('0'); // seconds, 0 = disabled (issue 2609)
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

  // Build node-count map — selected source gets real count, others get 0
  const nodeCounts = new Map<string, number>(
    sources.map((s) => [
      s.id,
      s.id === selectedSourceId ? sourceData.nodes.length : 0,
    ]),
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
    setFormHeartbeat('0');
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
    if (!formName.trim()) { setFormError('Name is required'); return; }
    if (!formHost.trim()) { setFormError('Host is required'); return; }
    const port = parseInt(formPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) { setFormError('Port must be 1–65535'); return; }

    // Heartbeat interval (issue 2609): 0 = disabled, otherwise a positive
    // number of seconds. We clamp to a sane range to prevent pathological
    // configurations (sub-second floods or 24h naps that defeat the point).
    const heartbeatSeconds = parseInt(formHeartbeat, 10);
    if (isNaN(heartbeatSeconds) || heartbeatSeconds < 0 || heartbeatSeconds > 3600) {
      setFormError('Heartbeat must be 0 (disabled) or 1–3600 seconds');
      return;
    }

    let vnConfig: { enabled: boolean; port: number; allowAdminCommands: boolean } | undefined;
    if (formVnEnabled) {
      const vnPort = parseInt(formVnPort, 10);
      if (isNaN(vnPort) || vnPort < 1 || vnPort > 65535) {
        setFormError('Virtual Node port must be 1–65535');
        return;
      }
      if (vnPort === port) {
        setFormError('Virtual Node port cannot equal the source TCP port');
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
        setFormError((err as any).error ?? 'Save failed');
        return;
      }
      setShowSourceModal(false);
    } catch {
      setFormError('Network error');
    } finally {
      setFormSaving(false);
    }
  };

  const onToggleSource = async (id: string, enabled: boolean) => {
    const csrfToken = getToken();
    await fetch(`${appBasename}/api/sources/${id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken || '',
      },
      body: JSON.stringify({ enabled }),
    });
  };

  const onDeleteSource = (id: string) => {
    setDeleteConfirm(id);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    const csrfToken = getToken();
    await fetch(`${appBasename}/api/sources/${deleteConfirm}`, {
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
  };

  // ----- render -----
  return (
    <div className="dashboard-page">
      {/* Top bar */}
      <header className="dashboard-topbar">
        <div className="dashboard-topbar-logo">
          <img src={`${appBasename}/logo.png`} alt="MeshMonitor Logo" className="dashboard-topbar-logo-img" />
          <span className="dashboard-topbar-title">MeshMonitor</span>
        </div>
        <div className="dashboard-topbar-actions">
          {isAdmin && (
            <button className="dashboard-add-source-btn" onClick={onAddSource}>
              + Add Source
            </button>
          )}
          {isAuthenticated ? (
            <span style={{ fontSize: 13, color: 'var(--ctp-subtext1)', fontWeight: 500 }}>👤 {username}</span>
          ) : (
            <button
              className="dashboard-signin-btn"
              onClick={() => setShowLogin(true)}
            >
              🔒 Sign In
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
        />

        <DashboardMap
          nodes={sourceData.nodes}
          traceroutes={sourceData.traceroutes}
          neighborInfo={sourceData.neighborInfo}
          channels={sourceData.channels}
          tilesetId={mapTileset}
          customTilesets={customTilesets}
          defaultCenter={defaultCenter}
        />
      </div>

      {/* Login modal */}
      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="dashboard-confirm-overlay">
          <div className="dashboard-confirm-dialog">
            <h3>Delete Source</h3>
            <p>Are you sure you want to delete this source? This will remove the source and all its data.</p>
            <div className="dashboard-confirm-actions">
              <button onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit source modal */}
      {showSourceModal && (
        <div className="dashboard-confirm-overlay" onClick={() => setShowSourceModal(false)}>
          <div className="dashboard-confirm-dialog" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3>{editingSourceId ? 'Edit Source' : 'Add Source'}</h3>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">Name</span>
              <input
                className="dashboard-form-input"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Home Node"
                autoFocus
              />
            </label>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">Host / IP</span>
              <input
                className="dashboard-form-input"
                type="text"
                value={formHost}
                onChange={(e) => setFormHost(e.target.value)}
                placeholder="192.168.1.100"
              />
            </label>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">TCP Port</span>
              <input
                className="dashboard-form-input"
                type="number"
                value={formPort}
                onChange={(e) => setFormPort(e.target.value)}
                placeholder="4403"
              />
            </label>

            <label className="dashboard-form-field">
              <span className="dashboard-form-label">Heartbeat (seconds, 0 = off)</span>
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
                Sends a periodic keepalive to the node. Try 30–60s for CLIENT_MUTE or other quiet nodes that receive little mesh traffic, otherwise leave at 0.
              </p>
            </label>

            <fieldset style={{ border: '1px solid var(--ctp-surface1)', borderRadius: 6, padding: '8px 12px 12px', margin: '8px 0' }}>
              <legend style={{ fontSize: 12, padding: '0 6px', color: 'var(--ctp-subtext0)' }}>Virtual Node</legend>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={formVnEnabled}
                  onChange={(e) => setFormVnEnabled(e.target.checked)}
                />
                Enable Virtual Node
              </label>
              {formVnEnabled && (
                <>
                  <label className="dashboard-form-field" style={{ marginTop: 8 }}>
                    <span className="dashboard-form-label">Virtual Node Port</span>
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
                    Allow admin commands
                  </label>
                  <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>
                    Third-party clients connected to the virtual node can send admin commands to your Meshtastic node. Leave off unless you trust the clients.
                  </p>
                </>
              )}
            </fieldset>

            {formError && (
              <p style={{ color: 'var(--ctp-red)', fontSize: 12, margin: '8px 0 0' }}>{formError}</p>
            )}

            <div className="dashboard-confirm-actions" style={{ marginTop: 16 }}>
              <button onClick={() => setShowSourceModal(false)}>Cancel</button>
              <button onClick={onSaveSource} disabled={formSaving} style={{ background: 'var(--ctp-blue)', color: 'var(--ctp-base)' }}>
                {formSaving ? 'Saving...' : 'Save'}
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
      <DashboardInner />
    </SettingsProvider>
  );
}
