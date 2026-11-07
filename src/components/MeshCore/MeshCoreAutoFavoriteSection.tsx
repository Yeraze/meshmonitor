import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { ConfigSection } from '../shared/config/ConfigSection';

/**
 * MeshCore Auto Favorite (#6224). Parity with the Meshtastic auto-favorite: a
 * per-source sweep favourites every contact heard within the stale window and
 * un-favourites the ones it previously favourited once they go quiet. It only
 * ever un-favourites nodes it owns, so a hand-picked favourite is never touched.
 * Favourite writes go to the companion over its own link, not the LoRa mesh, so
 * there is no airtime cost — but the cadence still defaults slow (6h).
 */
interface Props {
  baseUrl: string;
  sourceId: string;
}

interface AutoFavoriteSettings {
  enabled: boolean;
  intervalHours: number;
  staleHours: number;
  trackedCount: number;
}

const DEFAULTS: AutoFavoriteSettings = {
  enabled: false,
  intervalHours: 6,
  staleHours: 72,
  trackedCount: 0,
};

export const MeshCoreAutoFavoriteSection: React.FC<Props> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [settings, setSettings] = useState<AutoFavoriteSettings>(DEFAULTS);
  const [initial, setInitial] = useState<AutoFavoriteSettings>(DEFAULTS);
  const [running, setRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningNow, setIsRunningNow] = useState(false);
  const loadedRef = useRef(false);
  const url = `${baseUrl}/api/sources/${sourceId}/meshcore/automation/auto-favorite`;

  const fetchData = useCallback(async () => {
    try {
      const res = await csrfFetch(url);
      if (!res.ok) return;
      const json = await res.json();
      const data = json?.data;
      if (!data) return;
      if (data.settings) {
        const s: AutoFavoriteSettings = { ...DEFAULTS, ...data.settings };
        if (!loadedRef.current) {
          setSettings(s);
          setInitial(s);
          loadedRef.current = true;
        } else {
          // Keep the tracked count fresh after a sweep without clobbering edits.
          setInitial((prev) => ({ ...prev, trackedCount: s.trackedCount }));
          setSettings((prev) => ({ ...prev, trackedCount: s.trackedCount }));
        }
      }
      setRunning(data.running === true);
    } catch {
      // ignore; keep defaults
    }
  }, [csrfFetch, url]);

  useEffect(() => {
    loadedRef.current = false;
    void fetchData();
  }, [fetchData]);

  const hasChanges =
    settings.enabled !== initial.enabled ||
    settings.intervalHours !== initial.intervalHours ||
    settings.staleHours !== initial.staleHours;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const res = await csrfFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: settings.enabled,
          intervalHours: settings.intervalHours,
          staleHours: settings.staleHours,
        }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          showToast(t('automation.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        const body = await res.json().catch(() => null);
        showToast(body?.error || t('automation.settings_save_failed', 'Failed to save settings'), 'error');
        return;
      }
      setInitial(settings);
      void fetchData();
      showToast(t('meshcore.automation.auto_favorite.saved', 'Auto Favorite settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore auto-favorite settings:', err);
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [settings, url, csrfFetch, showToast, t, fetchData]);

  const handleDismiss = useCallback(() => setSettings(initial), [initial]);

  const numberScope = useNumberInputScope();
  useSaveBar({
    numberScope,
    id: 'meshcore-auto-favorite',
    sectionName: t('meshcore.automation.auto_favorite.title', 'Auto Favorite'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const update = <K extends keyof AutoFavoriteSettings>(key: K, value: AutoFavoriteSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleRunNow = async () => {
    setIsRunningNow(true);
    try {
      const res = await csrfFetch(`${url}/run`, { method: 'POST' });
      if (!res.ok) {
        showToast(t('meshcore.automation.auto_favorite.run_failed', 'Failed to run sweep'), 'error');
        return;
      }
      const body = await res.json().catch(() => null);
      const favorited = body?.data?.favorited ?? 0;
      const unfavorited = body?.data?.unfavorited ?? 0;
      showToast(
        t('meshcore.automation.auto_favorite.run_done', '+{{favorited}} favourited, -{{unfavorited}} un-favourited', {
          favorited,
          unfavorited,
        }),
        'success',
      );
      void fetchData();
    } catch {
      showToast(t('meshcore.automation.auto_favorite.run_failed', 'Failed to run sweep'), 'error');
    } finally {
      setIsRunningNow(false);
    }
  };

  const disabled = !settings.enabled || !canWrite;

  return (
    <NumberInputScope scope={numberScope}>
      <ConfigSection
        title={t('meshcore.automation.auto_favorite.title', 'Auto Favorite')}
        enabled={settings.enabled}
        onEnabledChange={(v) => update('enabled', v)}
        enableLabel={t('meshcore.automation.auto_favorite.title', 'Auto Favorite')}
        docsUrl="https://meshmonitor.org/features/automation#auto-favorite"
        canWrite={canWrite}
        description={t(
          'meshcore.automation.auto_favorite.description',
          'Periodically favourite every contact heard recently, and un-favourite the ones this automation favourited once they go quiet. Only touches nodes it favourited itself — a contact you favourited by hand is never changed. Writes to the companion over its own link, so there is no mesh airtime.',
        )}
      >
        <div className="setting-item">
          <label htmlFor="mcAutoFavoriteStale">
            {t('meshcore.automation.auto_favorite.stale', 'Active window (hours)')}
            <span className="setting-description">
              {t(
                'meshcore.automation.auto_favorite.stale_description',
                'A contact heard within this window counts as active and is favourited; one that goes quiet longer is un-favourited.',
              )}
            </span>
          </label>
          <NumberInput
            id="mcAutoFavoriteStale"
            min={1}
            max={720}
            integer
            value={settings.staleHours}
            onChange={(v) => update('staleHours', v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item">
          <label htmlFor="mcAutoFavoriteInterval">
            {t('meshcore.automation.auto_favorite.interval', 'Sweep interval (hours)')}
            <span className="setting-description">
              {t('meshcore.automation.auto_favorite.interval_description', 'How often the sweep runs (1–48 hours).')}
            </span>
          </label>
          <NumberInput
            id="mcAutoFavoriteInterval"
            min={1}
            max={48}
            integer
            value={settings.intervalHours}
            onChange={(v) => update('intervalHours', v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item" style={{ alignItems: 'center' }}>
          <span className="setting-description">
            {running
              ? t('meshcore.automation.auto_favorite.scheduler_on', 'Sweep is active for this source.')
              : t('meshcore.automation.auto_favorite.scheduler_off', 'Sweep is not running for this source.')}
            {' '}
            {t('meshcore.automation.auto_favorite.tracked', '{{count}} node(s) auto-favourited.', {
              count: settings.trackedCount,
            })}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => { void handleRunNow(); }}
            disabled={!canWrite || isRunningNow}
          >
            {isRunningNow
              ? t('meshcore.automation.auto_favorite.running', 'Running…')
              : t('meshcore.automation.auto_favorite.run_now', 'Run now')}
          </button>
        </div>
      </ConfigSection>
    </NumberInputScope>
  );
};
