/**
 * MqttBrokerSourcePage — per-source detail dashboard for an `mqtt_broker`.
 *
 * Hosts a tabbed layout (Map + Settings) inside the shared
 * MqttSourcePageShell chrome. Both tabs read the sourceId from
 * SourceContext via `useSource()`.
 *
 * Phase 1 (scaffold): tabs render placeholder content. Map tab is wired
 * in Phase 3 (#14) and Settings tab in Phase 4 (#15).
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
import { MqttBrokerSettingsTab } from '../components/MqttSourcePageShell/MqttBrokerSettingsTab';

interface SourceStatusResponse {
  connected?: boolean;
  listening?: boolean;
}

function MqttBrokerSourceInner() {
  const { t } = useTranslation();
  const { sourceId, sourceName } = useSource();
  const { hasPermission } = useAuth();
  const canReadConnection = hasPermission('connection', 'read');

  const [connected, setConnected] = useState(false);

  // Poll status so the topbar pill reflects reality. The broker's
  // /api/sources/:id/status returns `listening` for the listener socket
  // plus a synthetic `connected` boolean — fall back to either signal.
  useEffect(() => {
    if (!sourceId || !canReadConnection) return;
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/sources/${sourceId}/status`, { credentials: 'include' });
        if (!res.ok) return;
        const data = (await res.json()) as SourceStatusResponse;
        if (!cancelled) setConnected(Boolean(data.connected ?? data.listening));
      } catch {
        // Best-effort — topbar just shows "disconnected" if we can't reach the API.
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
        <h2>{t('source.mqtt_broker.title', 'MQTT Broker')}</h2>
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
      title={t('source.mqtt_broker.shell_title', 'MeshMonitor — MQTT Broker')}
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
          content: <MqttBrokerSettingsTab sourceId={sourceId} />,
        },
      ]}
    />
  );
}

export default function MqttBrokerSourcePage() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <MapProvider>
          <MqttBrokerSourceInner />
        </MapProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
