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

/**
 * Update status for one script (#5255). Checking reaches out to GitHub, so it
 * only happens when an admin asks, and installing is always a separate click.
 */
interface ScriptUpdateStatus {
  filename: string;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  sourceOrigin: 'script' | 'manual' | 'gallery' | null;
  source: string | null;
  sourceUrl: string | null;
  hasBackup: boolean;
  backupVersion: string | null;
  error: string | null;
}

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
  const [updates, setUpdates] = useState<Record<string, ScriptUpdateStatus>>({});
  const [isChecking, setIsChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [busyScript, setBusyScript] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState<Record<string, string>>({});
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

  // #5255: ask GitHub what each script's source publishes. Manual, never on a
  // timer, so an operator is never surprised by outbound requests.
  const handleCheckUpdates = useCallback(async () => {
    setIsChecking(true);
    try {
      // The endpoint uses the shared envelope, and apiService does not unwrap it.
      const body = await apiService.get<{ data?: { scripts?: ScriptUpdateStatus[]; checkedAt?: number } }>('/api/scripts/updates');
      const byName: Record<string, ScriptUpdateStatus> = {};
      for (const status of body.data?.scripts ?? []) byName[status.filename] = status;
      setUpdates(byName);
      setCheckedAt(body.data?.checkedAt ?? Date.now());

      const available = Object.values(byName).filter(u => u.updateAvailable).length;
      showToast(available === 0 ? 'All scripts are up to date' : `${available} update${available === 1 ? '' : 's'} available`, 'success');
    } catch (error) {
      console.error('Failed to check scripts for updates:', error);
      showToast('Failed to check scripts for updates', 'error');
    } finally {
      setIsChecking(false);
    }
  }, [showToast]);

  const handleUpdate = async (filename: string) => {
    setBusyScript(filename);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/${encodeURIComponent(filename)}/update`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'Update failed');
      const result = body.data ?? body;
      showToast(`Updated ${filename} to v${result.newVersion ?? 'the latest version'}`, 'success');
      // The response carries this script's fresh status, so refresh one card
      // rather than re-checking every script against GitHub.
      if (result.status) setUpdates(prev => ({ ...prev, [filename]: result.status }));
      await fetchInventory();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Update failed', 'error');
    } finally {
      setBusyScript(null);
    }
  };

  const handleRollback = async (filename: string) => {
    setBusyScript(filename);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/${encodeURIComponent(filename)}/rollback`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'Rollback failed');
      const result = body.data ?? body;
      showToast(`Restored ${filename}${result.restoredVersion ? ` to v${result.restoredVersion}` : ''}`, 'success');
      if (result.status) setUpdates(prev => ({ ...prev, [filename]: result.status }));
      await fetchInventory();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Rollback failed', 'error');
    } finally {
      setBusyScript(null);
    }
  };

  const handleSaveSource = async (filename: string) => {
    setBusyScript(filename);
    try {
      const response = await csrfFetch(`${baseUrl}/api/scripts/${encodeURIComponent(filename)}/source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: sourceDraft[filename] ?? '' }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'Could not save that source');
      showToast(`Update source saved for ${filename}`, 'success');
      setSourceDraft(prev => ({ ...prev, [filename]: '' }));
      await handleCheckUpdates();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save that source', 'error');
    } finally {
      setBusyScript(null);
    }
  };

  const updateCount = useMemo(
    () => Object.values(updates).filter(u => u.updateAvailable).length,
    [updates]
  );

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
        {checkedAt !== null && (updateCount > 0
          ? ` ${updateCount} update${updateCount === 1 ? '' : 's'} available.`
          : ' All checked scripts are up to date.')}
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

        <button
          className={styles.importBtn}
          onClick={() => void handleCheckUpdates()}
          disabled={isChecking || scripts.length === 0}
          title="Ask each script's source repository which version it publishes"
        >
          {isChecking ? 'Checking…' : <><UiIcon name="refresh" size={15} /> Check for updates</>}
        </button>

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
            const update = updates[script.filename];
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

                  {update?.updateAvailable && (
                    <span className={`${styles.badge} ${styles.badgeUpdate}`}>
                      v{update.latestVersion} available
                    </span>
                  )}

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

                {update && (
                  <div className={styles.updateRow}>
                    <span className={styles.updateText}>
                      {update.source ? (
                        <>
                          Source:{' '}
                          <a href={update.sourceUrl ?? '#'} target="_blank" rel="noopener noreferrer">{update.source}</a>
                          {update.sourceOrigin === 'gallery' ? ' (from the gallery listing)' : ''}
                          {update.sourceOrigin === 'manual' ? ' (set here)' : ''}
                          {update.latestVersion ? ` · publishes v${update.latestVersion}` : ''}
                        </>
                      ) : (
                        'No update source. Add the script\'s GitHub path to check it.'
                      )}
                      {update.error ? ` · ${update.error}` : ''}
                    </span>

                    {canWrite && update.updateAvailable && (
                      <button
                        className={styles.updateBtn}
                        onClick={() => void handleUpdate(script.filename)}
                        disabled={busyScript === script.filename}
                      >
                        {busyScript === script.filename ? 'Working…' : <><UiIcon name="download" size={13} /> Update</>}
                      </button>
                    )}

                    {canWrite && update.hasBackup && (
                      <button
                        className={styles.rollbackBtn}
                        onClick={() => void handleRollback(script.filename)}
                        disabled={busyScript === script.filename}
                        title={update.backupVersion ? `Restore v${update.backupVersion}` : 'Restore the previous file'}
                      >
                        <UiIcon name="back" size={13} /> Roll back
                      </button>
                    )}

                    {canWrite && !update.source && (
                      <>
                        <input
                          className={styles.sourceInput}
                          type="text"
                          value={sourceDraft[script.filename] ?? ''}
                          onChange={e => setSourceDraft(prev => ({ ...prev, [script.filename]: e.target.value }))}
                          placeholder="owner/repo/path/to/script.py"
                        />
                        <button
                          className={styles.updateBtn}
                          onClick={() => void handleSaveSource(script.filename)}
                          disabled={busyScript === script.filename || !(sourceDraft[script.filename] ?? '').trim()}
                        >
                          Save source
                        </button>
                      </>
                    )}
                  </div>
                )}

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
