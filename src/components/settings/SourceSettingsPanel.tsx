/**
 * Source Settings Panel
 *
 * Renders a per-source settings override section within the Settings tab.
 * Only visible when 2+ sources are configured. Loads/saves settings using
 * the `GET|POST /api/settings?sourceId=<id>` endpoints.
 *
 * Covers the per-source settings most likely to differ between sources:
 *   - maxNodeAgeHours
 *   - tracerouteIntervalMinutes
 *   - autoAckEnabled / autoAckMessage / autoAckRegex
 *   - autoAnnounceEnabled
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';

interface Source {
  id: string;
  name: string;
  type: string;
}

interface SourceOverrides {
  maxNodeAgeHours?: string;
  tracerouteIntervalMinutes?: string;
  autoAckEnabled?: string;
  autoAckMessage?: string;
  autoAckRegex?: string;
  autoAnnounceEnabled?: string;
}

interface Props {
  baseUrl: string;
  globalMaxNodeAgeHours: number;
  globalTracerouteIntervalMinutes: number;
}

export const SourceSettingsPanel: React.FC<Props> = ({
  baseUrl,
  globalMaxNodeAgeHours,
  globalTracerouteIntervalMinutes,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const csrfFetch = useCsrfFetch();

  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [overrides, setOverrides] = useState<SourceOverrides>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Fetch sources list
  useEffect(() => {
    fetch(`${baseUrl}/api/sources`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((data: Source[]) => {
        setSources(Array.isArray(data) ? data : []);
      })
      .catch(err => logger.debug('SourceSettingsPanel: failed to fetch sources', err));
  }, [baseUrl]);

  const loadOverrides = useCallback(async (sourceId: string) => {
    if (!sourceId) return;
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings?sourceId=${sourceId}`, { credentials: 'include' });
      if (!res.ok) return;
      const data: Record<string, string> = await res.json();

      // Extract only per-source-relevant keys
      setOverrides({
        maxNodeAgeHours: data.maxNodeAgeHours,
        tracerouteIntervalMinutes: data.tracerouteIntervalMinutes,
        autoAckEnabled: data.autoAckEnabled,
        autoAckMessage: data.autoAckMessage,
        autoAckRegex: data.autoAckRegex,
        autoAnnounceEnabled: data.autoAnnounceEnabled,
      });
    } catch (err) {
      logger.error('SourceSettingsPanel: failed to load overrides', err);
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    if (selectedSourceId) loadOverrides(selectedSourceId);
    else setOverrides({});
  }, [selectedSourceId, loadOverrides]);

  const handleSave = async () => {
    if (!selectedSourceId) return;
    setSaving(true);
    try {
      // Only send keys that have been explicitly set (not undefined)
      const payload: Record<string, string> = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined && v !== '') payload[k] = v;
      }

      await csrfFetch(`${baseUrl}/api/settings?sourceId=${selectedSourceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast(t('settings.source_overrides_saved', 'Source overrides saved'), 'success');
    } catch (err) {
      logger.error('SourceSettingsPanel: failed to save overrides', err);
      showToast(t('settings.source_overrides_save_failed', 'Failed to save source overrides'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (sources.length < 2) return null;

  return (
    <div id="settings-source-overrides" className="settings-section">
      <h3>{t('settings.source_overrides', 'Per-Source Setting Overrides')}</h3>
      <p className="setting-description">
        {t('settings.source_overrides_description', 'Override specific settings for a particular source. Overrides take precedence over global settings for that source.')}
      </p>

      <div className="setting-item">
        <label htmlFor="source-override-select">
          {t('settings.select_source', 'Source')}
        </label>
        <select
          id="source-override-select"
          className="setting-input"
          value={selectedSourceId}
          onChange={e => setSelectedSourceId(e.target.value)}
        >
          <option value="">{t('settings.select_source_placeholder', '— Select a source —')}</option>
          {sources.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {selectedSourceId && (
        loading ? (
          <p className="setting-description">{t('common.loading', 'Loading...')}</p>
        ) : (
          <>
            <div className="setting-item">
              <label htmlFor="src-max-node-age">
                {t('settings.max_node_age_label')}
                <span className="setting-description">
                  {t('settings.source_override_global_fallback', 'Global: {{value}}', { value: globalMaxNodeAgeHours })}
                </span>
              </label>
              <input
                id="src-max-node-age"
                type="number"
                className="setting-input"
                min={1}
                max={8760}
                placeholder={String(globalMaxNodeAgeHours)}
                value={overrides.maxNodeAgeHours ?? ''}
                onChange={e => setOverrides(prev => ({ ...prev, maxNodeAgeHours: e.target.value }))}
              />
            </div>

            <div className="setting-item">
              <label htmlFor="src-traceroute-interval">
                {t('settings.traceroute_interval_label', 'Auto-Traceroute Interval (minutes)')}
                <span className="setting-description">
                  {t('settings.source_override_global_fallback', 'Global: {{value}}', { value: globalTracerouteIntervalMinutes })}
                </span>
              </label>
              <input
                id="src-traceroute-interval"
                type="number"
                className="setting-input"
                min={1}
                max={1440}
                placeholder={String(globalTracerouteIntervalMinutes)}
                value={overrides.tracerouteIntervalMinutes ?? ''}
                onChange={e => setOverrides(prev => ({ ...prev, tracerouteIntervalMinutes: e.target.value }))}
              />
            </div>

            <div className="setting-item">
              <label>
                {t('settings.auto_ack_enabled', 'Auto-Ack Enabled')}
              </label>
              <select
                className="setting-input"
                value={overrides.autoAckEnabled ?? ''}
                onChange={e => setOverrides(prev => ({ ...prev, autoAckEnabled: e.target.value }))}
              >
                <option value="">{t('settings.source_override_use_global', 'Use global')}</option>
                <option value="true">{t('common.enabled', 'Enabled')}</option>
                <option value="false">{t('common.disabled', 'Disabled')}</option>
              </select>
            </div>

            <div className="setting-item">
              <label>
                {t('settings.auto_announce_enabled', 'Auto-Announce Enabled')}
              </label>
              <select
                className="setting-input"
                value={overrides.autoAnnounceEnabled ?? ''}
                onChange={e => setOverrides(prev => ({ ...prev, autoAnnounceEnabled: e.target.value }))}
              >
                <option value="">{t('settings.source_override_use_global', 'Use global')}</option>
                <option value="true">{t('common.enabled', 'Enabled')}</option>
                <option value="false">{t('common.disabled', 'Disabled')}</option>
              </select>
            </div>

            <button
              className="button button-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving
                ? t('common.saving', 'Saving...')
                : t('settings.save_source_overrides', 'Save Source Overrides')}
            </button>
          </>
        )
      )}
    </div>
  );
};

export default SourceSettingsPanel;
