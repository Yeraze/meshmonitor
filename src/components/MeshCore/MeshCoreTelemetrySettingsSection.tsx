import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';

interface MeshCoreTelemetrySettingsSectionProps {
  /** App base URL (appBasename). */
  baseUrl: string;
  /** Source UUID: scopes the save to /api/settings?sourceId=<id>. */
  sourceId: string;
}

interface TelemetryDraft {
  telemetryVisualizationHours: number;
  favoriteTelemetryStorageDays: number;
}

/**
 * MeshCore telemetry settings (#6258 WP3).
 *
 * Both values save per source (`source:<id>:*`). The readers already prefer the
 * per-source value and fall back to the global default, so a source with no
 * override keeps following the Meshtastic setting. The MeshCore page never
 * mounts SettingsTab, so this section is the only editor for those overrides.
 */
export const MeshCoreTelemetrySettingsSection: React.FC<MeshCoreTelemetrySettingsSectionProps> = ({
  baseUrl,
  sourceId,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = hasPermission('settings', 'write', { sourceId });
  const {
    telemetryVisualizationHours,
    favoriteTelemetryStorageDays,
    setTelemetryVisualizationHours,
    setFavoriteTelemetryStorageDays,
  } = useSettings();

  const buildDraft = useCallback((): TelemetryDraft => ({
    telemetryVisualizationHours,
    favoriteTelemetryStorageDays,
  }), [telemetryVisualizationHours, favoriteTelemetryStorageDays]);

  const [draft, setDraft] = useState<TelemetryDraft>(buildDraft);
  const [initial, setInitial] = useState<TelemetryDraft>(buildDraft);
  const [isSaving, setIsSaving] = useState(false);

  // Re-seed when the context value changes (it loads from the server after mount).
  useEffect(() => {
    const next = buildDraft();
    setDraft(next);
    setInitial(next);
  }, [buildDraft]);

  const hasChanges =
    draft.telemetryVisualizationHours !== initial.telemetryVisualizationHours
    || draft.favoriteTelemetryStorageDays !== initial.favoriteTelemetryStorageDays;

  const update = (key: keyof TelemetryDraft, value: number) => {
    // Backstop: NaN would serialize as "NaN" in the POST body.
    setDraft((prev) => ({ ...prev, [key]: Number.isNaN(value) ? prev[key] : value }));
  };

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telemetryVisualizationHours: String(draft.telemetryVisualizationHours),
          favoriteTelemetryStorageDays: String(draft.favoriteTelemetryStorageDays),
        }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          showToast(t('settings.node_display.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${res.status}`);
      }
      setTelemetryVisualizationHours(draft.telemetryVisualizationHours);
      setFavoriteTelemetryStorageDays(draft.favoriteTelemetryStorageDays);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      setInitial(draft);
      showToast(t('settings.node_display.settings_saved', 'Settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore telemetry settings:', err);
      showToast(t('settings.node_display.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [
    draft, baseUrl, sourceId, csrfFetch, queryClient, showToast, t,
    setTelemetryVisualizationHours, setFavoriteTelemetryStorageDays,
  ]);

  const handleDismiss = useCallback(() => {
    setDraft(initial);
  }, [initial]);

  const numberScope = useNumberInputScope();
  useSaveBar({
    numberScope,
    id: 'meshcore-telemetry',
    sectionName: t('settings.telemetry', 'Telemetry'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  return (
    <NumberInputScope scope={numberScope}>
      <div className="form-section">
        <h3>{t('settings.telemetry', 'Telemetry')}</h3>

        <div className="setting-item">
          <label htmlFor="telemetryVisualizationHours">
            {t('settings.telemetry_hours_label', 'Telemetry Visualization (Hours)')}
            <span className="setting-description">
              {t('settings.telemetry_hours_description', 'How many hours of telemetry data to display in graphs (1-168)')}
            </span>
          </label>
          <NumberInput
            id="telemetryVisualizationHours"
            min={1}
            max={168}
            integer
            value={draft.telemetryVisualizationHours}
            onChange={(n) => update('telemetryVisualizationHours', n)}
            disabled={!canWrite}
            className="setting-input"
          />
        </div>

        <div className="setting-item">
          <label htmlFor="favoriteTelemetryStorageDays">
            {t('settings.fav_telemetry_label', 'Favorite Telemetry Storage Length (Days)')}
            <span className="setting-description">
              {t(
                'settings.fav_telemetry_description',
                'How many days to retain favorited telemetry data (7-90 days). Favorited telemetry is exempt from regular purge.',
              )}
            </span>
          </label>
          <NumberInput
            id="favoriteTelemetryStorageDays"
            min={7}
            max={90}
            integer
            value={draft.favoriteTelemetryStorageDays}
            onChange={(n) => update('favoriteTelemetryStorageDays', n)}
            disabled={!canWrite}
            className="setting-input"
          />
        </div>
      </div>
    </NumberInputScope>
  );
};

export default MeshCoreTelemetrySettingsSection;
