/**
 * MqttBridgeSourcePage — per-source detail dashboard for an `mqtt_bridge`.
 *
 * Tabbed layout (Map + Settings) inside the shared MqttSourcePageShell
 * chrome. Bridge-specific settings include upstream URL/creds,
 * subscriptions, downlink/uplink filters, and (in PR B / #3166) topic
 * rewriting fields.
 *
 * Phase 2 (scaffold): tabs render placeholder content. Map tab is wired
 * in Phase 3 (#14) and Settings tab in Phase 5 (#16).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsProvider } from '../contexts/SettingsContext';
import { ToastProvider } from '../components/ToastContainer';
import { MapProvider } from '../contexts/MapContext';
import { useAuth } from '../contexts/AuthContext';
import { useSource } from '../contexts/SourceContext';
import { MqttSourcePageShell } from '../components/MqttSourcePageShell/MqttSourcePageShell';
import { MqttSourceMapTab } from '../components/MqttSourcePageShell/MqttSourceMapTab';
import { MqttBridgeSettingsTab } from '../components/MqttSourcePageShell/MqttBridgeSettingsTab';

interface SourceStatusResponse {
  connected?: boolean;
  upstreamConnected?: boolean;
}

function MqttBridgeSourceInner() {
  const { t } = useTranslation();
  const { sourceId, sourceName } = useSource();
  const { hasPermission } = useAuth();
  const canReadConnection = hasPermission('connection', 'read');

  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!sourceId || !canReadConnection) return;
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/sources/${sourceId}/status`, { credentials: 'include' });
        if (!res.ok) return;
        const data = (await res.json()) as SourceStatusResponse;
        if (!cancelled) setConnected(Boolean(data.connected ?? data.upstreamConnected));
      } catch {
        // Best-effort.
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sourceId, canReadConnection]);

  if (!sourceId) {
    return (
      <div style={{ padding: '2rem' }}>
        <p>{t('source.no_source', 'No source selected.')}</p>
      </div>
    );
  }

  if (!canReadConnection) {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>{t('source.mqtt_bridge.title', 'MQTT Bridge')}</h2>
        <p>
          {t(
            'source.no_permission',
            'You do not have permission to view this source.',
          )}
        </p>
      </div>
    );
  }

  return (
    <MqttSourcePageShell
      title={t('source.mqtt_bridge.shell_title', 'MeshMonitor — MQTT Bridge')}
      sourceName={sourceName}
      connected={connected}
      tabs={[
        {
          id: 'map',
          label: t('source.mqtt.tab.map', 'Map'),
          content: <MqttSourceMapTab sourceId={sourceId} />,
        },
        {
          id: 'settings',
          label: t('source.mqtt.tab.settings', 'Settings'),
          content: <MqttBridgeSettingsTab sourceId={sourceId} />,
        },
      ]}
    />
  );
}

export default function MqttBridgeSourcePage() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <MapProvider>
          <MqttBridgeSourceInner />
        </MapProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
