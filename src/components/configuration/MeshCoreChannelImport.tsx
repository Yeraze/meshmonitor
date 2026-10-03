/**
 * "Import from MeshCore device" for the Channel Database (#5552).
 *
 * Copies ONE MeshCore source's device channels into the channel database as
 * MeshCore virtual channels. It is opt-in and one-shot: nothing mirrors a
 * device on its own. The server skips secrets it already holds, and new
 * entries start with no user access.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';
import styles from './MeshCoreChannelImport.module.css';

interface SourceRow {
  id: string;
  name: string;
  type: string;
}

interface ImportResult {
  imported: Array<{ id: number; name: string }>;
  skipped: Array<{ name: string; reason: 'duplicate' | 'no_secret' }>;
}

interface MeshCoreChannelImportProps {
  /** Called after an import that added at least one entry. */
  onImported: () => void;
}

const MeshCoreChannelImport: React.FC<MeshCoreChannelImportProps> = ({ onImported }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadFailed(false);
    void (async () => {
      try {
        const all = await apiService.get<SourceRow[]>('/api/sources');
        if (cancelled) return;
        // Only device sources hold channels; an MQTT ingest source has none.
        const devices = (Array.isArray(all) ? all : []).filter((s) => s.type === 'meshcore');
        setSources(devices);
        setSourceId((prev) => prev || devices[0]?.id || '');
      } catch (error) {
        logger.error('Error loading sources for MeshCore channel import:', error);
        if (!cancelled) {
          setSources([]);
          setLoadFailed(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setResult(null);
  };

  const runImport = async () => {
    if (!sourceId) return;
    setBusy(true);
    try {
      const response = await apiService.importMeshcoreChannels(sourceId);
      setResult(response.data);
      if (response.data.imported.length > 0) onImported();
    } catch (error) {
      logger.error('Error importing MeshCore channels:', error);
      showToast(
        error instanceof Error ? error.message : t('channel_database.meshcore_import_failed', 'Import failed'),
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const duplicates = result?.skipped.filter((s) => s.reason === 'duplicate').length ?? 0;
  const noSecret = result?.skipped.filter((s) => s.reason === 'no_secret').length ?? 0;

  return (
    <>
      <button
        type="button"
        className={styles.button}
        onClick={() => setOpen(true)}
        title={t('channel_database.meshcore_import_title', "Copy a MeshCore device's channels into the channel database")}
      >
        {t('channel_database.meshcore_import', 'Import from MeshCore device')}
      </button>

      {open && (
        <div className={styles.backdrop} onClick={close}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label={t('channel_database.meshcore_import', 'Import from MeshCore device')}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={styles.title}>{t('channel_database.meshcore_import', 'Import from MeshCore device')}</h3>
            <p className={styles.note}>
              {t(
                'channel_database.meshcore_import_note',
                "Copies the device's channels and their keys into the channel database, so repeater and MQTT sources can decrypt them. This is a one-time copy; later changes on the device are not followed. Imported channels start with no user access: grant it under Users.",
              )}
            </p>

            {sources.length === 0 ? (
              <p>
                {loadFailed
                  ? t('channel_database.meshcore_import_sources_failed', 'Could not load the source list. Close this and try again.')
                  : t('channel_database.meshcore_import_no_sources', 'No MeshCore device source is configured.')}
              </p>
            ) : (
              <div className="setting-item">
                <label htmlFor="meshcore-import-source">
                  {t('channel_database.meshcore_import_source', 'MeshCore source')}
                </label>
                <select
                  id="meshcore-import-source"
                  className="setting-input"
                  value={sourceId}
                  disabled={busy}
                  onChange={(e) => { setSourceId(e.target.value); setResult(null); }}
                >
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}

            {result && (
              <ul className={styles.result} data-testid="meshcore-import-result">
                <li>{t('channel_database.meshcore_import_added', '{{count}} added', { count: result.imported.length })}</li>
                <li>{t('channel_database.meshcore_import_duplicates', '{{count}} already stored (same key)', { count: duplicates })}</li>
                {noSecret > 0 && (
                  <li>{t('channel_database.meshcore_import_no_secret', '{{count}} skipped (no key)', { count: noSecret })}</li>
                )}
              </ul>
            )}

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.button}
                onClick={() => void runImport()}
                disabled={busy || !sourceId}
              >
                {busy ? t('common.loading', 'Loading...') : t('common.import', 'Import')}
              </button>
              <button type="button" className={styles.secondary} onClick={close} disabled={busy}>
                {t('common.close', 'Close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default MeshCoreChannelImport;
