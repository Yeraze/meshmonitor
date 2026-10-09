/**
 * ReliablePkiSection — the "Reliable PKI" setting (#5691).
 *
 * When a node stops answering our PKI-encrypted DMs or data requests,
 * MeshMonitor can send it our NodeInfo (with our public key) first, at most
 * once an hour per node. Two placements:
 *
 *   - `scope="global"`: the install-wide default, `reliablePkiMode`
 *     (`off` | `asNeeded`), in Global Settings → Security.
 *   - `scope="source"`: this source's override, `reliablePkiSourceMode`
 *     (`inherit` | `off` | `asNeeded`), on a Meshtastic source's Settings page.
 *     Saved with `?sourceId=` so the server stores it under the source-scoped key.
 *
 * Self-saving through the shared save bar, like ReticulumRetentionSection.
 * Default Off. Saving changes only the mode: the per-node hourly timer lives in
 * the database and a save never resets it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { logger } from '../../utils/logger';
import { UiIcon } from '../icons';
import styles from './ReliablePkiSection.module.css';

export const RELIABLE_PKI_SECTION_ID = 'settings-reliable-pki';

const GLOBAL_KEY = 'reliablePkiMode';
const SOURCE_KEY = 'reliablePkiSourceMode';

type GlobalMode = 'off' | 'asNeeded';
type SourceMode = 'inherit' | GlobalMode;

const parseGlobal = (v: unknown): GlobalMode => (v === 'asNeeded' ? 'asNeeded' : 'off');
const parseSource = (v: unknown): SourceMode => (v === 'off' || v === 'asNeeded' ? v : 'inherit');

export interface ReliablePkiSectionProps {
  scope: 'global' | 'source';
  /** Required for `scope="source"`. */
  sourceId?: string | null;
}

export const ReliablePkiSection: React.FC<ReliablePkiSectionProps> = ({ scope, sourceId }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = scope === 'global'
    ? hasPermission('settings', 'write', { anySource: true })
    : hasPermission('settings', 'write', { sourceId: sourceId ?? null });

  const [value, setValue] = useState<SourceMode>(scope === 'global' ? 'off' : 'inherit');
  const [initial, setInitial] = useState<SourceMode>(scope === 'global' ? 'off' : 'inherit');
  const [globalDefault, setGlobalDefault] = useState<GlobalMode>('off');
  const [loaded, setLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const query = scope === 'source' && sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      try {
        const settings = await apiService.get<Record<string, string>>(`/api/settings${query}`);
        if (cancelled) return;
        // The global key is global-only, so the merged source view still
        // carries the install-wide default.
        const def = parseGlobal(settings?.[GLOBAL_KEY]);
        setGlobalDefault(def);
        const current: SourceMode = scope === 'global' ? def : parseSource(settings?.[SOURCE_KEY]);
        setValue(current);
        setInitial(current);
      } catch (error) {
        if (!(error instanceof ApiError)) logger.error('Failed to load Reliable PKI setting:', error);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [query, scope]);

  const hasChanges = loaded && value !== initial;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const key = scope === 'global' ? GLOBAL_KEY : SOURCE_KEY;
      await apiService.post(`/api/settings${query}`, { [key]: value });
      setInitial(value);
      if (scope === 'global') setGlobalDefault(value === 'asNeeded' ? 'asNeeded' : 'off');
      showToast(t('settings.reliable_pki.saved', 'Reliable PKI setting saved'), 'success');
    } catch (error) {
      logger.error('Failed to save Reliable PKI setting:', error);
      showToast(t('settings.reliable_pki.save_failed', 'Failed to save the Reliable PKI setting'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [scope, query, value, showToast, t]);

  const handleDismiss = useCallback(() => setValue(initial), [initial]);

  useSaveBar({
    id: `reliable-pki-${scope}`,
    sectionName: t('settings.reliable_pki.title', 'Reliable PKI'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const modeLabel = (m: GlobalMode) => (m === 'asNeeded'
    ? t('settings.reliable_pki.mode_as_needed', 'As needed')
    : t('settings.reliable_pki.mode_off', 'Off'));
  const selectId = `reliablePkiMode-${scope}`;

  const body = (
    <div className={styles.field} data-testid={`reliable-pki-${scope}`}>
      <label htmlFor={selectId}>
        {scope === 'global'
          ? t('settings.reliable_pki.global_label', 'Reliable PKI (default for every source)')
          : t('settings.reliable_pki.source_label', 'Reliable PKI for this source')}
      </label>
      <p className={styles.description}>
        {t(
          'settings.reliable_pki.description',
          'PKI only works if the other node holds your public key. Off: never send extra packets. As needed: when the last encrypted DM or request to a node got no answer, send that node your node info first, then the message.',
        )}
      </p>
      <select
        id={selectId}
        className={styles.select}
        value={value}
        disabled={!canWrite || !loaded}
        onChange={(e) => setValue(e.target.value as SourceMode)}
      >
        {scope === 'source' && (
          <option value="inherit">
            {t('settings.reliable_pki.mode_inherit', {
              mode: modeLabel(globalDefault),
              defaultValue: 'Use the global default ({{mode}})',
            })}
          </option>
        )}
        <option value="off">{modeLabel('off')}</option>
        <option value="asNeeded">{modeLabel('asNeeded')}</option>
      </select>
      <p className={styles.warning} data-testid="reliable-pki-cost-warning">
        <UiIcon name="alert" size={14} />
        <span>
          {t(
            'settings.reliable_pki.cost_warning',
            'When a node stops answering encrypted requests, MeshMonitor sends it your node info first (at most once an hour per node). Each one uses airtime on the mesh.',
          )}
        </span>
      </p>
    </div>
  );

  if (scope === 'global') return body;

  return (
    <div id={RELIABLE_PKI_SECTION_ID} className="settings-section" data-testid="reliable-pki-section">
      <h3 className={styles.heading}>
        <UiIcon name="key" size={16} />
        <span>{t('settings.reliable_pki.title', 'Reliable PKI')}</span>
      </h3>
      {body}
    </div>
  );
};

export default ReliablePkiSection;
