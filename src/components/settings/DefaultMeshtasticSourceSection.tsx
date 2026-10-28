/**
 * DefaultMeshtasticSourceSection — pick the Meshtastic TCP source used when a
 * request names no source (#5245). Global Settings page, admins only.
 *
 * The key (`defaultMeshtasticSourceId`) is global and admin-only on the
 * server (ADMIN_ONLY_SETTINGS_KEYS), and hidden from non-admins on read
 * (SECRET_SETTINGS_KEYS). Blank = Automatic: the first Meshtastic TCP source
 * started at boot. Saving applies at once; no restart.
 *
 * Under the select, the section shows what a source-less request resolves to
 * right now (`GET /api/settings/default-meshtastic-source`), so "Automatic"
 * names the source it picked, and a chosen source that is not running says so.
 *
 * Self-contained like ReticulumRetentionSection: its own load, its own save
 * bar, the unscoped `POST /api/settings`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useDashboardSources } from '../../hooks/useDashboardData';
import { logger } from '../../utils/logger';
import { UiIcon } from '../icons';
import styles from './DefaultMeshtasticSourceSection.module.css';

/** The section's id: the Global Settings nav chip and deep links. */
export const DEFAULT_SOURCE_SECTION_ID = 'settings-default-source';

const SETTING_KEY = 'defaultMeshtasticSourceId';

interface DefaultSourceStatus {
  configuredSourceId: string | null;
  effectiveSourceId: string | null;
  effectiveSourceName: string | null;
  mode: 'automatic' | 'configured' | 'fallback';
}

export const DefaultMeshtasticSourceSection: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { data: sources = [] } = useDashboardSources();
  const tcpSources = sources.filter((s) => s.type === 'meshtastic_tcp');

  const [value, setValue] = useState('');
  const [initial, setInitial] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState<DefaultSourceStatus | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiService.get<{ success: boolean; data: DefaultSourceStatus }>(
        '/api/settings/default-meshtastic-source',
      );
      setStatus(res?.data ?? null);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        logger.error('Failed to load the default Meshtastic source status:', error);
      }
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await apiService.get<Record<string, string>>('/api/settings');
        if (cancelled) return;
        const stored = typeof settings?.[SETTING_KEY] === 'string' ? settings[SETTING_KEY].trim() : '';
        setValue(stored);
        setInitial(stored);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          logger.error('Failed to load defaultMeshtasticSourceId:', error);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    void loadStatus();
    return () => { cancelled = true; };
  }, [loadStatus]);

  const hasChanges = loaded && value !== initial;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await apiService.post('/api/settings', { [SETTING_KEY]: value });
      setInitial(value);
      showToast(t('settings.default_source.saved', 'Default Meshtastic source saved'), 'success');
      await loadStatus();
    } catch (error) {
      logger.error('Failed to save defaultMeshtasticSourceId:', error);
      showToast(t('settings.default_source.save_failed', 'Failed to save the default Meshtastic source'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [value, showToast, t, loadStatus]);

  const handleDismiss = useCallback(() => {
    setValue(initial);
  }, [initial]);

  useSaveBar({
    id: 'default-meshtastic-source',
    sectionName: t('settings.default_source.title', 'Default Meshtastic source'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  // A stored id whose source is gone still gets an option, so the select
  // never shows a choice the server is not holding.
  const valueIsListed = !value || tcpSources.some((s) => s.id === value);

  let statusText: string;
  if (!status) {
    statusText = '';
  } else if (!status.effectiveSourceId) {
    statusText = t('settings.default_source.status_none', 'No Meshtastic source is running.');
  } else {
    const name = status.effectiveSourceName ?? status.effectiveSourceId;
    if (status.mode === 'configured') {
      statusText = t('settings.default_source.status_configured', 'In use now: {{name}}.', { name });
    } else if (status.mode === 'fallback') {
      statusText = t(
        'settings.default_source.status_fallback',
        'The chosen source is not running, so {{name}} is used until it is.',
        { name },
      );
    } else {
      statusText = t('settings.default_source.status_automatic', 'Automatic is using: {{name}}.', { name });
    }
  }

  return (
    <div id={DEFAULT_SOURCE_SECTION_ID} className="settings-section" data-testid="default-source-section">
      <h3 className={styles.heading}>
        <UiIcon name="radio" size={16} />
        <span>{t('settings.default_source.title', 'Default Meshtastic source')}</span>
      </h3>

      <div className={styles.field}>
        <label htmlFor="defaultMeshtasticSourceId">
          {t('settings.default_source.label', 'Source used when none is chosen')}
        </label>
        <p className={styles.description}>
          {t(
            'settings.default_source.description',
            'Used only where a request names no source: API calls without a sourceId (such as sending a message), the v1 API "default" source, and device pages opened without a source. Anything that names a source keeps using that source. If the chosen source is disabled or not connected, Automatic applies until it is back.',
          )}
        </p>
        <select
          id="defaultMeshtasticSourceId"
          className={styles.select}
          value={value}
          disabled={!loaded}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">{t('settings.default_source.automatic', 'Automatic (first started)')}</option>
          {tcpSources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.enabled
                ? s.name
                : t('settings.default_source.disabled_option', '{{name}} (disabled)', { name: s.name })}
            </option>
          ))}
          {!valueIsListed && (
            <option value={value}>
              {t('settings.default_source.missing_option', 'Unknown source ({{id}})', { id: value })}
            </option>
          )}
        </select>
        {statusText && (
          <p className={styles.status} data-testid="default-source-status">
            {statusText}
          </p>
        )}
      </div>
    </div>
  );
};

export default DefaultMeshtasticSourceSection;
