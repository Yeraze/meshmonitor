/**
 * MeshWars forwarder settings: send MeshCore heard-repeater results to
 * MeshWars, the territory game (https://github.com/zvx-echo6/meshwars).
 *
 * Global and admin-only, because it sends a radio's position to a third-party
 * server. Saved through POST /api/settings; status has its own route. The API
 * key is never read back: the field only replaces it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';
import apiService from '../services/api';
import styles from './MeshWarsSection.module.css';

interface MeshWarsSectionProps {
  baseUrl: string;
}

interface MeshWarsStatus {
  enabled: boolean;
  sourceId: string;
  baseUrl: string;
  apiKeySet: boolean;
  lastForwardAt: number | null;
  lastResult: { at: number; ok: boolean; repeaters: number; error?: string } | null;
  forwardedCount: number;
  skippedCount: number;
  minForwardIntervalMs: number;
}

interface SourceRow {
  id: string;
  name: string;
  type?: string;
}

interface Draft {
  enabled: boolean;
  sourceId: string;
  url: string;
  /** A new key to store; empty keeps the saved one. */
  apiKey: string;
}

const EMPTY_DRAFT: Draft = { enabled: false, sourceId: '', url: 'https://meshwars.com', apiKey: '' };

const MeshWarsSection: React.FC<MeshWarsSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  const [status, setStatus] = useState<MeshWarsStatus | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [saved, setSaved] = useState<Draft>(EMPTY_DRAFT);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [isSaving, setIsSaving] = useState(false);

  const fetchStatus = useCallback(async (seedForm = false) => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/meshwars/status`);
      if (!response.ok) return;
      const body = await response.json();
      const data: MeshWarsStatus = body.data;
      setStatus(data);
      if (!seedForm) return;
      const next: Draft = { enabled: data.enabled, sourceId: data.sourceId, url: data.baseUrl, apiKey: '' };
      setSaved(next);
      setDraft(next);
    } catch {
      // Status is informational; the form still works without it.
    }
  }, [csrfFetch, baseUrl]);

  useEffect(() => {
    void fetchStatus(true);
  }, [fetchStatus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await apiService.get<SourceRow[]>('/api/sources');
        if (cancelled) return;
        // Only a MeshCore radio correlates the repeaters that heard its sends.
        setSources((Array.isArray(all) ? all : []).filter((s) => s.type === 'meshcore'));
      } catch {
        if (!cancelled) setSources([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const hasChanges =
    draft.enabled !== saved.enabled ||
    draft.sourceId !== saved.sourceId ||
    draft.url.trim() !== saved.url ||
    draft.apiKey.trim() !== '';

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const body: Record<string, string> = {
        meshwarsEnabled: String(draft.enabled),
        meshwarsSourceId: draft.sourceId,
        meshwarsBaseUrl: draft.url.trim(),
      };
      if (draft.apiKey.trim()) body.meshwars_api_token = draft.apiKey.trim();
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        showToast(t('settings.meshwars.saved', 'Settings saved'), 'success');
        void fetchStatus(true);
      } else {
        const err = await response.json().catch(() => ({}));
        showToast(err.error || t('settings.meshwars.save_failed', 'Failed to save'), 'error');
      }
    } catch {
      showToast(t('settings.meshwars.save_failed', 'Failed to save'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [draft, csrfFetch, baseUrl, showToast, t, fetchStatus]);

  useSaveBar({
    id: 'meshwars',
    sectionName: t('settings.meshwars.title', 'MeshWars'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: () => setDraft(saved),
  });

  const cooldownMin = Math.round((status?.minForwardIntervalMs ?? 300_000) / 60_000);
  const last = status?.lastResult ?? null;

  return (
    <>
      <div className={`automation-section-header ${styles.header}`}>
        <h2 className={styles.title}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft(d => ({ ...d, enabled: e.target.checked }))}
            className={styles.enableBox}
            aria-label={t('settings.meshwars.enable', 'Send to MeshWars')}
          />
          {t('settings.meshwars.title', 'MeshWars')}
        </h2>
      </div>

      <div className={`settings-section ${draft.enabled ? '' : styles.dimmed}`}>
        <p className={styles.description}>
          {t('settings.meshwars.description',
            'Plays MeshWars with your MeshCore radio. When repeaters re-flood a channel message you send, MeshMonitor reports your radio\'s position and the repeaters that heard it, the same way the MeshMapper app does. Register at MeshWars to get an API key.')}
        </p>

        <div className="setting-item">
          <label htmlFor="meshwars-source">{t('settings.meshwars.source', 'MeshCore source')}</label>
          <select
            id="meshwars-source"
            className="setting-input"
            value={draft.sourceId}
            disabled={!draft.enabled}
            onChange={(e) => setDraft(d => ({ ...d, sourceId: e.target.value }))}
          >
            <option value="">{t('settings.meshwars.choose_source', 'Choose a source')}</option>
            {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {/* Location note next to the toggle, per CLAUDE.md. */}
          <p className={styles.warning} role="note">
            {t('settings.meshwars.location_warning', {
              cooldown: cooldownMin,
              defaultValue:
                `Sends this radio's position to MeshWars, at most once every ${cooldownMin} minutes. Nothing extra is sent over the mesh.`,
            })}
          </p>
        </div>

        <div className="setting-item">
          <label htmlFor="meshwars-key">{t('settings.meshwars.api_key', 'MeshWars API key')}</label>
          <input
            id="meshwars-key"
            type="password"
            autoComplete="off"
            className={`setting-input ${styles.keyInput}`}
            value={draft.apiKey}
            disabled={!draft.enabled}
            placeholder={status?.apiKeySet
              ? t('settings.meshwars.key_saved', 'Saved. Enter a new key to replace it.')
              : ''}
            onChange={(e) => setDraft(d => ({ ...d, apiKey: e.target.value }))}
          />
        </div>

        <div className="setting-item">
          <label htmlFor="meshwars-url">{t('settings.meshwars.url', 'MeshWars URL')}</label>
          <input
            id="meshwars-url"
            type="url"
            className="setting-input"
            value={draft.url}
            disabled={!draft.enabled}
            spellCheck={false}
            onChange={(e) => setDraft(d => ({ ...d, url: e.target.value }))}
          />
          <p className={styles.help}>
            {t('settings.meshwars.url_help', 'Change only if you play on a self-hosted MeshWars server.')}
          </p>
        </div>

        {status && (
          <div className={styles.statusBlock}>
            <div>
              {t('settings.meshwars.last_sent', 'Last sent')}:{' '}
              {status.lastForwardAt
                ? new Date(status.lastForwardAt).toLocaleString()
                : t('settings.meshwars.never', 'never')}
            </div>
            {last && (
              <div className={last.ok ? undefined : styles.error}>
                {last.ok
                  ? t('settings.meshwars.last_ok', {
                    count: last.repeaters,
                    defaultValue: `Accepted, ${last.repeaters} repeater(s) heard`,
                  })
                  : t('settings.meshwars.last_failed', {
                    error: last.error ?? '',
                    defaultValue: `Not sent: ${last.error ?? ''}`,
                  })}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default MeshWarsSection;
