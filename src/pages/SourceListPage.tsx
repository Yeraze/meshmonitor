/**
 * Source List Page
 *
 * Landing page for multi-source deployments. Shows all configured sources as
 * cards with live connection status and node count. Auto-redirects to the
 * single source when only one is configured (preserves v3 UX).
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { appBasename } from '../init';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import LoginModal from '../components/LoginModal';
import '../styles/sources.css';

interface SourceRecord {
  id: string;
  name: string;
  type: 'meshtastic_tcp' | 'mqtt' | 'meshcore';
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface SourceStatus {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  connected: boolean;
  nodeNum?: number;
  nodeId?: string;
}

interface SourceNodeCount {
  count: number;
}

interface SourceFormData {
  name: string;
  host: string;
  port: string;
}

const DEFAULT_FORM: SourceFormData = { name: '', host: '', port: '4403' };

export default function SourceListPage() {
  const navigate = useNavigate();
  const { authStatus } = useAuth();
  const isAdmin = authStatus?.user?.isAdmin ?? false;
  const isAuthenticated = authStatus?.authenticated ?? false;
  const csrfFetch = useCsrfFetch();

  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [statuses, setStatuses] = useState<Record<string, SourceStatus>>({});
  const [nodeCounts, setNodeCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [editingSource, setEditingSource] = useState<SourceRecord | null>(null);
  const [formData, setFormData] = useState<SourceFormData>(DEFAULT_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch(`${appBasename}/api/sources`, { credentials: 'include' });
      if (!res.ok) return;
      const data: SourceRecord[] = await res.json();
      setSources(data);

      // Auto-redirect when only one source exists (single-source deployments)
      if (data.length === 1) {
        navigate(`/source/${data[0].id}`, { replace: true });
        return;
      }

      // Fetch status and node count for each source in parallel
      const statusResults = await Promise.allSettled(
        data.map(s =>
          fetch(`${appBasename}/api/sources/${s.id}/status`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : null)
        )
      );
      const countResults = await Promise.allSettled(
        data.map(s =>
          fetch(`${appBasename}/api/sources/${s.id}/nodes`, { credentials: 'include' })
            .then(r => r.ok ? r.json() as Promise<unknown[]> : [])
            .then(nodes => ({ count: nodes.length }))
        )
      );

      const newStatuses: Record<string, SourceStatus> = {};
      const newCounts: Record<string, number> = {};
      data.forEach((s, i) => {
        const sr = statusResults[i];
        if (sr.status === 'fulfilled' && sr.value) newStatuses[s.id] = sr.value;
        const cr = countResults[i];
        if (cr.status === 'fulfilled') newCounts[s.id] = (cr.value as SourceNodeCount).count;
      });
      setStatuses(newStatuses);
      setNodeCounts(newCounts);
    } catch (err) {
      console.error('Failed to load sources:', err);
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    fetchSources();
    const interval = setInterval(fetchSources, 15000);
    return () => clearInterval(interval);
  }, [fetchSources]);

  const openAdd = () => {
    setEditingSource(null);
    setFormData(DEFAULT_FORM);
    setFormError('');
    setShowAddModal(true);
  };

  const openEdit = (source: SourceRecord) => {
    setEditingSource(source);
    const cfg = source.config as any;
    setFormData({
      name: source.name,
      host: cfg.host ?? '',
      port: String(cfg.port ?? 4403),
    });
    setFormError('');
    setShowAddModal(true);
  };

  const handleSave = async () => {
    if (!formData.name.trim()) { setFormError('Name is required'); return; }
    if (!formData.host.trim()) { setFormError('Host is required'); return; }
    const port = parseInt(formData.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) { setFormError('Port must be 1–65535'); return; }

    setSaving(true);
    setFormError('');
    try {
      const body = {
        name: formData.name.trim(),
        type: 'meshtastic_tcp',
        config: { host: formData.host.trim(), port },
        enabled: true,
      };
      const url = editingSource
        ? `${appBasename}/api/sources/${editingSource.id}`
        : `${appBasename}/api/sources`;
      const method = editingSource ? 'PUT' : 'POST';

      const res = await csrfFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setFormError((err as any).error ?? 'Save failed');
        return;
      }
      setShowAddModal(false);
      await fetchSources();
    } catch (err) {
      setFormError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (source: SourceRecord) => {
    if (!confirm(`Delete source "${source.name}"? This cannot be undone.`)) return;
    try {
      await csrfFetch(`${appBasename}/api/sources/${source.id}`, { method: 'DELETE' });
      await fetchSources();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleToggleEnabled = async (source: SourceRecord) => {
    try {
      await csrfFetch(`${appBasename}/api/sources/${source.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !source.enabled }),
      });
      await fetchSources();
    } catch (err) {
      console.error('Toggle failed:', err);
    }
  };

  if (loading) {
    return <div className="sources-page__loading">Loading sources…</div>;
  }

  return (
    <div className="sources-page">
      {/* Header */}
      <div className="sources-header">
        <div className="sources-header__title">
          <h1>MeshMonitor</h1>
          <p>Select a source to monitor</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!isAuthenticated && (
            <button className="sources-header__add-btn" style={{ background: 'var(--ctp-surface1)', color: 'var(--ctp-text)' }} onClick={() => setShowLoginModal(true)}>
              Sign In
            </button>
          )}
          {isAdmin && (
            <button className="sources-header__add-btn" onClick={openAdd}>+ Add Source</button>
          )}
        </div>
      </div>

      {/* Cross-source quick links (only when multiple sources) */}
      {sources.length > 1 && (
        <div className="sources-quick-links">
          <button className="sources-quick-link" onClick={() => navigate('/unified/messages')}
            style={{ color: 'var(--ctp-blue)' }}>
            <span>💬</span> Unified Messages
          </button>
          <button className="sources-quick-link" onClick={() => navigate('/unified/telemetry')}
            style={{ color: 'var(--ctp-green)' }}>
            <span>📡</span> Unified Telemetry
          </button>
          <button className="sources-quick-link" onClick={() => navigate('/analysis')}
            style={{ color: 'var(--ctp-mauve)' }}>
            <span>📊</span> Analysis
          </button>
        </div>
      )}

      {/* Source cards */}
      {sources.length === 0 ? (
        <div className="sources-empty">
          <p>No sources configured.</p>
          {isAdmin && <p>Click <strong>+ Add Source</strong> to connect a Meshtastic node.</p>}
        </div>
      ) : (
        <div className="sources-grid">
          {sources.map(source => {
            const status = statuses[source.id];
            const count = nodeCounts[source.id] ?? 0;
            const connected = status?.connected ?? false;
            const cfg = source.config as any;
            const statusKey = connected ? 'connected' : source.enabled ? 'connecting' : 'disabled';
            const statusLabel = connected ? 'Connected' : source.enabled ? 'Connecting' : 'Disabled';

            return (
              <div
                key={source.id}
                className={`source-card${connected ? ' source-card--connected' : ''}`}
              >
                <div className="source-card__header">
                  <div>
                    <h2 className="source-card__name">{source.name}</h2>
                    <p className="source-card__meta">{source.type} · {cfg.host}:{cfg.port ?? 4403}</p>
                  </div>
                  <span className={`source-card__status source-card__status--${statusKey}`}>
                    <span className={`source-card__status-dot source-card__status-dot--${statusKey}`} />
                    {statusLabel}
                  </span>
                </div>

                <div className="source-card__stats">
                  <div className="source-card__stat">
                    <div className="source-card__stat-value">{count}</div>
                    <div className="source-card__stat-label">Nodes</div>
                  </div>
                  {status?.nodeId && (
                    <div className="source-card__stat" style={{ flex: 2 }}>
                      <div className="source-card__node-id">{status.nodeId}</div>
                      <div className="source-card__stat-label">Local node</div>
                    </div>
                  )}
                </div>

                <div className="source-card__actions">
                  <button
                    onClick={() => navigate(`/source/${source.id}`)}
                    disabled={!source.enabled}
                    className={`source-card__open-btn source-card__open-btn--${source.enabled ? 'enabled' : 'disabled'}`}
                  >
                    Open
                  </button>
                  {isAdmin && (
                    <>
                      <button className="source-card__icon-btn" onClick={() => openEdit(source)} title="Edit">✎</button>
                      <button className="source-card__icon-btn" onClick={() => handleToggleEnabled(source)} title={source.enabled ? 'Disable' : 'Enable'}>
                        {source.enabled ? '⏸' : '▶'}
                      </button>
                      <button className="source-card__icon-btn source-card__icon-btn--danger" onClick={() => handleDelete(source)} title="Delete">✕</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <LoginModal isOpen={showLoginModal} onClose={() => { setShowLoginModal(false); fetchSources(); }} />

      {/* Add/Edit modal */}
      {showAddModal && (
        <div className="sources-modal-overlay">
          <div className="sources-modal">
            <h2>{editingSource ? 'Edit Source' : 'Add Source'}</h2>

            <label className="sources-modal__field">
              <span className="sources-modal__label">Name</span>
              <input
                type="text"
                className="sources-modal__input"
                value={formData.name}
                onChange={e => setFormData(f => ({ ...f, name: e.target.value }))}
                placeholder="Home Node"
              />
            </label>

            <label className="sources-modal__field">
              <span className="sources-modal__label">Host / IP</span>
              <input
                type="text"
                className="sources-modal__input"
                value={formData.host}
                onChange={e => setFormData(f => ({ ...f, host: e.target.value }))}
                placeholder="192.168.1.100"
              />
            </label>

            <label className="sources-modal__field" style={{ marginBottom: 22 }}>
              <span className="sources-modal__label">TCP Port</span>
              <input
                type="number"
                className="sources-modal__input"
                value={formData.port}
                onChange={e => setFormData(f => ({ ...f, port: e.target.value }))}
                placeholder="4403"
              />
            </label>

            {formError && <p className="sources-modal__error">{formError}</p>}

            <div className="sources-modal__actions">
              <button className="sources-modal__cancel" onClick={() => setShowAddModal(false)}>Cancel</button>
              <button className="sources-modal__save" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
