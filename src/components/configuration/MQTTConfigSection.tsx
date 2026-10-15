import React, { useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { useDashboardSources } from '../../hooks/useDashboardData';
import { useSource } from '../../contexts/SourceContext';
import { useAuth } from '../../contexts/AuthContext';
import apiService, { ApiError } from '../../services/api';
import { queryClient } from '../../config/queryClient';
import { logger } from '../../utils/logger';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';
import { isMqttProxyLinkMisconfigured, MQTT_TRAFFIC_DOCS_URL } from '../../utils/mqttProxyLink';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import BrokerPresetSelector from '../MQTT/BrokerPresetSelector';
import { MqttDocsLinks } from '../MQTT/MqttDocsLinks';
import {
  applyPresetToDevice,
  matchDevicePreset,
  type BrokerPreset,
  type KeptCredentials,
} from '../MQTT/brokerPresets';
import { ConfigSection } from '../shared/config/ConfigSection';
import { PasswordField } from '../shared/config/PasswordField';
import { ConfigGroup } from '../shared/config/ConfigGroup';

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
  // MapReportSettings.should_report_location (fw 2.6.8+).
  mapShouldReportLocation: boolean;
  // True when this source's node is bridged (serial/BLE radio behind a TCP
  // proxy, no native IP). Such a node can only use MQTT via Client Proxy.
  isBridged?: boolean;
  // True when a client on this source's Virtual Node has injected MQTT proxy
  // traffic (the MQTT Proxy sidecar, or a phone app): it carries MQTT for the
  // node, so the "no broker is linked" warning stays hidden.
  proxyClientAttached?: boolean;
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
  setMapShouldReportLocation: (value: boolean) => void;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
  /** Bumped when the page reloads config from the node (#5797). */
  configVersion?: number;
}

