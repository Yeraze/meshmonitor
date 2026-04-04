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
  const csrfFetch = useCsrfFetch();

  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [statuses, setStatuses] = useState<Record<string, SourceStatus>>({});
  const [nodeCounts, setNodeCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
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
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#111' }}>
        <span style={{ color: '#aaa', fontSize: 16 }}>Loading sources…</span>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#111', color: '#eee', fontFamily: 'sans-serif', padding: 32 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, color: '#fff' }}>MeshMonitor</h1>
          <p style={{ margin: '4px 0 0', color: '#888', fontSize: 14 }}>Select a source to monitor</p>
        </div>
        {isAdmin && (
          <button
            onClick={openAdd}
            style={{
              background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8,
              padding: '10px 20px', fontSize: 14, cursor: 'pointer', fontWeight: 600,
            }}
          >
            + Add Source
          </button>
        )}
      </div>

      {/* Cross-source quick links (only when multiple sources) */}
      {sources.length > 1 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 32 }}>
          <button
            onClick={() => navigate('/unified/messages')}
            style={{
              background: '#1a1a1a', border: '1px solid #333', borderRadius: 10,
              padding: '12px 20px', color: '#93c5fd', fontSize: 14, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500,
            }}
          >
            <span>💬</span> Unified Messages
          </button>
          <button
            onClick={() => navigate('/analysis')}
            style={{
              background: '#1a1a1a', border: '1px solid #333', borderRadius: 10,
              padding: '12px 20px', color: '#86efac', fontSize: 14, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500,
            }}
          >
            <span>📊</span> Analysis
          </button>
        </div>
      )}

      {/* Source cards */}
      {sources.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '80px 0', color: '#666' }}>
          <p style={{ fontSize: 18 }}>No sources configured.</p>
          {isAdmin && (
            <p style={{ fontSize: 14 }}>
              Click <strong style={{ color: '#2563eb' }}>+ Add Source</strong> to connect a Meshtastic node.
            </p>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 }}>
          {sources.map(source => {
            const status = statuses[source.id];
            const count = nodeCounts[source.id] ?? 0;
            const connected = status?.connected ?? false;
            const cfg = source.config as any;

            return (
              <div
                key={source.id}
                style={{
                  background: '#1a1a1a', border: `1px solid ${connected ? '#22c55e33' : '#333'}`,
                  borderRadius: 12, padding: 24, display: 'flex', flexDirection: 'column', gap: 16,
                }}
              >
                {/* Card header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#fff' }}>{source.name}</h2>
                    <p style={{ margin: '4px 0 0', color: '#666', fontSize: 12 }}>
                      {source.type} · {cfg.host}:{cfg.port ?? 4403}
                    </p>
                  </div>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600,
                    background: connected ? '#14532d' : source.enabled ? '#451a03' : '#1c1c1c',
                    color: connected ? '#4ade80' : source.enabled ? '#fb923c' : '#555',
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: connected ? '#4ade80' : source.enabled ? '#fb923c' : '#555',
                    }} />
                    {connected ? 'Connected' : source.enabled ? 'Connecting' : 'Disabled'}
                  </span>
                </div>

                {/* Mini stats */}
                <div style={{ display: 'flex', gap: 16 }}>
                  <div style={{ flex: 1, background: '#222', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>{count}</div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>Nodes</div>
                  </div>
                  {status?.nodeId && (
                    <div style={{ flex: 2, background: '#222', borderRadius: 8, padding: '10px 14px' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#93c5fd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {status.nodeId}
                      </div>
                      <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>Local node</div>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                  <button
                    onClick={() => navigate(`/source/${source.id}`)}
                    disabled={!source.enabled}
                    style={{
                      flex: 1, background: source.enabled ? '#2563eb' : '#333',
                      color: source.enabled ? '#fff' : '#555', border: 'none',
                      borderRadius: 8, padding: '10px 0', fontSize: 14, fontWeight: 600,
                      cursor: source.enabled ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Open
                  </button>
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => openEdit(source)}
                        style={{
                          background: '#333', color: '#aaa', border: 'none', borderRadius: 8,
                          padding: '10px 14px', fontSize: 13, cursor: 'pointer',
                        }}
                        title="Edit"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => handleToggleEnabled(source)}
                        style={{
                          background: '#333', color: '#aaa', border: 'none', borderRadius: 8,
                          padding: '10px 14px', fontSize: 13, cursor: 'pointer',
                        }}
                        title={source.enabled ? 'Disable' : 'Enable'}
                      >
                        {source.enabled ? '⏸' : '▶'}
                      </button>
                      <button
                        onClick={() => handleDelete(source)}
                        style={{
                          background: '#333', color: '#ef4444', border: 'none', borderRadius: 8,
                          padding: '10px 14px', fontSize: 13, cursor: 'pointer',
                        }}
                        title="Delete"
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit modal */}
      {showAddModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{ background: '#1a1a1a', borderRadius: 12, padding: 32, width: 400, border: '1px solid #333' }}>
            <h2 style={{ margin: '0 0 24px', fontSize: 20, fontWeight: 700, color: '#fff' }}>
              {editingSource ? 'Edit Source' : 'Add Source'}
            </h2>

            <label style={{ display: 'block', marginBottom: 16 }}>
              <span style={{ display: 'block', fontSize: 13, color: '#999', marginBottom: 6 }}>Name</span>
              <input
                type="text"
                value={formData.name}
                onChange={e => setFormData(f => ({ ...f, name: e.target.value }))}
                placeholder="Home Node"
                style={{
                  width: '100%', padding: '10px 12px', background: '#222', border: '1px solid #444',
                  borderRadius: 8, color: '#fff', fontSize: 14, boxSizing: 'border-box',
                }}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 16 }}>
              <span style={{ display: 'block', fontSize: 13, color: '#999', marginBottom: 6 }}>Host / IP</span>
              <input
                type="text"
                value={formData.host}
                onChange={e => setFormData(f => ({ ...f, host: e.target.value }))}
                placeholder="192.168.1.100"
                style={{
                  width: '100%', padding: '10px 12px', background: '#222', border: '1px solid #444',
                  borderRadius: 8, color: '#fff', fontSize: 14, boxSizing: 'border-box',
                }}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 24 }}>
              <span style={{ display: 'block', fontSize: 13, color: '#999', marginBottom: 6 }}>TCP Port</span>
              <input
                type="number"
                value={formData.port}
                onChange={e => setFormData(f => ({ ...f, port: e.target.value }))}
                placeholder="4403"
                style={{
                  width: '100%', padding: '10px 12px', background: '#222', border: '1px solid #444',
                  borderRadius: 8, color: '#fff', fontSize: 14, boxSizing: 'border-box',
                }}
              />
            </label>

            {formError && (
              <p style={{ color: '#ef4444', fontSize: 13, marginBottom: 16 }}>{formError}</p>
            )}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowAddModal(false)}
                style={{
                  background: 'transparent', color: '#aaa', border: '1px solid #444',
                  borderRadius: 8, padding: '10px 20px', fontSize: 14, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  background: saving ? '#1d4ed8' : '#2563eb', color: '#fff', border: 'none',
                  borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 600,
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
