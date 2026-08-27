import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiService from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { UiIcon, type UiIconName } from '../icons';
import ScriptDependenciesPanel from '../auto-responder/ScriptDependenciesPanel';

/**
 * Scripts inventory (issue #4942).
 *
 * A global-settings section that lists every script in /data/scripts/, shows
 * which Auto Responders / Timers / Geofences use each one (or flags it as
 * unused), and lets an admin import or delete scripts. This is the read-only
 * inventory half of the proposed extension manager; remote gallery install and
 * Docker add-on management are intentionally out of scope.
 */

type ScriptTriggerType = 'auto-responder' | 'timer' | 'geofence';
type ScriptProtocol = 'meshtastic' | 'meshcore';

interface ScriptUsageRef {
  type: ScriptTriggerType;
  protocol: ScriptProtocol;
  sourceId: string;
  sourceName?: string;
  triggerId?: string;
  triggerName?: string;
  enabled: boolean;
}

interface InventoryScript {
  path: string;
  filename: string;
  name?: string;
  emoji?: string;
  language: string;
  version?: string;
  author?: string;
  sizeBytes?: number;
  lastModified?: number;
  usedBy: ScriptUsageRef[];
}

type StatusFilter = 'all' | 'used' | 'unused';

const VALID_EXTENSIONS = ['.js', '.mjs', '.py', '.sh'];

const getLanguageIcon = (language: string): UiIconName => {
  switch (language.toLowerCase()) {
    case 'shell': return 'terminal';
    case 'python':
    case 'javascript': return 'code';
    default: return 'fileCode';
  }
};

const formatBytes = (bytes?: number): string => {
  if (bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
};

const formatDate = (ms?: number): string => {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return '—';
  }
};

const TRIGGER_LABEL: Record<ScriptTriggerType, string> = {
  'auto-responder': 'Auto Responder',
  timer: 'Timer',
  geofence: 'Geofence',
};

const describeRef = (ref: ScriptUsageRef): string => {
  const kind = TRIGGER_LABEL[ref.type];
  const proto = ref.protocol === 'meshcore' ? 'MeshCore ' : '';
  const name = ref.triggerName ? ` "${ref.triggerName}"` : '';
  const source = ref.sourceName ? ` · ${ref.sourceName}` : '';
  const disabled = ref.enabled ? '' : ' (disabled)';
  return `${proto}${kind}${name}${source}${disabled}`;
};

interface ScriptsSectionProps {
  baseUrl: string;
  /** When false, import/delete controls are hidden (read-only view). */
  canWrite?: boolean;
}

