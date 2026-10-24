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
import { meshCoreReceiveOnlyText } from './meshCoreReceiveOnlyText';
import { UiIcon } from '../icons';
import styles from './MeshCoreAutoPingSection.module.css';

/**
 * MeshCore Auto Ping (#5953). Companion sources only: the Automations view
 * renders this section only for a Companion. Same settings and ranges as the
 * Meshtastic Auto Ping; each ping also records direct vs flood.
 */
interface MeshCoreAutoPingSectionProps {
  baseUrl: string;
  sourceId: string;
  receiveOnly?: boolean;
}

interface AutoPingSettings {
  autoPingEnabled: boolean;
  autoPingIntervalSeconds: number;
  autoPingMaxPings: number;
  autoPingTimeoutSeconds: number;
}

interface AutoPingSessionInfo {
  requestedBy: string;
  requestedByName: string;
  totalPings: number;
  completedPings: number;
  successfulPings: number;
  failedPings: number;
  directPings: number;
  floodPings: number;
  startTime: number;
}

const DEFAULTS: AutoPingSettings = {
  autoPingEnabled: false,
  autoPingIntervalSeconds: 30,
  autoPingMaxPings: 20,
  autoPingTimeoutSeconds: 60,
};

const SESSION_POLL_MS = 5000;

