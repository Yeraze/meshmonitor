import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSource } from '../../contexts/SourceContext';
import { useDashboardSources } from '../../hooks/useDashboardData';
import { appBasename } from '../../init';

interface MqttQuickConnectProps {
  /**
   * Apply firmware-side MQTT module setters with values from the selected MQTT source.
   * Wired by the parent so the same setters used by the manual form get updated.
   */
  applyToFirmwareModule: (values: {
    mqttEnabled: boolean;
    mqttAddress: string;
    mqttUsername: string;
    mqttPassword: string;
    mqttRoot: string;
    mqttEncryptionEnabled: boolean;
    mqttJsonEnabled: boolean;
    tlsEnabled: boolean;
    proxyToClientEnabled: boolean;
  }) => void;
}

/**
 * Quick Connect — pick an existing MQTT source and populate this device's
 * firmware MQTT module config (server, port, credentials, root topic,
 * Client Proxy checkbox) from it. Also records the link on the Meshtastic
 * source so MeshMonitor's backend bridges firmware proxy traffic through
 * the selected MQTT source's broker connection.
 *
 * Replaces the external mqtt-proxy sidecar container.
 */
const MqttQuickConnect: React.FC<MqttQuickConnectProps> = ({ applyToFirmwareModule }) => {
  const { t } = useTranslation();
  const { sourceId } = useSource();
  const { data: sources, isLoading } = useDashboardSources();

  const mqttSources = useMemo(
    () => (sources ?? []).filter((s) => s.type === 'mqtt' && s.enabled),
    [sources],
  );

  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [topicOverride, setTopicOverride] = useState<string>('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedAt, setAppliedAt] = useState<number | null>(null);

  if (!sourceId) return null;
  if (!isLoading && mqttSources.length === 0) return null;

  const selectedSource = mqttSources.find((s) => s.id === selectedSourceId);

  const onApply = async () => {
    if (!selectedSource) return;
    setApplying(true);
    setError(null);
    try {
      const cfg = (selectedSource.config ?? {}) as {
        broker?: { url?: string; username?: string; password?: string };
        rootTopic?: string;
      };
      const brokerUrl = cfg.broker?.url ?? '';
      // Parse mqtt[s]://host:port form into address + tls flag.
      const parsed = parseBrokerUrl(brokerUrl);
      const root = (topicOverride.trim() || cfg.rootTopic || 'msh').trim();

      // 1. Populate firmware MQTT module fields via parent setters
      applyToFirmwareModule({
        mqttEnabled: true,
        mqttAddress: parsed.address,
        mqttUsername: cfg.broker?.username ?? '',
        mqttPassword: cfg.broker?.password ?? '',
        mqttRoot: root,
        mqttEncryptionEnabled: true,
        mqttJsonEnabled: false,
        tlsEnabled: parsed.tls,
        proxyToClientEnabled: true,
      });

      // 2. Persist the link on the Meshtastic source so the backend bridge
      //    knows which MQTT source to route firmware proxy traffic through.
      const sourceRes = await fetch(`${appBasename}/api/sources/${sourceId}`, {
        credentials: 'include',
      });
      if (!sourceRes.ok) throw new Error(`Failed to load source: ${sourceRes.status}`);
      const sourceJson = await sourceRes.json();
      const updatedConfig = {
        ...(sourceJson.config ?? {}),
        mqttLink: {
          enabled: true,
          mqttSourceId: selectedSource.id,
          ...(topicOverride.trim() ? { topicOverride: topicOverride.trim() } : {}),
        },
      };
      const putRes = await fetch(`${appBasename}/api/sources/${sourceId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: updatedConfig }),
      });
      if (!putRes.ok) {
        const body = await putRes.text();
        throw new Error(`Failed to save link: ${putRes.status} ${body}`);
      }
      setAppliedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="setting-item" style={{ borderBottom: '1px solid var(--ctp-surface1)', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}>
      <label style={{ fontWeight: 600 }}>
        {t('mqtt_config.quick_connect.title', 'Quick Connect')}
      </label>
      <span className="setting-description">
        {t(
          'mqtt_config.quick_connect.description',
          'Use an existing MQTT source to auto-populate this device’s MQTT module config and replace the mqtt-proxy sidecar.',
        )}
      </span>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem', flexWrap: 'wrap' }}>
        <select
          className="setting-input"
          value={selectedSourceId}
          onChange={(e) => setSelectedSourceId(e.target.value)}
          style={{ flex: '1 1 200px', minWidth: '200px' }}
          disabled={applying}
        >
          <option value="">
            {t('mqtt_config.quick_connect.placeholder', '— Pick an MQTT source —')}
          </option>
          {mqttSources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input
          className="setting-input"
          type="text"
          value={topicOverride}
          onChange={(e) => setTopicOverride(e.target.value)}
          placeholder={t('mqtt_config.quick_connect.topic_override_placeholder', 'Topic override (optional)')}
          style={{ flex: '1 1 200px', minWidth: '180px' }}
          disabled={applying || !selectedSourceId}
        />
        <button
          type="button"
          className="setting-button"
          onClick={onApply}
          disabled={!selectedSourceId || applying}
        >
          {applying
            ? t('mqtt_config.quick_connect.applying', 'Applying…')
            : t('mqtt_config.quick_connect.apply', 'Apply')}
        </button>
      </div>
      {error && (
        <div className="setting-description" style={{ color: 'var(--ctp-red, #f38ba8)', marginTop: '0.5rem' }}>
          {error}
        </div>
      )}
      {appliedAt && !error && (
        <div className="setting-description" style={{ color: 'var(--ctp-green, #a6e3a1)', marginTop: '0.5rem' }}>
          {t(
            'mqtt_config.quick_connect.applied',
            'Quick Connect applied. Review the fields below and click Save to push the config to the device.',
          )}
        </div>
      )}
    </div>
  );
};

function parseBrokerUrl(url: string): { address: string; tls: boolean } {
  // mqtt://host[:port] | mqtts://host[:port] | host[:port]
  try {
    const m = url.match(/^(mqtts?|tcp|ssl):\/\/(.+)$/i);
    const scheme = m?.[1]?.toLowerCase() ?? 'mqtt';
    const rest = m?.[2] ?? url;
    return {
      address: rest.replace(/\/$/, ''),
      tls: scheme === 'mqtts' || scheme === 'ssl',
    };
  } catch {
    return { address: url, tls: false };
  }
}

export default MqttQuickConnect;