const ScriptsSection: React.FC<ScriptsSectionProps> = ({ baseUrl, canWrite = true }) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  const [scripts, setScripts] = useState<InventoryScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchInventory = useCallback(async () => {
    try {
      const data = await apiService.get<{ scripts?: InventoryScript[] }>('/api/scripts/inventory');
      setScripts(data.scripts ?? []);
    } catch (error) {
      console.error('Failed to load script inventory:', error);
      showToast('Failed to load script inventory', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void fetchInventory();
  }, [fetchInventory]);

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;

    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!VALID_EXTENSIONS.includes(ext)) {
      showToast(`Unsupported file type. Allowed: ${VALID_EXTENSIONS.join(', ')}`, 'error');
      return;
    }

    setIsImporting(true);
    try {
      const body = await file.arrayBuffer();
      const response = await csrfFetch(`${baseUrl}/api/scripts/import`, {
        method: 'POST',
        headers: { 'x-filename': file.name, 'Content-Type': 'application/octet-stream' },
        body,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to import script');
      }
      showToast(`Imported ${file.name}`, 'success');
      await fetchInventory();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to import script', 'error');
    } finally {
      setIsImporting(false);
    }
  };

  const handleDelete = async (filename: string) => {
    setIsDeleting(filename);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to delete script');
      }
      showToast(`Deleted ${filename}`, 'success');
      setConfirmDelete(null);
      await fetchInventory();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to delete script', 'error');
    } finally {
      setIsDeleting(null);
    }
  };

  const usedCount = useMemo(() => scripts.filter(s => s.usedBy.length > 0).length, [scripts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scripts.filter(s => {
      if (statusFilter === 'used' && s.usedBy.length === 0) return false;
      if (statusFilter === 'unused' && s.usedBy.length > 0) return false;
      if (!q) return true;
      return (
        s.filename.toLowerCase().includes(q) ||
        (s.name?.toLowerCase().includes(q) ?? false) ||
        (s.author?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [scripts, search, statusFilter]);

  return (
    <div id="settings-scripts" className="settings-section">
      <h3><UiIcon name="list" size={18} style={{ marginRight: '0.4rem', verticalAlign: 'text-bottom' }} /> Scripts</h3>
      <p style={{ color: 'var(--color-text-subtle)', fontSize: '0.85rem', marginTop: '-0.25rem' }}>
        Scripts in <code>/data/scripts/</code> available to Auto Responders, Timers, and Geofences.
        {scripts.length > 0 && ` ${scripts.length} installed, ${usedCount} in use.`}
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept={VALID_EXTENSIONS.join(',')}
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      <div style={{ display: 'flex', gap: '0.5rem', margin: '0.75rem 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {canWrite && (
          <button
            onClick={handleImportClick}
            disabled={isImporting}
            style={{
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              background: isImporting ? 'var(--color-surface-active)' : 'var(--color-accent)',
              color: isImporting ? 'var(--color-text-subtle)' : 'var(--color-bg)',
              border: 'none',
              borderRadius: '4px',
              cursor: isImporting ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            {isImporting ? 'Importing…' : <><UiIcon name="import" size={15} /> Import Script</>}
          </button>
        )}

        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search scripts…"
          style={{
            flex: '1 1 160px',
            minWidth: '140px',
            padding: '0.45rem 0.6rem',
            fontSize: '0.85rem',
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: '4px',
          }}
        />

        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          style={{
            padding: '0.45rem 0.6rem',
            fontSize: '0.85rem',
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: '4px',
          }}
        >
          <option value="all">All</option>
          <option value="used">In use</option>
          <option value="unused">Unused</option>
        </select>

        <a
          href="https://meshmonitor.org/user-scripts.html"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.875rem',
            background: 'var(--color-accent-alt)',
            color: 'var(--color-bg)',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold',
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          Script Gallery
        </a>
      </div>

      {loading ? (
        <div style={{ padding: '1rem', color: 'var(--color-text-subtle)', fontStyle: 'italic' }}>Loading…</div>
      ) : scripts.length === 0 ? (
        <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--color-text-subtle)', fontStyle: 'italic' }}>
          No scripts found in /data/scripts/
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--color-text-subtle)', fontStyle: 'italic' }}>
          No scripts match the current filter.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {filtered.map(script => {
            const inUse = script.usedBy.length > 0;
            const isConfirming = confirmDelete === script.filename;
            return (
              <div
                key={script.path}
                style={{
                  padding: '0.75rem',
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: '4px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: '0.95rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                      {script.emoji
                        ? <span>{script.emoji}</span>
                        : <UiIcon name={getLanguageIcon(script.language)} size={15} />}
                      {script.name || script.filename}
                    </span>
                    <div style={{ fontSize: '0.78rem', color: 'var(--color-text-subtle)', marginTop: '0.15rem' }}>
                      <code>{script.filename}</code>
                      {' · '}{script.language}
                      {script.version ? ` · v${script.version}` : ''}
                      {script.author ? ` · ${script.author}` : ''}
                      {' · '}{formatBytes(script.sizeBytes)}
                      {' · '}updated {formatDate(script.lastModified)}
                    </div>
                  </span>

                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      padding: '0.15rem 0.5rem',
                      borderRadius: '999px',
                      background: inUse ? 'var(--color-success)' : 'var(--color-surface-active)',
                      color: inUse ? 'var(--color-bg)' : 'var(--color-text-subtle)',
                    }}
                  >
                    {inUse ? 'In use' : 'Unused'}
                  </span>

                  {canWrite && !isConfirming && (
                    <button
                      onClick={() => setConfirmDelete(script.filename)}
                      disabled={isDeleting === script.filename}
                      style={{
                        flexShrink: 0,
                        padding: '0.25rem 0.6rem',
                        fontSize: '0.75rem',
                        background: 'var(--color-error)',
                        color: 'var(--color-bg)',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                      }}
                    >
                      <UiIcon name="delete" size={13} /> Delete
                    </button>
                  )}
                </div>

                {inUse && (
                  <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem', fontSize: '0.78rem', color: 'var(--color-text)' }}>
                    {script.usedBy.map((ref, i) => (
                      <li key={`${ref.sourceId}-${ref.type}-${ref.triggerId ?? i}`}>{describeRef(ref)}</li>
                    ))}
                  </ul>
                )}

                {isConfirming && (
                  <div
                    style={{
                      marginTop: '0.6rem',
                      padding: '0.6rem',
                      background: 'var(--color-surface-hover)',
                      border: '1px solid var(--color-error)',
                      borderRadius: '4px',
                    }}
                  >
                    <div style={{ fontSize: '0.82rem', marginBottom: '0.5rem' }}>
                      {inUse ? (
                        <>Delete <strong>{script.filename}</strong>? It is used by {script.usedBy.length}{' '}
                        automation{script.usedBy.length === 1 ? '' : 's'} listed above, which will break until reconfigured.</>
                      ) : (
                        <>Delete <strong>{script.filename}</strong>? This cannot be undone.</>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        onClick={() => handleDelete(script.filename)}
                        disabled={isDeleting === script.filename}
                        style={{
                          padding: '0.3rem 0.75rem',
                          fontSize: '0.78rem',
                          background: 'var(--color-error)',
                          color: 'var(--color-bg)',
                          border: 'none',
                          borderRadius: '3px',
                          cursor: 'pointer',
                          fontWeight: 'bold',
                        }}
                      >
                        {isDeleting === script.filename ? 'Deleting…' : inUse ? 'Delete Anyway' : 'Delete'}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        disabled={isDeleting === script.filename}
                        style={{
                          padding: '0.3rem 0.75rem',
                          fontSize: '0.78rem',
                          background: 'var(--color-surface-hover)',
                          color: 'var(--color-text)',
                          border: '1px solid var(--color-border-subtle)',
                          borderRadius: '3px',
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ScriptDependenciesPanel />
    </div>
  );
};

export default ScriptsSection;
