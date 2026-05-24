/**
 * MqttBrokerSettingsTab — editable settings for an `mqtt_broker` source.
 *
 * Fetches the current config from /api/sources/:id, renders editable
 * fields (name, listener port, credentials, root topic, zero-hop
 * injection), and PUTs the merged result back. Matches the field shape
 * used by the legacy Edit modal in DashboardPage so existing API
 * validators don't need to change.
 *
 * Password field: empty on initial load (non-admin GET strips the
 * password; admin GET returns it but we deliberately don't pre-fill on
 * edit — leaving the field empty signals "keep existing"). Submit drops
 * an empty password field so server-side credential preservation kicks
 * in.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { appBasename } from '../../init';
import { useCsrf } from '../../contexts/CsrfContext';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ToastContainer';
import './MqttSettingsTab.css';

export interface MqttBrokerSettingsTabProps {
  sourceId: string;
}

interface BrokerSourceResponse {
  id: string;
  name: string;
  type: string;
  config: {
    listener?: { port?: number; host?: string };
    auth?: { username?: string; password?: string };
    rootTopic?: string;
    zeroHopInjection?: boolean;
  };
}

export function MqttBrokerSettingsTab({ sourceId }: MqttBrokerSettingsTabProps) {
  const { t } = useTranslation();
  const { getToken } = useCsrf();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();

  const canEdit = hasPermission('configuration', 'write');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [listenPort, setListenPort] = useState('1883');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rootTopic, setRootTopic] = useState('msh');
  const [zeroHopInjection, setZeroHopInjection] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const res = await fetch(`${appBasename}/api/sources/${sourceId}`, {
          credentials: 'include',
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as BrokerSourceResponse;
        if (cancelled) return;
        setName(data.name);
        setListenPort(String(data.config?.listener?.port ?? 1883));
        setUsername(data.config?.auth?.username ?? '');
        setPassword('');
        setRootTopic(data.config?.rootTopic ?? 'msh');
        setZeroHopInjection(Boolean(data.config?.zeroHopInjection));
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  const onSave = async () => {
    if (!name.trim()) {
      setSaveError(t('source.form.error_name_required', 'Name is required'));
      return;
    }
    const port = parseInt(listenPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      setSaveError(t('source.form.error_port_range', 'Port must be 1–65535'));
      return;
    }
    if (!username.trim()) {
      setSaveError(t('source.form.error_mqtt_username_required', 'Broker username is required'));
      return;
    }

    const cfg: Record<string, unknown> = {
      listener: { port, host: '0.0.0.0' },
      auth: password
        ? { username: username.trim(), password }
        : { username: username.trim() }, // server preserves existing password
      rootTopic: rootTopic.trim() || 'msh',
      zeroHopInjection,
    };

    setSaving(true);
    setSaveError(null);
    try {
      const csrfToken = getToken();
      const res = await fetch(`${appBasename}/api/sources/${sourceId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken || '',
        },
        body: JSON.stringify({
          name: name.trim(),
          type: 'mqtt_broker',
          config: cfg,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSaveError((err as { error?: string }).error ?? t('source.form.error_save_failed', 'Failed to save'));
        return;
      }
      // Empty the password field after a successful save so the next save
      // doesn't accidentally re-send a stale value the user thought was applied.
      setPassword('');
      showToast(t('source.form.saved', 'Settings saved'), 'success');
    } catch {
      setSaveError(t('source.form.error_network', 'Network error'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mqtt-settings-tab">
        <p>{t('source.mqtt.settings.loading', 'Loading settings…')}</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mqtt-settings-tab">
        <p className="mqtt-settings-error">
          {t('source.mqtt.settings.load_error', 'Could not load source: {{err}}', { err: loadError })}
        </p>
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div className="mqtt-settings-tab">
      <h2>{t('source.mqtt_broker.settings_title', 'Broker Settings')}</h2>
      {!canEdit && (
        <p className="mqtt-settings-readonly">
          {t('source.mqtt.settings.readonly', 'Read-only — you do not have permission to edit this source.')}
        </p>
      )}

      <div className="mqtt-settings-field">
        <label htmlFor="broker-name">{t('source.form.name', 'Name')}</label>
        <input
          id="broker-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
        />
      </div>

      <div className="mqtt-settings-field">
        <label htmlFor="broker-port">{t('source.form.listener_port', 'Listener port')}</label>
        <input
          id="broker-port"
          type="number"
          min={1}
          max={65535}
          value={listenPort}
          onChange={(e) => setListenPort(e.target.value)}
          disabled={disabled}
        />
        <p className="mqtt-settings-hint">
          {t('source.form.listener_port_hint', 'Default 1883. Devices and other MQTT clients connect on this port.')}
        </p>
      </div>

      <div className="mqtt-settings-field">
        <label htmlFor="broker-username">{t('source.form.username', 'Username')}</label>
        <input
          id="broker-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={disabled}
          autoComplete="username"
        />
      </div>

      <div className="mqtt-settings-field">
        <label htmlFor="broker-password">{t('source.form.password', 'Password')}</label>
        <input
          id="broker-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={disabled}
          placeholder={t('source.form.password_unchanged', '(unchanged)')}
          autoComplete="new-password"
        />
        <p className="mqtt-settings-hint">
          {t(
            'source.form.password_hint',
            'Leave blank to keep the current password.',
          )}
        </p>
      </div>

      <div className="mqtt-settings-field">
        <label htmlFor="broker-root-topic">{t('source.form.root_topic', 'Root topic')}</label>
        <input
          id="broker-root-topic"
          type="text"
          value={rootTopic}
          onChange={(e) => setRootTopic(e.target.value)}
          disabled={disabled}
        />
        <p className="mqtt-settings-hint">
          {t(
            'source.form.root_topic_hint',
            'Default "msh". Only packets under this prefix are ingested as Meshtastic ServiceEnvelopes.',
          )}
        </p>
      </div>

      <div className="mqtt-settings-field mqtt-settings-checkbox">
        <label htmlFor="broker-zero-hop">
          <input
            id="broker-zero-hop"
            type="checkbox"
            checked={zeroHopInjection}
            onChange={(e) => setZeroHopInjection(e.target.checked)}
            disabled={disabled}
          />
          <span>{t('source.form.zero_hop', 'Zero-hop injection')}</span>
        </label>
        <p className="mqtt-settings-hint">
          {t(
            'source.form.zero_hop_hint',
            'Clamp hop_limit to 0 on every packet delivered to MQTT clients. Mirrors mqtt.meshtastic.org behavior — prevents MQTT-bridged packets from triggering extra RF re-broadcasts.',
          )}
        </p>
      </div>

      {saveError && <p className="mqtt-settings-error">{saveError}</p>}

      {canEdit && (
        <div className="mqtt-settings-actions">
          <button type="button" onClick={onSave} disabled={saving}>
            {saving ? t('source.form.saving', 'Saving…') : t('source.form.save', 'Save')}
          </button>
        </div>
      )}
    </div>
  );
}
