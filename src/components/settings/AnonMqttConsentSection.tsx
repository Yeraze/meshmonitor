import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { ANON_HIDE_MQTT_NO_CONSENT_SETTING, isAnonHideFlagOn } from '../../utils/mqttConsentFilter';
import styles from './AnonMqttConsentSection.module.css';

interface AnonMqttConsentSectionProps {
  /** App base URL (appBasename), as every other self-saving section takes it. */
  baseUrl: string;
  /** Source UUID: scopes GET/POST to /api/settings?sourceId=<id>. */
  sourceId: string;
  /** Whether the current user may change this setting. */
  canWrite: boolean;
}

/**
 * Per-source toggle for the anonymous-viewer MQTT-consent filter (#5156).
 * Off by default. When on, signed-out viewers do not see nodes that reached
 * this source over MQTT with "OK to MQTT" turned off and were never heard
 * here over direct RF. Signed-in users are not affected.
 *
 * Self-saving, like `CoverageMqttRecordingSection`: reads and writes
 * `/api/settings?sourceId=<id>` directly and saves on change.
 */
export const AnonMqttConsentSection: React.FC<AnonMqttConsentSectionProps> = ({ baseUrl, sourceId, canWrite }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  // null = not loaded yet.
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
        if (!cancelled) setEnabled(isAnonHideFlagOn(data[ANON_HIDE_MQTT_NO_CONSENT_SETTING]));
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId]);

  const handleToggle = useCallback(async (next: boolean) => {
    setSaving(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [ANON_HIDE_MQTT_NO_CONSENT_SETTING]: next ? '1' : '0' }),
      });
      if (!res.ok) {
        showToast(t('settings.anon_mqtt_consent.save_failed', 'Failed to change the anonymous MQTT-consent filter'), 'error');
        return;
      }
      setEnabled(next);
      showToast(
        next
          ? t('settings.anon_mqtt_consent.saved_on', 'Hiding nodes without MQTT consent from signed-out viewers')
          : t('settings.anon_mqtt_consent.saved_off', 'Signed-out viewers see all nodes again'),
        'success',
      );
    } catch {
      showToast(t('settings.anon_mqtt_consent.save_failed', 'Failed to change the anonymous MQTT-consent filter'), 'error');
    } finally {
      setSaving(false);
    }
  }, [baseUrl, sourceId, csrfFetch, showToast, t]);

  return (
    <div id="settings-anon-mqtt-consent" className="settings-section">
      <h3>{t('settings.anon_mqtt_consent.title', 'Anonymous viewers')}</h3>
      <div className={`setting-item ${styles.toggleRow}`}>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={enabled ?? false}
            disabled={!canWrite || saving || enabled === null}
            onChange={(e) => void handleToggle(e.target.checked)}
          />
          <span>{t('settings.anon_mqtt_consent.label', 'Hide nodes without MQTT consent from signed-out viewers')}</span>
        </label>
        <p className="setting-description">
          {t(
            'settings.anon_mqtt_consent.description',
            'Signed-out viewers will not see a node, or any of its data, that reached this source over MQTT with "OK to MQTT" turned off and was never heard here over RF. Signed-in users are not affected.',
          )}
        </p>
      </div>
    </div>
  );
};

export default AnonMqttConsentSection;
