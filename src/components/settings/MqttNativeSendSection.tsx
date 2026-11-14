import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import apiService from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { UiIcon } from '../icons';
import NumberInput from '../common/NumberInput';
import { mqttNativeStatusQueryKey, type MqttNativeStatus } from '../../hooks/useMqttNativeSendStatus';
import styles from './MqttNativeSendSection.module.css';

interface MqttNativeSendSectionProps {
  /** App base URL (appBasename), as every other self-saving section takes it. */
  baseUrl: string;
  /** Source UUID of the MQTT broker/bridge source. */
  sourceId: string;
  /** Whether the current user may change it (`sources:write`). */
  canWrite: boolean;
}

/**
 * The query client when one is mounted. Settings surfaces render in tests
 * (and could render) without a QueryClientProvider; the section still works
 * there, it just cannot nudge App's composer status to refresh.
 */
function useOptionalQueryClient(): QueryClient | null {
  try {
    return useQueryClient();
  } catch {
    return null;
  }
}

interface Draft {
  hopLimit: number;
  maxPerMinute: number;
  maxPerHour: number;
  longName: string;
  shortName: string;
  rootTopic: string;
}

function draftFrom(status: MqttNativeStatus): Draft {
  return {
    hopLimit: status.config.hopLimit,
    maxPerMinute: status.config.maxPerMinute,
    maxPerHour: status.config.maxPerHour,
    longName: status.config.longName,
    shortName: status.config.shortName,
    rootTopic: status.config.rootTopic ?? '',
  };
}

/**
 * MQTT-native ("nodeless") send for one MQTT source (#4305): the per-source
 * opt-in (off by default) with its RF warning beside the toggle, the
 * source's generated node id, and the limits. Self-saving against
 * `/api/sources/:id/mqtt/native`; the server clamps everything again.
 */
