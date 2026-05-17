import React, { useRef, useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useDashboardSources } from '../../hooks/useDashboardData';

interface MQTTConfigSectionProps {
  mqttEnabled: boolean;
  mqttAddress: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttEncryptionEnabled: boolean;
  mqttJsonEnabled: boolean;
  mqttRoot: string;
  tlsEnabled: boolean;
  proxyToClientEnabled: boolean;
  mapReportingEnabled: boolean;
  mapPublishIntervalSecs: number;
  mapPositionPrecision: number;
  setMqttEnabled: (value: boolean) => void;
  setMqttAddress: (value: string) => void;
  setMqttUsername: (value: string) => void;
  setMqttPassword: (value: string) => void;
  setMqttEncryptionEnabled: (value: boolean) => void;
  setMqttJsonEnabled: (value: boolean) => void;
  setMqttRoot: (value: string) => void;
  setTlsEnabled: (value: boolean) => void;
  setProxyToClientEnabled: (value: boolean) => void;
  setMapReportingEnabled: (value: boolean) => void;
  setMapPublishIntervalSecs: (value: number) => void;
  setMapPositionPrecision: (value: number) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const MQTTConfigSection: React.FC<MQTTConfigSectionProps> = ({
  mqttEnabled,
  mqttAddress,
  mqttUsername,
  mqttPassword,
  mqttEncryptionEnabled,
  mqttJsonEnabled,
  mqttRoot,
  tlsEnabled,
  proxyToClientEnabled,
  mapReportingEnabled,
  mapPublishIntervalSecs,
  mapPositionPrecision,
  setMqttEnabled,
  setMqttAddress,
  setMqttUsername,
  setMqttPassword,
  setMqttEncryptionEnabled,
  setMqttJsonEnabled,
  setMqttRoot,
  setTlsEnabled,
  setProxyToClientEnabled,
  setMapReportingEnabled,
  setMapPublishIntervalSecs,
  setMapPositionPrecision,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // Quick-configure: list of locally-configured mqtt_broker sources the user
  // can point this device at with one click. Bridges are not offered here —
  // devices publish to the embedded broker, the bridge fans out to upstream.
  const { data: allSources = [] } = useDashboardSources();
  const brokerSources = useMemo(
    () => allSources.filter((s) => s.type === 'mqtt_broker' && s.enabled),
    [allSources],
  );
  const [quickConfigSelection, setQuickConfigSelection] = useState('');
  const applyQuickConfig = useCallback(
    (sourceId: string) => {
      setQuickConfigSelection(sourceId);
      if (!sourceId) return;
      const src = brokerSources.find((s) => s.id === sourceId);
      const cfg = src?.config as
        | {
            listener?: { port?: number };
            auth?: { username?: string; password?: string };
            rootTopic?: string;
          }
        | undefined;
      if (!cfg) return;
      // Address: use the hostname the operator is using to reach MeshMonitor
      // as a best-guess LAN address for the broker. Operator can edit if it's
      // wrong (e.g. when running behind a reverse proxy).
      const host = window.location.hostname || 'localhost';
      const port = cfg.listener?.port ?? 1883;
      setMqttEnabled(true);
      setMqttAddress(port === 1883 ? host : `${host}:${port}`);
      if (cfg.auth?.username) setMqttUsername(cfg.auth.username);
      if (cfg.auth?.password) setMqttPassword(cfg.auth.password);
      if (cfg.rootTopic) setMqttRoot(cfg.rootTopic);
      // Embedded broker v1 is plain TCP; firmware MQTT encryption is the
      // device-payload encryption flag and is a sane default for any broker.
      setTlsEnabled(false);
      setMqttEncryptionEnabled(true);
    },
    [
      brokerSources,
      setMqttEnabled,
      setMqttAddress,
      setMqttUsername,
      setMqttPassword,
      setMqttRoot,
      setTlsEnabled,
      setMqttEncryptionEnabled,
    ],
  );

  // Track initial values for change detection
  const initialValuesRef = useRef({
    mqttEnabled, mqttAddress, mqttUsername, mqttPassword,
    mqttEncryptionEnabled, mqttJsonEnabled, mqttRoot, tlsEnabled,
    proxyToClientEnabled, mapReportingEnabled, mapPublishIntervalSecs, mapPositionPrecision
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      mqttEnabled !== initial.mqttEnabled ||
      mqttAddress !== initial.mqttAddress ||
      mqttUsername !== initial.mqttUsername ||
      mqttPassword !== initial.mqttPassword ||
      mqttEncryptionEnabled !== initial.mqttEncryptionEnabled ||
      mqttJsonEnabled !== initial.mqttJsonEnabled ||
      mqttRoot !== initial.mqttRoot ||
      tlsEnabled !== initial.tlsEnabled ||
      proxyToClientEnabled !== initial.proxyToClientEnabled ||
      mapReportingEnabled !== initial.mapReportingEnabled ||
      mapPublishIntervalSecs !== initial.mapPublishIntervalSecs ||
      mapPositionPrecision !== initial.mapPositionPrecision
    );
  }, [mqttEnabled, mqttAddress, mqttUsername, mqttPassword,
      mqttEncryptionEnabled, mqttJsonEnabled, mqttRoot, tlsEnabled,
      proxyToClientEnabled, mapReportingEnabled, mapPublishIntervalSecs, mapPositionPrecision]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setMqttEnabled(initial.mqttEnabled);
    setMqttAddress(initial.mqttAddress);
    setMqttUsername(initial.mqttUsername);
    setMqttPassword(initial.mqttPassword);
    setMqttEncryptionEnabled(initial.mqttEncryptionEnabled);
    setMqttJsonEnabled(initial.mqttJsonEnabled);
    setMqttRoot(initial.mqttRoot);
    setTlsEnabled(initial.tlsEnabled);
    setProxyToClientEnabled(initial.proxyToClientEnabled);
    setMapReportingEnabled(initial.mapReportingEnabled);
    setMapPublishIntervalSecs(initial.mapPublishIntervalSecs);
    setMapPositionPrecision(initial.mapPositionPrecision);
  }, [setMqttEnabled, setMqttAddress, setMqttUsername, setMqttPassword,
      setMqttEncryptionEnabled, setMqttJsonEnabled, setMqttRoot, setTlsEnabled,
      setProxyToClientEnabled, setMapReportingEnabled, setMapPublishIntervalSecs, setMapPositionPrecision]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      mqttEnabled, mqttAddress, mqttUsername, mqttPassword,
      mqttEncryptionEnabled, mqttJsonEnabled, mqttRoot, tlsEnabled,
      proxyToClientEnabled, mapReportingEnabled, mapPublishIntervalSecs, mapPositionPrecision
    };
  }, [onSave, mqttEnabled, mqttAddress, mqttUsername, mqttPassword,
      mqttEncryptionEnabled, mqttJsonEnabled, mqttRoot, tlsEnabled,
      proxyToClientEnabled, mapReportingEnabled, mapPublishIntervalSecs, mapPositionPrecision]);

  // Register with SaveBar
  useSaveBar({
    id: 'mqtt-config',
    sectionName: t('mqtt_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('mqtt_config.title')}
        <a
          href="https://meshmonitor.org/features/device#mqtt-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('mqtt_config.view_docs')}
        >
          ❓
        </a>
      </h3>
      {brokerSources.length > 0 && (
        <div className="setting-item">
          <label htmlFor="mqttQuickConfig">
            {t('mqtt_config.quick_configure', 'Quick configure from MeshMonitor broker')}
            <span className="setting-description">
              {t(
                'mqtt_config.quick_configure_description',
                'Auto-fill these fields to point the device at an embedded MQTT broker configured in MeshMonitor.',
              )}
            </span>
          </label>
          <select
            id="mqttQuickConfig"
            className="setting-input"
            value={quickConfigSelection}
            onChange={(e) => applyQuickConfig(e.target.value)}
          >
            <option value="">{t('common.select', 'Select…')}</option>
            {brokerSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="setting-item">
        <label htmlFor="mqttEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="mqttEnabled"
            type="checkbox"
            checked={mqttEnabled}
            onChange={(e) => setMqttEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('mqtt_config.enable')}</div>
            <span className="setting-description">{t('mqtt_config.enable_description')}</span>
          </div>
        </label>
      </div>
      {mqttEnabled && (
        <>
          <div className="setting-item">
            <label htmlFor="mqttAddress">
              {t('mqtt_config.server_address')}
              <span className="setting-description">{t('mqtt_config.server_address_description')}</span>
            </label>
            <input
              id="mqttAddress"
              type="text"
              value={mqttAddress}
              onChange={(e) => setMqttAddress(e.target.value)}
              className="setting-input"
              placeholder="mqtt.meshtastic.org"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttUsername">
              {t('mqtt_config.username')}
              <span className="setting-description">{t('mqtt_config.username_description')}</span>
            </label>
            <input
              id="mqttUsername"
              type="text"
              value={mqttUsername}
              onChange={(e) => setMqttUsername(e.target.value)}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttPassword">
              {t('mqtt_config.password')}
              <span className="setting-description">{t('mqtt_config.password_description')}</span>
            </label>
            <input
              id="mqttPassword"
              type="password"
              value={mqttPassword}
              onChange={(e) => setMqttPassword(e.target.value)}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttRoot">
              {t('mqtt_config.root_topic')}
              <span className="setting-description">{t('mqtt_config.root_topic_description')}</span>
            </label>
            <input
              id="mqttRoot"
              type="text"
              value={mqttRoot}
              onChange={(e) => setMqttRoot(e.target.value)}
              className="setting-input"
              placeholder="msh/US"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttEncryption" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="mqttEncryption"
                type="checkbox"
                checked={mqttEncryptionEnabled}
                onChange={(e) => setMqttEncryptionEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('mqtt_config.encryption_enabled')}</div>
                <span className="setting-description">{t('mqtt_config.encryption_description')}</span>
              </div>
            </label>
          </div>
          <div className="setting-item">
            <label htmlFor="mqttJson" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="mqttJson"
                type="checkbox"
                checked={mqttJsonEnabled}
                onChange={(e) => setMqttJsonEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('mqtt_config.json_enabled')}</div>
                <span className="setting-description">{t('mqtt_config.json_description')}</span>
              </div>
            </label>
          </div>
          <div className="setting-item">
            <label htmlFor="tlsEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="tlsEnabled"
                type="checkbox"
                checked={tlsEnabled}
                onChange={(e) => setTlsEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('mqtt_config.tls_enabled')}</div>
                <span className="setting-description">{t('mqtt_config.tls_description')}</span>
              </div>
            </label>
          </div>
          <div className="setting-item">
            <label htmlFor="proxyToClientEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="proxyToClientEnabled"
                type="checkbox"
                checked={proxyToClientEnabled}
                onChange={(e) => setProxyToClientEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('mqtt_config.proxy_to_client')}</div>
                <span className="setting-description">{t('mqtt_config.proxy_to_client_description')}</span>
                <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem', fontStyle: 'italic' }}>
                  {t('mqtt_config.proxy_to_client_meshmonitor_note')}{' '}
                  <a
                    href="https://meshmonitor.org/add-ons/mqtt-proxy.html#mqtt-client-proxy"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#89b4fa' }}
                  >
                    {t('mqtt_config.proxy_to_client_docs_link')}
                  </a>
                </span>
              </div>
            </label>
          </div>
          <div className="setting-item">
            <label htmlFor="mapReportingEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="mapReportingEnabled"
                type="checkbox"
                checked={mapReportingEnabled}
                onChange={(e) => setMapReportingEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('mqtt_config.map_reporting')}</div>
                <span className="setting-description">{t('mqtt_config.map_reporting_description')}</span>
              </div>
            </label>
          </div>
          {mapReportingEnabled && (
            <div style={{
              marginLeft: '1rem',
              paddingLeft: '1rem',
              borderLeft: '2px solid var(--ctp-surface2)',
              marginTop: '0.5rem',
              marginBottom: '1rem'
            }}>
              <div className="setting-item">
                <label htmlFor="mapPublishIntervalSecs">
                  {t('mqtt_config.map_publish_interval')}
                  <span className="setting-description">{t('mqtt_config.map_publish_interval_description')}</span>
                </label>
                <input
                  id="mapPublishIntervalSecs"
                  type="number"
                  min="0"
                  max="4294967295"
                  value={mapPublishIntervalSecs}
                  onChange={(e) => setMapPublishIntervalSecs(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '150px' }}
                />
              </div>
              <div className="setting-item">
                <label htmlFor="mapPositionPrecision">
                  {t('mqtt_config.map_position_precision')}
                  <span className="setting-description">{t('mqtt_config.map_position_precision_description')}</span>
                </label>
                <input
                  id="mapPositionPrecision"
                  type="number"
                  min="10"
                  max="19"
                  value={mapPositionPrecision}
                  onChange={(e) => setMapPositionPrecision(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default MQTTConfigSection;