const MQTTConfigSection: React.FC<MQTTConfigSectionProps> = ({
  configVersion,
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
  mapShouldReportLocation,
  isBridged = false,
  proxyClientAttached = false,
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
  setMapShouldReportLocation,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const { sourceId: currentSourceId } = useSource();
  // Gate the form on the permission the save route checks:
  // `POST /api/config/mqtt` requires `configuration:write`. It used to check
  // `sources:write`, which locked out users who could save and let others
  // edit a form whose save was then refused. Admins are short-circuited to
  // true inside hasPermission.
  const { hasPermission } = useAuth();
  const canEditMqtt = hasPermission('configuration', 'write', { sourceId: currentSourceId });
  // Quick configure also writes `mqttLink` into this source's config
  // (PUT /api/sources/:id) on Save, so it needs `sources:write` as well.
  const canQuickConfig = canEditMqtt && hasPermission('sources', 'write', { sourceId: currentSourceId });

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
  // The quick-configure target picked since the last save. It fills the form
  // fields AND stages this source's `mqttLink` (#5831): nothing is written
  // until Save, which sends the device config first and then the link.
  // Dismiss drops both. '' = nothing staged.
  const [quickConfigSelection, setQuickConfigSelection] = useState('');
  const [mqttLinkError, setMqttLinkError] = useState<string | null>(null);
  const applyQuickConfig = useCallback(
    (sourceId: string) => {
      setQuickConfigSelection(sourceId);
      setMqttLinkError(null);
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
          // Drop any `user:password@` (or the server's `***@` redaction): the
          // address field takes host:port only.
          setMqttAddress(match[1].slice(match[1].lastIndexOf('@') + 1));
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
    },
    [
      proxyTargets,
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

  // Broker presets (#5689): fill address, TLS and login only. The fields
  // reach the radio only through the existing Save, unchanged.
  const matchedPreset = useMemo(
    () => matchDevicePreset({ address: mqttAddress, tlsEnabled }),
    [mqttAddress, tlsEnabled],
  );
  const applyBrokerPreset = useCallback(
    (preset: BrokerPreset): KeptCredentials => {
      const { fields, kept } = applyPresetToDevice(preset, {
        address: mqttAddress,
        username: mqttUsername,
        password: mqttPassword,
        tlsEnabled,
      });
      setMqttAddress(fields.address);
      setMqttUsername(fields.username);
      setMqttPassword(fields.password);
      setTlsEnabled(fields.tlsEnabled);
      return kept;
    },
    [mqttAddress, mqttUsername, mqttPassword, tlsEnabled, setMqttAddress, setMqttUsername, setMqttPassword, setTlsEnabled],
  );

  // What the node holds; moves on a successful save or a reload (#5797)
  const values = {
    mqttEnabled, mqttAddress, mqttUsername, mqttPassword,
    mqttEncryptionEnabled, mqttJsonEnabled, mqttRoot, tlsEnabled,
    proxyToClientEnabled, mapReportingEnabled, mapPublishIntervalSecs, mapPositionPrecision,
    mapShouldReportLocation
  };
  const { baseline, hasChanges: deviceHasChanges, commit } = useSectionBaseline(values, { reseedKey: configVersion, keepOnReseed: ['mapShouldReportLocation'] });

  // A staged link counts only for a Meshtastic TCP source the caller may edit.
  const linkSource = currentSourceId ? allSources.find((s) => s.id === currentSourceId) : undefined;
  const stagedLinkTarget =
    canQuickConfig && quickConfigSelection && linkSource?.type === 'meshtastic_tcp' ? quickConfigSelection : '';
  const hasChanges = deviceHasChanges || stagedLinkTarget !== '';

  // Detect the "client proxy on, but nothing to proxy through" misconfiguration:
  // the form has MQTT and proxyToClientEnabled on, and the parent Meshtastic
  // source has no mqttLink to an existing, enabled mqtt_broker / mqtt_bridge.
  // The rule lives in isMqttProxyLinkMisconfigured, shared with the dashboard
  // source card (via GET /api/sources/:id/status) so the two cannot disagree.
  // The MQTT Proxy sidecar is seen only once it has injected broker traffic
  // (`proxyClientAttached`); a sidecar on a quiet broker looks like no sidecar,
  // so the warning text still names it and leaves the call to the operator.
  const proxyLinkMisconfigured = useMemo(
    () =>
      isMqttProxyLinkMisconfigured({
        mqttEnabled,
        proxyToClientEnabled,
        sourceId: currentSourceId,
        sources: allSources,
        proxyClientAttached,
      }),
    [mqttEnabled, proxyToClientEnabled, currentSourceId, allSources, proxyClientAttached],
  );

  // Reset to initial values (for SaveBar dismiss), staged link included
  const resetChanges = useCallback(() => {
    setQuickConfigSelection('');
    setMqttLinkError(null);
    setMqttEnabled(baseline.mqttEnabled);
    setMqttAddress(baseline.mqttAddress);
    setMqttUsername(baseline.mqttUsername);
    setMqttPassword(baseline.mqttPassword);
    setMqttEncryptionEnabled(baseline.mqttEncryptionEnabled);
    setMqttJsonEnabled(baseline.mqttJsonEnabled);
    setMqttRoot(baseline.mqttRoot);
    setTlsEnabled(baseline.tlsEnabled);
    setProxyToClientEnabled(baseline.proxyToClientEnabled);
    setMapReportingEnabled(baseline.mapReportingEnabled);
    setMapPublishIntervalSecs(baseline.mapPublishIntervalSecs);
    setMapPositionPrecision(baseline.mapPositionPrecision);
    setMapShouldReportLocation(baseline.mapShouldReportLocation);
  }, [baseline, setMqttEnabled, setMqttAddress, setMqttUsername, setMqttPassword,
      setMqttEncryptionEnabled, setMqttJsonEnabled, setMqttRoot, setTlsEnabled,
      setProxyToClientEnabled, setMapReportingEnabled, setMapPublishIntervalSecs, setMapPositionPrecision,
      setMapShouldReportLocation]);

  /**
   * Stamp this source's mqttLink so MeshMonitor relays the device's proxy
   * traffic to the chosen target. The server then calls reconfigureMqttLink;
   * the transport does not restart. A failure is shown, not just logged.
   */
  const writeMqttLink = async (targetId: string): Promise<boolean> => {
    if (!linkSource || !currentSourceId) return false;
    const nextConfig = { ...(linkSource.config ?? {}), mqttLink: { enabled: true, mqttBrokerSourceId: targetId } };
    try {
      await apiService.put(`/api/sources/${currentSourceId}`, { config: nextConfig });
      void queryClient.invalidateQueries({ queryKey: ['dashboard', 'sources'] });
      return true;
    } catch (err) {
      logger.warn('Failed to stamp mqttLink on parent source:', err);
      const detail = err instanceof ApiError ? err.message : (err as Error)?.message ?? '';
      setMqttLinkError(
        t(
          'mqtt_config.quick_configure_link_failed',
          'The device settings were saved, but linking this source to the MQTT source failed: {{error}}. Save again to retry.',
          { error: detail },
        ),
      );
      return false;
    }
  };

  // Device config first (only when it changed: each save is one
  // set_module_config and usually a reboot), then the staged link. The
  // baseline moves only when the node took the save; the staged link clears
  // only when the link write succeeded, so Save retries just what is left.
  const handleSave = async () => {
    setMqttLinkError(null);
    if (deviceHasChanges) {
      if (!(await onSave())) return;
      commit(values);
    }
    if (stagedLinkTarget && (await writeMqttLink(stagedLinkTarget))) {
      setQuickConfigSelection('');
    }
  };

  // Register with SaveBar — but only surface unsaved-changes state to the bar
  // when the caller can actually persist them. If they can't write to this
  // source, the inputs are disabled (see fieldset below) so there shouldn't
  // be changes; this is belt-and-suspenders so a stale local state can't
  // make the SaveBar offer a "Save" action that will 403 server-side.
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'mqtt-config',
    sectionName: t('mqtt_config.title'),
    hasChanges: canEditMqtt && hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  return (
    <NumberInputScope scope={numberScope}>
    <ConfigSection canWrite={canEditMqtt} title={t('mqtt_config.title')} docsUrl="https://meshmonitor.org/features/device#mqtt-configuration" notice={<ModuleAvailabilityNotice />}>
      {isBridged && (
        <div
          role="note"
          data-testid="mqtt-bridged-note"
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            borderRadius: 6,
            background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
            border: '1px solid var(--color-accent)',
            color: 'var(--color-text)',
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          <strong style={{ color: 'var(--color-accent)' }}>
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
            background: 'color-mix(in srgb, var(--color-error) 10%, transparent)',
            border: '1px solid var(--color-error)',
            color: 'var(--color-text)',
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          <strong style={{ color: 'var(--color-error)' }}>
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
          data-testid="mqtt-proxy-link-warning"
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            borderRadius: 6,
            background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
            border: '1px solid var(--color-warning)',
            color: 'var(--color-text)',
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          <strong style={{ color: 'var(--color-warning)' }}>
            <UiIcon name="alert" /> {t('mqtt_config.proxy_warning_title', 'Client proxy is enabled but no broker is linked')}
          </strong>
          <div style={{ marginTop: 6 }}>
            {t(
              'mqtt_config.proxy_warning_body',
              'With "Proxy to Client" on, the device sends its MQTT traffic to MeshMonitor instead of opening its own connection, and gets broker traffic only from MeshMonitor. MeshMonitor will silently drop those messages unless one of:',
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
          <div style={{ marginTop: 6 }}>
            <a href={MQTT_TRAFFIC_DOCS_URL} target="_blank" rel="noopener noreferrer">
              {t('mqtt_config.proxy_warning_docs_link', 'Why don’t I see MQTT traffic?')}
            </a>
          </div>
        </div>
      )}
      <ConfigGroup title={t('mqtt_config.group_connection', 'Connection')} name="connection">
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
            <MqttDocsLinks />
            <select
              id="mqttQuickConfig"
              className="setting-input"
              value={quickConfigSelection}
              onChange={(e) => applyQuickConfig(e.target.value)}
              disabled={!canQuickConfig}
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
            {stagedLinkTarget && (
              <p className="setting-description" role="status" data-testid="mqtt-quick-config-staged">
                {t(
                  'mqtt_config.quick_configure_staged',
                  'Filled in from {{name}}. Saving also links this source to it; Dismiss undoes both.',
                  { name: proxyTargets.find((s) => s.id === stagedLinkTarget)?.name ?? '' },
                )}
              </p>
            )}
            {mqttLinkError && (
              <div role="alert" className="setting-description" data-testid="mqtt-quick-config-link-error" style={{ color: 'var(--color-error)' }}>
                {mqttLinkError}
              </div>
            )}
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
            <BrokerPresetSelector
              id="mqttBrokerPreset"
              layout="settings"
              matchedPresetId={matchedPreset?.id ?? null}
              onApplyPreset={applyBrokerPreset}
            />
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
          </>
        )}
      </ConfigGroup>
      {mqttEnabled && (
        <>
          <ConfigGroup title={t('mqtt_config.group_credentials', 'Credentials')} name="credentials">
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
              <PasswordField
                id="mqttPassword"
                value={mqttPassword}
                onChange={(e) => setMqttPassword(e.target.value)}
                className="setting-input"
              />
            </div>
          </ConfigGroup>
          <ConfigGroup title={t('mqtt_config.group_topics', 'Topics & format')} name="topics">
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
          </ConfigGroup>
          <ConfigGroup title={t('mqtt_config.group_proxy', 'Proxy')} name="proxy">
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
          </ConfigGroup>
          <ConfigGroup title={t('mqtt_config.group_privacy', 'Privacy & location')} name="privacy">
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
                borderLeft: '2px solid var(--color-surface-active)',
                marginTop: '0.5rem',
                marginBottom: '1rem'
              }}>
                <div className="setting-item">
                  <label htmlFor="mapPublishIntervalSecs">
                    {t('mqtt_config.map_publish_interval')}
                    <span className="setting-description">{t('mqtt_config.map_publish_interval_description')}</span>
                  </label>
                  <NumberInput
                    id="mapPublishIntervalSecs"
                    min={0}
                    max={4294967295}
                    integer
                    value={mapPublishIntervalSecs}
                    onChange={setMapPublishIntervalSecs}
                    className="setting-input"
                    style={{ width: '150px' }}
                  />
                </div>
                <div className="setting-item">
                  <label htmlFor="mapPositionPrecision">
                    {t('mqtt_config.map_position_precision')}
                    <span className="setting-description">{t('mqtt_config.map_position_precision_description')}</span>
                  </label>
                  <NumberInput
                    id="mapPositionPrecision"
                    min={10}
                    max={19}
                    alsoValid={[0]}
                    zeroHint={t('zero_hint.map_position_precision')}
                    integer
                    value={mapPositionPrecision}
                    onChange={setMapPositionPrecision}
                    className="setting-input"
                    style={{ width: '100px' }}
                  />
                </div>
                <div className="setting-item">
                  <label htmlFor="mapShouldReportLocation" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                    <input
                      id="mapShouldReportLocation"
                      type="checkbox"
                      checked={mapShouldReportLocation}
                      onChange={(e) => setMapShouldReportLocation(e.target.checked)}
                      style={{ marginTop: '0.2rem', flexShrink: 0 }}
                    />
                    <div style={{ flex: 1 }}>
                      <div>{t('mqtt_config.map_report_location')}</div>
                      <span className="setting-description">{t('mqtt_config.map_report_location_description')}</span>
                    </div>
                  </label>
                </div>
              </div>
            )}
          </ConfigGroup>
        </>
      )}
      </fieldset>
    </ConfigSection>
    </NumberInputScope>
  );
};

export default MQTTConfigSection;
