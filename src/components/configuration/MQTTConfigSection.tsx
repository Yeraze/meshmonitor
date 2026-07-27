import React, { useRef, useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useDashboardSources } from '../../hooks/useDashboardData';
import { useSource } from '../../contexts/SourceContext';
import { useAuth } from '../../contexts/AuthContext';
import apiService from '../../services/api';
import { logger } from '../../utils/logger';

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
  // True when this source's node is bridged (serial/BLE radio behind a TCP
  // proxy, no native IP). Such a node can only use MQTT via Client Proxy.
  isBridged?: boolean;
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
  isBridged = false,
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
  const { sourceId: currentSourceId } = useSource();
  // PR-C: gate the form by `sources:write` on the current source. `useAuth()`
  // binds the check to the active SourceContext, so passing the explicit
  // sourceId here just makes the intent obvious to readers. Admins are
  // short-circuited to true inside hasPermission.
  const { hasPermission } = useAuth();
  const canEditMqtt = hasPermission('sources', 'write', { sourceId: currentSourceId });

  // Quick-configure: list of valid client-proxy targets the user can point
  // this device at with one click. Two shapes (issue #3134):
  //   - mqtt_broker: device's MQTT traffic flows into the embedded broker
  //     (and from there, optionally upstream via an attached bridge).
  //   - mqtt_bridge (standalone or not): device's MQTT traffic flows
  //     directly upstream through the bridge's MQTT client connection.
  const { data: allSources = [] } = useDashboardSources();
  const proxyTargets = useMemo(
    () =>
      allSources.filter(
        (s) => (s.type === 'mqtt_broker' || s.type === 'mqtt_bridge') && s.enabled,
      ),
    [allSources],
  );
  const [quickConfigSelection, setQuickConfigSelection] = useState('');
  const applyQuickConfig = useCallback(
    (sourceId: string) => {
      setQuickConfigSelection(sourceId);
      if (!sourceId) return;
      const src = proxyTargets.find((s) => s.id === sourceId);
      if (!src) return;

      setMqttEnabled(true);
      // Flip on the firmware's MQTT proxy mode so traffic flows through
      // MeshMonitor's TCP API rather than directly to the broker. The
      // mqttLink stamp below is what actually relays the proxy traffic.
      setProxyToClientEnabled(true);
      // Device-payload encryption is sane on either target.
      setMqttEncryptionEnabled(true);

      if (src.type === 'mqtt_broker') {
        const cfg = src.config as
          | {
              listener?: { port?: number };
              auth?: { username?: string; password?: string };
              rootTopic?: string;
            }
          | undefined;
        // Address: use the hostname the operator is using to reach MeshMonitor
        // as a best-guess LAN address for the broker. Operator can edit if it's
        // wrong (e.g. when running behind a reverse proxy).
        const host = window.location.hostname || 'localhost';
        const port = cfg?.listener?.port ?? 1883;
        setMqttAddress(port === 1883 ? host : `${host}:${port}`);
        if (cfg?.auth?.username) setMqttUsername(cfg.auth.username);
        if (cfg?.auth?.password) setMqttPassword(cfg.auth.password);
        if (cfg?.rootTopic) setMqttRoot(cfg.rootTopic);
        // Embedded broker v1 is plain TCP.
        setTlsEnabled(false);
      } else {
        // mqtt_bridge target — the device never opens its own connection
        // (proxy mode), so the address/credentials are mostly metadata.
        // Fill from the bridge's upstream URL so they match what the
        // firmware would have used in a non-proxied setup.
        const cfg = src.config as
          | {
              upstream?: { url?: string; username?: string };
              subscriptions?: string[];
            }
          | undefined;
        const url = cfg?.upstream?.url ?? '';
        // Parse host:port out of mqtt[s]://host:port — leave alone if empty.
        const match = url.match(/^mqtts?:\/\/([^/]+)/i);
        if (match) {
          setMqttAddress(match[1]);
          setTlsEnabled(url.toLowerCase().startsWith('mqtts://'));
        }
        if (cfg?.upstream?.username) setMqttUsername(cfg.upstream.username);
        // Password is admin-only and not round-tripped; leave field alone.
        // Derive a sensible root topic from the first non-wildcard segment
        // of the first subscription (e.g. `msh/US/CA/#` → `msh/US/CA`).
        const firstSub = cfg?.subscriptions?.[0];
        if (firstSub) {
          const trimmed = firstSub.replace(/\/[+#].*$/, '').replace(/\/+$/, '');
          if (trimmed) setMqttRoot(trimmed);
        }
      }

      // Stamp the parent Meshtastic source's mqttLink so MeshMonitor
      // relays this device's proxy traffic to the selected target. The
      // PUT triggers reconfigureMqttLink server-side without restarting
      // the transport. Best-effort — failure is logged, not surfaced.
      if (currentSourceId) {
        const source = allSources.find((s) => s.id === currentSourceId);
        if (source && source.type === 'meshtastic_tcp') {
          const nextConfig = { ...(source.config ?? {}), mqttLink: { enabled: true, mqttBrokerSourceId: sourceId } };
          apiService.put(`/api/sources/${currentSourceId}`, { config: nextConfig })
            .catch((err) => logger.warn('Failed to stamp mqttLink on parent source:', err));
        }
      }
    },
    [
      proxyTargets,
      allSources,
      currentSourceId,
      setMqttEnabled,
      setMqttAddress,
      setMqttUsername,
      setMqttPassword,
      setMqttRoot,
      setTlsEnabled,
      setMqttEncryptionEnabled,
      setProxyToClientEnabled,
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

  // Detect the "client proxy on, but nothing to proxy through" misconfiguration.
  // We warn when (a) the user has turned on proxyToClientEnabled in the firmware
  // and (b) the parent Meshtastic source has no mqttLink pointing at a known
  // mqtt_broker. The MQTTProxy sidecar — which connects to the Virtual Node
  // Server and publishes externally — is an alternative escape hatch we can't
  // detect reliably from the browser, so we mention it in the warning text and
  // leave the call to the operator.
  const proxyLinkMisconfigured = useMemo(() => {
    if (!proxyToClientEnabled) return false;
    if (!currentSourceId) return false;
    const parent = allSources.find((s) => s.id === currentSourceId);
    if (!parent || parent.type !== 'meshtastic_tcp') return false;
    const link = (parent.config as { mqttLink?: { enabled?: boolean; mqttBrokerSourceId?: string } } | undefined)?.mqttLink;
    if (!link?.enabled || !link.mqttBrokerSourceId) return true;
    // Link references a sourceId that's no longer present, or a type
    // that can't serve as a proxy target. Both mqtt_broker and
    // mqtt_bridge are valid targets (issue #3134).
    const linkedTarget = allSources.find((s) => s.id === link.mqttBrokerSourceId);
    if (!linkedTarget || (linkedTarget.type !== 'mqtt_broker' && linkedTarget.type !== 'mqtt_bridge')) return true;
    return false;
  }, [proxyToClientEnabled, currentSourceId, allSources]);

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

  // Register with SaveBar — but only surface unsaved-changes state to the bar
  // when the caller can actually persist them. If they can't write to this
  // source, the inputs are disabled (see fieldset below) so there shouldn't
  // be changes; this is belt-and-suspenders so a stale local state can't
  // make the SaveBar offer a "Save" action that will 403 server-side.
  useSaveBar({
    id: 'mqtt-config',
    sectionName: t('mqtt_config.title'),
    hasChanges: canEditMqtt && hasChanges,
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
          <UiIcon name="help" />
        </a>
      </h3>
      {isBridged && (
        <div
          role="note"
          data-testid="mqtt-bridged-note"
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            borderRadius: 6,
            background: 'rgba(137, 180, 250, 0.10)', // ctp-blue @ low alpha
            border: '1px solid var(--ctp-blue, #89b4fa)',
            color: 'var(--ctp-text)',
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          <strong style={{ color: 'var(--ctp-blue, #89b4fa)' }}>
            <UiIcon name="network" /> {t('mqtt_config.bridged_recommend_title', 'This is a bridged node')}
          </strong>
          <div style={{ marginTop: 4 }}>
            {t(
              'mqtt_config.bridged_recommend_body',
              'This node has no native WiFi or Ethernet — it is reached through a serial/BLE-to-TCP bridge, so it cannot open its own MQTT connection. We strongly recommend enabling "MQTT Client Proxy" below and linking this source to an MQTT broker, so MeshMonitor relays MQTT on the node’s behalf. Without Client Proxy, MQTT will not work on this node.'
            )}
          </div>
        </div>
      )}
      {!canEditMqtt && (
        <div
          role="alert"
          data-testid="mqtt-permission-banner"
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            borderRadius: 6,
            background: 'rgba(243, 139, 168, 0.10)', // ctp-red @ low alpha
            border: '1px solid var(--ctp-red, #f38ba8)',
            color: 'var(--ctp-text)',
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          <strong style={{ color: 'var(--ctp-red, #f38ba8)' }}>
            <UiIcon name="encrypted" /> {t('mqtt_config.permission_denied', "You don't have permission to modify MQTT settings for this source.")}
          </strong>
        </div>
      )}
      <fieldset
        disabled={!canEditMqtt}
        style={{ border: 'none', padding: 0, margin: 0 }}
      >
      {proxyLinkMisconfigured && (
        <div
          role="alert"
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            borderRadius: 6,
            background: 'rgba(249, 226, 175, 0.10)', // ctp-yellow @ low alpha
            border: '1px solid var(--ctp-yellow, #f9e2af)',
            color: 'var(--ctp-text)',
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          <strong style={{ color: 'var(--ctp-yellow, #f9e2af)' }}>
            <UiIcon name="alert" /> {t('mqtt_config.proxy_warning_title', 'Client proxy is enabled but no broker is linked')}
          </strong>
          <div style={{ marginTop: 6 }}>
            {t(
              'mqtt_config.proxy_warning_body',
              'With "MQTT Client Proxy" on, the device sends its MQTT traffic to MeshMonitor instead of opening its own connection. MeshMonitor will silently drop those messages unless one of:',
            )}
          </div>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            <li>
              {proxyTargets.length > 0
                ? t(
                    'mqtt_config.proxy_warning_link_option',
                    'Pick an MQTT source from the dropdown below — either an embedded broker, or an MQTT bridge that will forward this device’s traffic straight upstream.',
                  )
                : t(
                    'mqtt_config.proxy_warning_no_broker_option',
                    'Create an embedded MQTT broker or an MQTT bridge source first, then return here and pick it from the dropdown that will appear.',
                  )}
            </li>
            <li>
              {t(
                'mqtt_config.proxy_warning_sidecar_option',
                'You have the MQTTProxy sidecar container attached to this source’s Virtual Node Server, which will publish to its own configured upstream. In that case, ignore this warning.',
              )}
            </li>
          </ul>
        </div>
      )}
      {proxyTargets.length > 0 && (
        <div className="setting-item">
          <label htmlFor="mqttQuickConfig">
            {t('mqtt_config.quick_configure', 'Quick configure from a MeshMonitor MQTT source')}
            <span className="setting-description">
              {t(
                'mqtt_config.quick_configure_description',
                'Auto-fill these fields to point the device at an MQTT source configured in MeshMonitor. Brokers receive device traffic locally; bridges forward it straight upstream.',
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
            {proxyTargets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.type === 'mqtt_bridge'
                  ? t('mqtt_config.quick_configure_bridge_option', '{{name}} (bridge → upstream)', { name: s.name })
                  : t('mqtt_config.quick_configure_broker_option', '{{name}} (embedded broker)', { name: s.name })}
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
      </fieldset>
    </div>
  );
};

export default MQTTConfigSection;
