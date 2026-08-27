import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiService from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { UiIcon, type UiIconName } from '../icons';
import ScriptDependenciesPanel from '../auto-responder/ScriptDependenciesPanel';
import styles from './ScriptsSection.module.css';

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
      // The endpoint uses the shared envelope: { success, data: { scripts } }.
      // apiService.get returns the raw body and does not unwrap `data`.
      const body = await apiService.get<{ data?: { scripts?: InventoryScript[] } }>('/api/scripts/inventory');
      setScripts(body.data?.scripts ?? []);
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
      <p className={styles.description}>
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

      <div className={styles.toolbar}>
        {canWrite && (
          <button className={styles.importBtn} onClick={handleImportClick} disabled={isImporting}>
            {isImporting ? 'Importing…' : <><UiIcon name="import" size={15} /> Import Script</>}
          </button>
        )}

        <input
          className={styles.searchInput}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search scripts…"
        />

        <select
          className={styles.filterSelect}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
        >
          <option value="all">All</option>
          <option value="used">In use</option>
          <option value="unused">Unused</option>
        </select>

        <a
          className={styles.galleryLink}
          href="https://meshmonitor.org/user-scripts.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          Script Gallery
        </a>
      </div>

      {loading ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : scripts.length === 0 ? (
        <div className={styles.emptyState}>No scripts found in /data/scripts/</div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>No scripts match the current filter.</div>
      ) : (
        <div className={styles.list}>
          {filtered.map(script => {
            const inUse = script.usedBy.length > 0;
            const isConfirming = confirmDelete === script.filename;
            return (
              <div key={script.path} className={styles.card}>
                <div className={styles.cardHeader}>
                  <span className={styles.scriptName}>
                    <span className={styles.scriptTitle}>
                      {script.emoji
                        ? <span>{script.emoji}</span>
                        : <UiIcon name={getLanguageIcon(script.language)} size={15} />}
                      {script.name || script.filename}
                    </span>
                    <div className={styles.scriptMeta}>
                      <code>{script.filename}</code>
                      {' · '}{script.language}
                      {script.version ? ` · v${script.version}` : ''}
                      {script.author ? ` · ${script.author}` : ''}
                      {' · '}{formatBytes(script.sizeBytes)}
                      {' · '}updated {formatDate(script.lastModified)}
                    </div>
                  </span>

                  <span className={`${styles.badge} ${inUse ? styles.badgeInUse : styles.badgeUnused}`}>
                    {inUse ? 'In use' : 'Unused'}
                  </span>

                  {canWrite && !isConfirming && (
                    <button
                      className={styles.deleteBtn}
                      onClick={() => setConfirmDelete(script.filename)}
                      disabled={isDeleting === script.filename}
                    >
                      <UiIcon name="delete" size={13} /> Delete
                    </button>
                  )}
                </div>

                {inUse && (
                  <ul className={styles.usageList}>
                    {script.usedBy.map((ref, i) => (
                      <li key={`${ref.sourceId}-${ref.type}-${ref.triggerId ?? i}`}>{describeRef(ref)}</li>
                    ))}
                  </ul>
                )}

                {isConfirming && (
                  <div className={styles.confirmBox}>
                    <div className={styles.confirmText}>
                      {inUse ? (
                        <>Delete <strong>{script.filename}</strong>? It is used by {script.usedBy.length}{' '}
                        automation{script.usedBy.length === 1 ? '' : 's'} listed above, which will break until reconfigured.</>
                      ) : (
                        <>Delete <strong>{script.filename}</strong>? This cannot be undone.</>
                      )}
                    </div>
                    <div className={styles.confirmActions}>
                      <button
                        className={styles.confirmDeleteBtn}
                        onClick={() => handleDelete(script.filename)}
                        disabled={isDeleting === script.filename}
                      >
                        {isDeleting === script.filename ? 'Deleting…' : inUse ? 'Delete Anyway' : 'Delete'}
                      </button>
                      <button
                        className={styles.cancelBtn}
                        onClick={() => setConfirmDelete(null)}
                        disabled={isDeleting === script.filename}
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
