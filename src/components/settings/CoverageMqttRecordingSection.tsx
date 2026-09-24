import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import apiService from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { UiIcon } from '../icons';
import { COVERAGE_MQTT_ENABLED_SETTING, isCoverageMqttFlagOn } from '../../utils/coverage';
import styles from './CoverageMqttRecordingSection.module.css';

interface CoverageMqttRecordingSectionProps {
  /** App base URL (appBasename), as every other self-saving section takes it. */
  baseUrl: string;
  /** Source UUID — scopes GET/POST to /api/settings?sourceId=<id>. */
  sourceId: string;
  /** Whether the current user may change this setting. */
  canWrite: boolean;
}

/**
 * Coverage Report → per-source MQTT gateway-reception recording toggle
 * (#5277 P2 WP3, spec §2.8).
 *
 * A self-saving section — the MeshCore receive-only pattern
 * (`MeshCoreSettingsView`/`MeshCoreNodeDisplaySection`) — rather than a
 * `SettingsDraft` field: `SettingsTab`'s save routes every non-Node-Display
 * key to the GLOBAL endpoint even in source mode (spec D6), and joining that
 * partition is out of scope here. This reads and writes
 * `/api/settings?sourceId=<id>` directly and saves on change.
 *
 * Shown only on `mqtt_broker`/`mqtt_bridge` sources — see the
 * `isMqttOnlySourceType` gate in `configSections.ts` and the render guard in
 * `SettingsTab.tsx`.
 */
export const CoverageMqttRecordingSection: React.FC<CoverageMqttRecordingSectionProps> = ({
  baseUrl,
  sourceId,
  canWrite,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // null = not yet loaded. Fail closed on a read error: recording nothing is
  // the safe side, matching the server-side cache (coverageMqttSettings.ts).
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEnabled(null);
    void (async () => {
      try {
        const data = await apiService.get<Record<string, string>>(
          `/api/settings?sourceId=${encodeURIComponent(sourceId)}`,
        );
        if (!cancelled) setEnabled(isCoverageMqttFlagOn(data[COVERAGE_MQTT_ENABLED_SETTING]));
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId]);

  // Enabling is the direction that grows the database (spec U1), so it is
  // the one gated behind window.confirm, quoting the same measured numbers
  // as the warning below. Disabling is always safe and needs no confirm.
  const handleToggle = useCallback(async (next: boolean) => {
    if (next && !window.confirm(t(
      'settings.coverage_mqtt_enable_confirm',
      'Record MQTT gateway receptions for the Coverage Report?\n\n' +
      'Each gateway that hears a position packet adds one row. A regional feed adds about ' +
      '12,000–14,000 rows a day: about 90,000–100,000 rows (35–50 MB) over a 7-day retention. ' +
      'A world-wide msh/# feed can reach about 1 million rows a day and several GB a week. ' +
      'Rows are kept for the Coverage retention period, a global setting under Settings → Coverage Report.\n\n' +
      'Continue?',
    ))) {
      return;
    }
    setSaving(true);
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [COVERAGE_MQTT_ENABLED_SETTING]: next ? '1' : '0' }),
        },
      );
      if (!res.ok) {
        showToast(t('settings.coverage_mqtt_save_failed', 'Failed to change MQTT gateway recording'), 'error');
        return;
      }
      setEnabled(next);
      // Lets an open Coverage Report refresh its receivers/mqttSources
      // status without waiting for the next mount or manual Refresh click.
      await queryClient.invalidateQueries({ queryKey: ['analysis', 'coverageReport', 'receivers'] });
      showToast(
        t(
          next ? 'settings.coverage_mqtt_saved_on' : 'settings.coverage_mqtt_saved_off',
          next
            ? 'MQTT gateway recording enabled for the Coverage Report'
            : 'MQTT gateway recording disabled',
        ),
        'success',
      );
    } catch {
      showToast(t('settings.coverage_mqtt_save_failed', 'Failed to change MQTT gateway recording'), 'error');
    } finally {
      setSaving(false);
    }
  }, [baseUrl, sourceId, csrfFetch, queryClient, showToast, t]);

  return (
    <div id="settings-coverage-mqtt" className="settings-section">
      <h3>{t('settings.coverage_mqtt_section', 'Coverage recording')}</h3>

      <div className={`setting-item ${styles.toggleRow}`}>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={enabled ?? false}
            disabled={!canWrite || saving || enabled === null}
            onChange={(e) => void handleToggle(e.target.checked)}
          />
          <span>{t('settings.coverage_mqtt_toggle_label', 'Record MQTT gateway receptions for the Coverage Report')}</span>
        </label>

        <p className={styles.warning}>
          <UiIcon name="alert" size={14} className={styles.warningIcon} />
          <span>
            <Trans
              i18nKey="settings.coverage_mqtt_warning"
              components={{ link: <Link to="/settings#settings-coverage" className={styles.link} /> }}
            />
          </span>
        </p>

        <p className="setting-description">
          {t(
            'settings.coverage_mqtt_note',
            'Nodes that turn off "OK to MQTT" are not uplinked by gateways on public brokers, so they won\'t appear. Rows only start from when you turn this on.',
          )}
        </p>
      </div>
    </div>
  );
};

export default CoverageMqttRecordingSection;