export const MqttNativeSendSection: React.FC<MqttNativeSendSectionProps> = ({ baseUrl, sourceId, canWrite }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const queryClient = useOptionalQueryClient();
  const [status, setStatus] = useState<MqttNativeStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    void (async () => {
      try {
        const res = await apiService.get<{ success: boolean; data: MqttNativeStatus }>(
          `/api/sources/${encodeURIComponent(sourceId)}/mqtt/native`,
        );
        if (!cancelled && res?.data) {
          setStatus(res.data);
          setDraft(draftFrom(res.data));
        }
      } catch {
        if (!cancelled) setStatus(null);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId]);

  const save = useCallback(async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/mqtt/native`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        showToast(json?.error ?? t('settings.mqtt_native.save_failed', 'Failed to save MQTT-native send'), 'error');
        return;
      }
      setStatus(json.data as MqttNativeStatus);
      setDraft(draftFrom(json.data as MqttNativeStatus));
      // Lets App show or hide the composer for this source right away.
      void queryClient?.invalidateQueries({ queryKey: mqttNativeStatusQueryKey(sourceId) });
      showToast(t('settings.mqtt_native.saved', 'MQTT-native send saved'), 'success');
    } catch {
      showToast(t('settings.mqtt_native.save_failed', 'Failed to save MQTT-native send'), 'error');
    } finally {
      setSaving(false);
    }
  }, [baseUrl, sourceId, csrfFetch, showToast, t, queryClient]);

  if (!status || !draft) {
    return null;
  }

  const update = (key: 'longName' | 'shortName' | 'rootTopic') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => (d ? { ...d, [key]: e.target.value } : d));
  const updateNumber = (key: 'hopLimit' | 'maxPerMinute' | 'maxPerHour') => (value: number) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const saveLimits = () =>
    void save({
      hopLimit: draft.hopLimit,
      maxPerMinute: draft.maxPerMinute,
      maxPerHour: draft.maxPerHour,
      longName: draft.longName,
      shortName: draft.shortName,
      rootTopic: draft.rootTopic.trim() === '' ? null : draft.rootTopic.trim(),
    });

  const disabled = !canWrite || saving;
  const readOnly = !status.readiness.ok && status.readiness.code === 'READ_ONLY';

  return (
    <div id="settings-mqtt-native-send" className="settings-section">
      <h3>{t('settings.mqtt_native.title', 'Send over MQTT (no radio)')}</h3>
      <div className={`setting-item ${styles.toggleRow}`}>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={disabled || (readOnly && !status.enabled)}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          <span>{t('settings.mqtt_native.toggle', 'Let this source send messages over MQTT')}</span>
        </label>
        <p className={styles.warning}>
          <UiIcon name="alert" size={14} className={styles.warningIcon} />
          <span>
            {t(
              'settings.mqtt_native.warning',
              'Messages you send here go onto the radio mesh. Every gateway that downlinks the channel transmits each message on RF, and the mesh then repeats it up to the hop limit. One send can become many transmissions on a busy mesh.',
            )}
          </span>
        </p>
        {readOnly && (
          <p className="setting-description">
            {t('settings.mqtt_native.read_only', 'This source is subscribe-only, so it never publishes.')}
          </p>
        )}
        {status.identityBlocker && !status.identity && (
          <p className="setting-description">{status.identityBlocker}</p>
        )}
      </div>

      {status.identity && (
        <div className="setting-item">
          <span className={styles.fieldLabel}>{t('settings.mqtt_native.node_id', 'Node ID this source sends as')}</span>
          <code className={styles.nodeId}>{status.identity.nodeId}</code>
          <p className="setting-description">
            {t('settings.mqtt_native.names_now', 'Announced as "{{longName}}" ({{shortName}}).', {
              longName: status.identity.longName,
              shortName: status.identity.shortName,
            })}
          </p>
        </div>
      )}

      <div className={`setting-item ${styles.grid}`}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('settings.mqtt_native.root_topic', 'MQTT root topic')}</span>
          <input
            type="text"
            value={draft.rootTopic}
            placeholder={status.rootTopicHint ?? 'msh/US'}
            disabled={disabled}
            onChange={update('rootTopic')}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('settings.mqtt_native.long_name', 'Long name')}</span>
          <input type="text" value={draft.longName} disabled={disabled} onChange={update('longName')} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('settings.mqtt_native.short_name', 'Short name')}</span>
          <input type="text" value={draft.shortName} disabled={disabled} onChange={update('shortName')} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('settings.mqtt_native.hop_limit', 'Hop limit (0-7)')}</span>
          <NumberInput integer min={0} max={status.limits.maxHopLimit} value={draft.hopLimit} disabled={disabled} onChange={updateNumber('hopLimit')} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>
            {t('settings.mqtt_native.max_per_minute', 'Messages per minute (max {{max}})', { max: status.limits.hardMaxPerMinute })}
          </span>
          <NumberInput integer min={1} max={status.limits.hardMaxPerMinute} value={draft.maxPerMinute} disabled={disabled} onChange={updateNumber('maxPerMinute')} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>
            {t('settings.mqtt_native.max_per_hour', 'Messages per hour (max {{max}})', { max: status.limits.hardMaxPerHour })}
          </span>
          <NumberInput integer min={1} max={status.limits.hardMaxPerHour} value={draft.maxPerHour} disabled={disabled} onChange={updateNumber('maxPerHour')} />
        </label>
      </div>
      <p className="setting-description">
        {t(
          'settings.mqtt_native.limits_note',
          'Each source may send at most 6 messages a minute and 60 an hour; you can set lower limits. It also announces its node info once when turned on, then every 3 hours. Automations cannot send this way.',
        )}
      </p>
      {canWrite && (
        <button type="button" className="save-button" disabled={saving} onClick={saveLimits}>
          {t('settings.mqtt_native.save', 'Save')}
        </button>
      )}
    </div>
  );
};

export default MqttNativeSendSection;