export const MeshCoreAutoPingSection: React.FC<MeshCoreAutoPingSectionProps> = ({ baseUrl, sourceId, receiveOnly = false }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [settings, setSettings] = useState<AutoPingSettings>(DEFAULTS);
  const [initial, setInitial] = useState<AutoPingSettings>(DEFAULTS);
  const [sessions, setSessions] = useState<AutoPingSessionInfo[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const loadedRef = useRef(false);
  const url = `${baseUrl}/api/sources/${sourceId}/meshcore/automation/auto-ping`;

  /** Load settings once per source; later calls refresh only the sessions. */
  const fetchData = useCallback(async () => {
    try {
      const res = await csrfFetch(url);
      if (!res.ok) return;
      const json = await res.json();
      const data = json?.data;
      if (!data) return;
      if (!loadedRef.current && data.settings) {
        const s: AutoPingSettings = { ...DEFAULTS, ...data.settings };
        setSettings(s);
        setInitial(s);
        loadedRef.current = true;
      }
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch {
      // ignore fetch errors; the section keeps its defaults
    }
  }, [csrfFetch, url]);

  useEffect(() => {
    loadedRef.current = false;
    void fetchData();
  }, [fetchData]);

  // Poll while a session runs, as the Meshtastic section does.
  useEffect(() => {
    if (sessions.length === 0) return;
    const id = setInterval(() => { void fetchData(); }, SESSION_POLL_MS);
    return () => clearInterval(id);
  }, [sessions.length, fetchData]);

  const hasChanges =
    settings.autoPingEnabled !== initial.autoPingEnabled ||
    settings.autoPingIntervalSeconds !== initial.autoPingIntervalSeconds ||
    settings.autoPingMaxPings !== initial.autoPingMaxPings ||
    settings.autoPingTimeoutSeconds !== initial.autoPingTimeoutSeconds;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const res = await csrfFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
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
      showToast(t('automation.auto_ping.settings_saved', 'Auto-ping settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore auto-ping settings:', err);
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [settings, url, csrfFetch, showToast, t]);

  const handleDismiss = useCallback(() => setSettings(initial), [initial]);

  const numberScope = useNumberInputScope();
  useSaveBar({
    numberScope,
    id: 'meshcore-auto-ping',
    sectionName: t('automation.auto_ping.title', 'Auto Ping'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const update = <K extends keyof AutoPingSettings>(key: K, value: AutoPingSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleStop = async (publicKey: string) => {
    try {
      const res = await csrfFetch(`${url}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey }),
      });
      if (res.ok) {
        showToast(t('automation.auto_ping.session_stopped', 'Ping session stopped'), 'success');
        void fetchData();
      } else {
        showToast(t('automation.auto_ping.stop_failed', 'Failed to stop ping session'), 'error');
      }
    } catch {
      showToast(t('automation.auto_ping.stop_failed', 'Failed to stop ping session'), 'error');
    }
  };

  const formatElapsed = (startTime: number) => {
    const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  };

  const disabled = !settings.autoPingEnabled || !canWrite;

  return (
    <NumberInputScope scope={numberScope}>
      <ConfigSection
        title={t('automation.auto_ping.title', 'Auto Ping')}
        enabled={settings.autoPingEnabled}
        onEnabledChange={(v) => update('autoPingEnabled', v)}
        enableLabel={t('automation.auto_ping.title', 'Auto Ping')}
        docsUrl="https://meshmonitor.org/features/automation#auto-ping"
        canWrite={canWrite}
        receiveOnly={receiveOnly}
        receiveOnlyNote={meshCoreReceiveOnlyText(t)}
        description={t(
          'meshcore.automation.autoping.description',
          'When enabled, a contact can DM "ping N" to this companion to get N pings back, or "ping stop" to cancel. Each ping records its round trip, a timeout, and whether it went direct or by flood. Companion sources only.',
        )}
      >
        <div className="setting-item">
          <label htmlFor="meshcoreAutoPingInterval">
            {t('automation.auto_ping.interval', 'Ping Interval (seconds)')}
            <span className="setting-description">
              {t('automation.auto_ping.interval_description', 'Time between each ping in a session')}
            </span>
          </label>
          <NumberInput
            id="meshcoreAutoPingInterval"
            min={10}
            max={300}
            integer
            value={settings.autoPingIntervalSeconds}
            onChange={(v) => update('autoPingIntervalSeconds', v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item">
          <label htmlFor="meshcoreAutoPingMaxPings">
            {t('automation.auto_ping.max_pings', 'Max Pings Per Session')}
            <span className="setting-description">
              {t('automation.auto_ping.max_pings_description', 'Maximum number of pings a user can request in a single session')}
            </span>
          </label>
          <NumberInput
            id="meshcoreAutoPingMaxPings"
            min={1}
            max={100}
            integer
            value={settings.autoPingMaxPings}
            onChange={(v) => update('autoPingMaxPings', v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item">
          <label htmlFor="meshcoreAutoPingTimeout">
            {t('automation.auto_ping.timeout', 'Ping Timeout (seconds)')}
            <span className="setting-description">
              {t(
                'meshcore.automation.autoping.timeout_description',
                'How long to wait for the ACK before a ping counts as timed out. If the radio suggests a longer wait, that is used instead.',
              )}
            </span>
          </label>
          <NumberInput
            id="meshcoreAutoPingTimeout"
            min={10}
            max={300}
            integer
            value={settings.autoPingTimeoutSeconds}
            onChange={(v) => update('autoPingTimeoutSeconds', v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>

        <div className={styles.warning} role="note">
          <UiIcon name="alert" size={14} />
          <span>
            {t(
              'meshcore.automation.autoping.airtime_warning',
              'Each ping is a DM plus its ACK, so a 20-ping session puts about 40 packets on the air. With no known path to the contact, both are flooded and every repeater in range sends them again.',
            )}
          </span>
        </div>

        <div className={styles.help}>
          <div className={styles.helpTitle}>{t('automation.auto_ping.dm_commands', 'DM Commands')}</div>
          <div className={styles.helpBody}>
            <code>ping 5</code>{' '}{t('automation.auto_ping.dm_start_help', '- Start 5 pings at the configured interval')}
            <br />
            <code>ping stop</code>{' '}{t('automation.auto_ping.dm_stop_help', '- Cancel an active ping session')}
          </div>
        </div>

        {sessions.length > 0 && (
          <div className={styles.sessions}>
            <h3>{t('automation.auto_ping.active_sessions', 'Active Sessions')}</h3>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('automation.auto_ping.requested_by', 'Requested By')}</th>
                  <th>{t('automation.auto_ping.progress', 'Progress')}</th>
                  <th>{t('automation.auto_ping.successful', 'Successful')}</th>
                  <th>{t('automation.auto_ping.failed', 'Failed')}</th>
                  <th>{t('meshcore.automation.autoping.direct_flood', 'Direct / Flood')}</th>
                  <th>{t('automation.auto_ping.elapsed', 'Elapsed')}</th>
                  <th>{t('common.actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.requestedBy}>
                    <td>{s.requestedByName}</td>
                    <td>{s.completedPings}/{s.totalPings}</td>
                    <td className={styles.ok}>{s.successfulPings}</td>
                    <td className={styles.bad}>{s.failedPings}</td>
                    <td>{s.directPings} / {s.floodPings}</td>
                    <td>{formatElapsed(s.startTime)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => { void handleStop(s.requestedBy); }}
                      >
                        {t('common.stop', 'Stop')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ConfigSection>
    </NumberInputScope>
  );
};
