import React from 'react';
import { useTranslation } from 'react-i18next';

interface ModuleConfigurationSectionProps {
  // CollapsibleSection component (passed from parent)
  CollapsibleSection: React.FC<{
    id: string;
    title: string;
    children: React.ReactNode;
    defaultExpanded?: boolean;
    headerActions?: React.ReactNode;
    className?: string;
    nested?: boolean;
  }>;

  // MQTT Config
  mqttEnabled: boolean;
  mqttAddress: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttEncryptionEnabled: boolean;
  mqttJsonEnabled: boolean;
  mqttRoot: string;
  onMQTTConfigChange: (field: string, value: any) => void;
  onSaveMQTTConfig: () => Promise<void>;

  // Neighbor Info Config
  neighborInfoEnabled: boolean;
  neighborInfoUpdateInterval: number;
  neighborInfoTransmitOverLora: boolean;
  onNeighborInfoConfigChange: (field: string, value: any) => void;
  onSaveNeighborInfoConfig: () => Promise<void>;

  // Telemetry Config
  telemetryDeviceUpdateInterval: number;
  telemetryDeviceTelemetryEnabled: boolean;
  telemetryEnvironmentUpdateInterval: number;
  telemetryEnvironmentMeasurementEnabled: boolean;
  telemetryEnvironmentScreenEnabled: boolean;
  telemetryEnvironmentDisplayFahrenheit: boolean;
  telemetryAirQualityEnabled: boolean;
  telemetryAirQualityInterval: number;
  telemetryPowerMeasurementEnabled: boolean;
  telemetryPowerUpdateInterval: number;
  telemetryPowerScreenEnabled: boolean;
  telemetryHealthMeasurementEnabled: boolean;
  telemetryHealthUpdateInterval: number;
  telemetryHealthScreenEnabled: boolean;
  onTelemetryConfigChange: (field: string, value: any) => void;
  onSaveTelemetryConfig: () => Promise<void>;

  // Status Message Config
  statusMessageNodeStatus: string;
  onStatusMessageConfigChange: (field: string, value: any) => void;
  onSaveStatusMessageConfig: () => Promise<void>;
  statusMessageIsDisabled: boolean;

  // Traffic Management Config
  trafficManagementEnabled: boolean;
  trafficManagementPositionDedupEnabled: boolean;
  trafficManagementPositionDedupTimeSecs: number;
  trafficManagementPositionDedupDistanceMeters: number;
  trafficManagementNodeinfoDirectResponseEnabled: boolean;
  trafficManagementNodeinfoDirectResponseMyNodeOnly: boolean;
  trafficManagementRateLimitEnabled: boolean;
  trafficManagementRateLimitMaxPerNode: number;
  trafficManagementRateLimitWindowSecs: number;
  trafficManagementUnknownPacketDropEnabled: boolean;
  trafficManagementUnknownPacketGracePeriodSecs: number;
  trafficManagementHopExhaustionEnabled: boolean;
  trafficManagementHopExhaustionMinHops: number;
  trafficManagementHopExhaustionMaxHops: number;
  onTrafficManagementConfigChange: (field: string, value: any) => void;
  onSaveTrafficManagementConfig: () => Promise<void>;
  trafficManagementIsDisabled: boolean;

  // Common
  isExecuting: boolean;
  selectedNodeNum: number | null;

  // Section header actions (load buttons)
  mqttHeaderActions?: React.ReactNode;
  neighborInfoHeaderActions?: React.ReactNode;
  telemetryHeaderActions?: React.ReactNode;
  statusMessageHeaderActions?: React.ReactNode;
  trafficManagementHeaderActions?: React.ReactNode;
}

export const ModuleConfigurationSection: React.FC<ModuleConfigurationSectionProps> = ({
  CollapsibleSection,
  mqttEnabled,
  mqttAddress,
  mqttUsername,
  mqttPassword,
  mqttEncryptionEnabled,
  mqttJsonEnabled,
  mqttRoot,
  onMQTTConfigChange,
  onSaveMQTTConfig,
  neighborInfoEnabled,
  neighborInfoUpdateInterval,
  neighborInfoTransmitOverLora,
  onNeighborInfoConfigChange,
  onSaveNeighborInfoConfig,
  telemetryDeviceUpdateInterval,
  telemetryDeviceTelemetryEnabled,
  telemetryEnvironmentUpdateInterval,
  telemetryEnvironmentMeasurementEnabled,
  telemetryEnvironmentScreenEnabled,
  telemetryEnvironmentDisplayFahrenheit,
  telemetryAirQualityEnabled,
  telemetryAirQualityInterval,
  telemetryPowerMeasurementEnabled,
  telemetryPowerUpdateInterval,
  telemetryPowerScreenEnabled,
  telemetryHealthMeasurementEnabled,
  telemetryHealthUpdateInterval,
  telemetryHealthScreenEnabled,
  onTelemetryConfigChange,
  onSaveTelemetryConfig,
  statusMessageNodeStatus,
  onStatusMessageConfigChange,
  onSaveStatusMessageConfig,
  statusMessageIsDisabled,
  trafficManagementEnabled,
  trafficManagementPositionDedupEnabled,
  trafficManagementPositionDedupTimeSecs,
  trafficManagementPositionDedupDistanceMeters,
  trafficManagementNodeinfoDirectResponseEnabled,
  trafficManagementNodeinfoDirectResponseMyNodeOnly,
  trafficManagementRateLimitEnabled,
  trafficManagementRateLimitMaxPerNode,
  trafficManagementRateLimitWindowSecs,
  trafficManagementUnknownPacketDropEnabled,
  trafficManagementUnknownPacketGracePeriodSecs,
  trafficManagementHopExhaustionEnabled,
  trafficManagementHopExhaustionMinHops,
  trafficManagementHopExhaustionMaxHops,
  onTrafficManagementConfigChange,
  onSaveTrafficManagementConfig,
  trafficManagementIsDisabled,
  isExecuting,
  selectedNodeNum,
  mqttHeaderActions,
  neighborInfoHeaderActions,
  telemetryHeaderActions,
  statusMessageHeaderActions,
  trafficManagementHeaderActions,
}) => {
  const { t } = useTranslation();

  return (
    <CollapsibleSection
      id="module-config"
      title={t('admin_commands.module_configuration', 'Module Configuration')}
    >
      {/* MQTT Config Section */}
      <CollapsibleSection
        id="admin-mqtt-config"
        title={t('admin_commands.mqtt_configuration')}
        nested={true}
        headerActions={mqttHeaderActions}
      >
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={mqttEnabled}
              onChange={(e) => onMQTTConfigChange('enabled', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.enable_mqtt')}</div>
              <span className="setting-description">{t('admin_commands.enable_mqtt_description')}</span>
            </div>
          </label>
        </div>
        {mqttEnabled && (
          <>
            <div className="setting-item">
              <label>
                {t('admin_commands.server_address')}
                <span className="setting-description">{t('admin_commands.server_address_description')}</span>
              </label>
              <input
                type="text"
                value={mqttAddress}
                onChange={(e) => onMQTTConfigChange('address', e.target.value)}
                disabled={isExecuting}
                placeholder="mqtt.meshtastic.org"
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Username
                <span className="setting-description">MQTT broker username</span>
              </label>
              <input
                type="text"
                value={mqttUsername}
                onChange={(e) => onMQTTConfigChange('username', e.target.value)}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Password
                <span className="setting-description">MQTT broker password</span>
              </label>
              <input
                type="password"
                value={mqttPassword}
                onChange={(e) => onMQTTConfigChange('password', e.target.value)}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Root Topic
                <span className="setting-description">MQTT root topic prefix (e.g., msh/US)</span>
              </label>
              <input
                type="text"
                value={mqttRoot}
                onChange={(e) => onMQTTConfigChange('root', e.target.value)}
                disabled={isExecuting}
                placeholder="msh/US"
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
              />
            </div>
            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={mqttEncryptionEnabled}
                  onChange={(e) => onMQTTConfigChange('encryptionEnabled', e.target.checked)}
                  disabled={isExecuting}
                  style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>Encryption Enabled</div>
                  <span className="setting-description">Use TLS encryption for MQTT connection</span>
                </div>
              </label>
            </div>
            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={mqttJsonEnabled}
                  onChange={(e) => onMQTTConfigChange('jsonEnabled', e.target.checked)}
                  disabled={isExecuting}
                  style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>{t('admin_commands.json_enabled')}</div>
                  <span className="setting-description">{t('admin_commands.json_enabled_description')}</span>
                </div>
              </label>
            </div>
          </>
        )}
        <button
          className="save-button"
          onClick={onSaveMQTTConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_mqtt_config')}
        </button>
      </CollapsibleSection>

      {/* Neighbor Info Config Section */}
      <CollapsibleSection
        id="admin-neighborinfo-config"
        title={t('admin_commands.neighborinfo_configuration', 'Neighbor Info Configuration')}
        nested={true}
        headerActions={neighborInfoHeaderActions}
      >
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={neighborInfoEnabled}
              onChange={(e) => onNeighborInfoConfigChange('enabled', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.enable_neighbor_info', 'Enable Neighbor Info')}</div>
              <span className="setting-description">{t('admin_commands.enable_neighbor_info_description', 'Whether the Neighbor Info module is enabled')}</span>
            </div>
          </label>
        </div>
        {neighborInfoEnabled && (
          <>
            <div className="setting-item">
              <label>
                {t('admin_commands.neighbor_info_update_interval', 'Update Interval (seconds)')}
                <span className="setting-description">{t('admin_commands.neighbor_info_update_interval_description', 'Interval in seconds of how often we should try to send our Neighbor Info (minimum is 14400, i.e., 4 hours)')}</span>
              </label>
              <input
                type="number"
                min="14400"
                value={neighborInfoUpdateInterval}
                onChange={(e) => onNeighborInfoConfigChange('updateInterval', parseInt(e.target.value) || 14400)}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
                placeholder="14400"
              />
            </div>
            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={neighborInfoTransmitOverLora}
                  onChange={(e) => onNeighborInfoConfigChange('transmitOverLora', e.target.checked)}
                  disabled={isExecuting}
                  style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>{t('admin_commands.neighbor_info_transmit_over_lora', 'Transmit Over LoRa')}</div>
                  <span className="setting-description">{t('admin_commands.neighbor_info_transmit_over_lora_description', 'Whether in addition to sending it to MQTT and the PhoneAPI, our NeighborInfo should be transmitted over LoRa. Note that this is not available on a channel with default key and name.')}</span>
                </div>
              </label>
            </div>
          </>
        )}
        <button
          className="save-button"
          onClick={onSaveNeighborInfoConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_neighbor_info_config', 'Save Neighbor Info Config')}
        </button>
      </CollapsibleSection>

      {/* Telemetry Config Section */}
      <CollapsibleSection
        id="admin-telemetry-config"
        title={t('admin_commands.telemetry_configuration', 'Telemetry Configuration')}
        nested={true}
        headerActions={telemetryHeaderActions}
      >
        {/* Device Telemetry */}
        <h4 style={{ margin: '0.5rem 0 0.75rem', color: 'var(--ctp-subtext0)' }}>
          {t('telemetry_config.device_section', 'Device Telemetry')}
        </h4>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={telemetryDeviceTelemetryEnabled}
              onChange={(e) => onTelemetryConfigChange('deviceTelemetryEnabled', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('telemetry_config.device_enabled', 'Device Telemetry Enabled')}</div>
              <span className="setting-description">{t('telemetry_config.device_enabled_description', 'Enable sending device metrics (battery, voltage, etc.) to the mesh network')}</span>
            </div>
          </label>
        </div>
        {telemetryDeviceTelemetryEnabled && (
          <div className="setting-item">
            <label>
              {t('telemetry_config.device_interval', 'Device Update Interval (seconds)')}
              <span className="setting-description">{t('telemetry_config.device_interval_description', 'How often to collect and transmit device metrics (battery, voltage, etc.)')}</span>
            </label>
            <input
              type="number"
              min="0"
              value={telemetryDeviceUpdateInterval}
              onChange={(e) => onTelemetryConfigChange('deviceUpdateInterval', parseInt(e.target.value) || 0)}
              disabled={isExecuting}
              className="setting-input"
              style={{ width: '100%', maxWidth: '600px' }}
              placeholder="900"
            />
          </div>
        )}

        {/* Environment Telemetry */}
        <h4 style={{ margin: '1rem 0 0.75rem', color: 'var(--ctp-subtext0)' }}>
          {t('telemetry_config.environment_section', 'Environment Telemetry')}
        </h4>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={telemetryEnvironmentMeasurementEnabled}
              onChange={(e) => onTelemetryConfigChange('environmentMeasurementEnabled', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('telemetry_config.environment_enabled', 'Environment Measurement Enabled')}</div>
              <span className="setting-description">{t('telemetry_config.environment_enabled_description', 'Enable collection of environment sensor data (temperature, humidity, etc.)')}</span>
            </div>
          </label>
        </div>
        {telemetryEnvironmentMeasurementEnabled && (
          <>
            <div className="setting-item">
              <label>
                {t('telemetry_config.environment_interval', 'Environment Update Interval (seconds)')}
                <span className="setting-description">{t('telemetry_config.environment_interval_description', 'How often to collect and transmit environment metrics')}</span>
              </label>
              <input
                type="number"
                min="0"
                value={telemetryEnvironmentUpdateInterval}
                onChange={(e) => onTelemetryConfigChange('environmentUpdateInterval', parseInt(e.target.value) || 0)}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
                placeholder="900"
              />
            </div>
            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={telemetryEnvironmentScreenEnabled}
                  onChange={(e) => onTelemetryConfigChange('environmentScreenEnabled', e.target.checked)}
                  disabled={isExecuting}
                  style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>{t('telemetry_config.environment_screen', 'Show on Device Screen')}</div>
                  <span className="setting-description">{t('telemetry_config.environment_screen_description', 'Display environment data on the device screen')}</span>
                </div>
              </label>
            </div>
            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={telemetryEnvironmentDisplayFahrenheit}
                  onChange={(e) => onTelemetryConfigChange('environmentDisplayFahrenheit', e.target.checked)}
                  disabled={isExecuting}
                  style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>{t('telemetry_config.environment_fahrenheit', 'Display in Fahrenheit')}</div>
                  <span className="setting-description">{t('telemetry_config.environment_fahrenheit_description', 'Display temperature in Fahrenheit instead of Celsius')}</span>
                </div>
              </label>
            </div>
          </>
        )}

        {/* Advanced Settings (Air Quality & Power) */}
        <CollapsibleSection
          id="admin-telemetry-advanced"
          title={t('telemetry_config.advanced_settings', 'Advanced Settings')}
          nested={true}
        >
          {/* Air Quality */}
          <h4 style={{ margin: '0.5rem 0 0.75rem', color: 'var(--ctp-subtext0)' }}>
            {t('telemetry_config.air_quality_section', 'Air Quality Metrics')}
          </h4>
          <div className="setting-item">
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                type="checkbox"
                checked={telemetryAirQualityEnabled}
                onChange={(e) => onTelemetryConfigChange('airQualityEnabled', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0, flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('telemetry_config.air_quality_enabled', 'Air Quality Enabled')}</div>
                <span className="setting-description">{t('telemetry_config.air_quality_enabled_description', 'Enable air quality sensor collection')}</span>
              </div>
            </label>
          </div>
          {telemetryAirQualityEnabled && (
            <div className="setting-item">
              <label>
                {t('telemetry_config.air_quality_interval', 'Air Quality Interval (seconds)')}
                <span className="setting-description">{t('telemetry_config.air_quality_interval_description', 'How often to collect air quality metrics')}</span>
              </label>
              <input
                type="number"
                min="0"
                value={telemetryAirQualityInterval}
                onChange={(e) => onTelemetryConfigChange('airQualityInterval', parseInt(e.target.value) || 0)}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
                placeholder="900"
              />
            </div>
          )}

          {/* Power Metrics */}
          <h4 style={{ margin: '1rem 0 0.75rem', color: 'var(--ctp-subtext0)' }}>
            {t('telemetry_config.power_section', 'Power Metrics')}
          </h4>
          <div className="setting-item">
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                type="checkbox"
                checked={telemetryPowerMeasurementEnabled}
                onChange={(e) => onTelemetryConfigChange('powerMeasurementEnabled', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0, flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('telemetry_config.power_enabled', 'Power Measurement Enabled')}</div>
                <span className="setting-description">{t('telemetry_config.power_enabled_description', 'Enable power metrics collection (INA sensors)')}</span>
              </div>
            </label>
          </div>
          {telemetryPowerMeasurementEnabled && (
            <>
              <div className="setting-item">
                <label>
                  {t('telemetry_config.power_interval', 'Power Update Interval (seconds)')}
                  <span className="setting-description">{t('telemetry_config.power_interval_description', 'How often to collect power metrics')}</span>
                </label>
                <input
                  type="number"
                  min="0"
                  value={telemetryPowerUpdateInterval}
                  onChange={(e) => onTelemetryConfigChange('powerUpdateInterval', parseInt(e.target.value) || 0)}
                  disabled={isExecuting}
                  className="setting-input"
                  style={{ width: '100%', maxWidth: '600px' }}
                  placeholder="900"
                />
              </div>
              <div className="setting-item">
                <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    type="checkbox"
                    checked={telemetryPowerScreenEnabled}
                    onChange={(e) => onTelemetryConfigChange('powerScreenEnabled', e.target.checked)}
                    disabled={isExecuting}
                    style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('telemetry_config.power_screen', 'Show Power on Screen')}</div>
                    <span className="setting-description">{t('telemetry_config.power_screen_description', 'Display power metrics on the device screen')}</span>
                  </div>
                </label>
              </div>
            </>
          )}

          {/* Health Metrics */}
          <h4 style={{ margin: '1rem 0 0.75rem', color: 'var(--ctp-subtext0)' }}>
            {t('telemetry_config.health_section', 'Health Metrics')}
          </h4>
          <div className="setting-item">
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                type="checkbox"
                checked={telemetryHealthMeasurementEnabled}
                onChange={(e) => onTelemetryConfigChange('healthMeasurementEnabled', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0, flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('telemetry_config.health_enabled', 'Health Measurement Enabled')}</div>
                <span className="setting-description">{t('telemetry_config.health_enabled_description', 'Enable collection of health telemetry data')}</span>
              </div>
            </label>
          </div>
          {telemetryHealthMeasurementEnabled && (
            <>
              <div className="setting-item">
                <label>
                  {t('telemetry_config.health_interval', 'Health Update Interval (seconds)')}
                  <span className="setting-description">{t('telemetry_config.health_interval_description', 'How often to send health metrics to the mesh')}</span>
                </label>
                <input
                  type="number"
                  min="0"
                  value={telemetryHealthUpdateInterval}
                  onChange={(e) => onTelemetryConfigChange('healthUpdateInterval', parseInt(e.target.value) || 0)}
                  disabled={isExecuting}
                  className="setting-input"
                  style={{ width: '100%', maxWidth: '600px' }}
                  placeholder="900"
                />
              </div>
              <div className="setting-item">
                <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    type="checkbox"
                    checked={telemetryHealthScreenEnabled}
                    onChange={(e) => onTelemetryConfigChange('healthScreenEnabled', e.target.checked)}
                    disabled={isExecuting}
                    style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('telemetry_config.health_screen', 'Health Screen Enabled')}</div>
                    <span className="setting-description">{t('telemetry_config.health_screen_description', 'Display health metrics on the device screen')}</span>
                  </div>
                </label>
              </div>
            </>
          )}
        </CollapsibleSection>

        <button
          className="save-button"
          onClick={onSaveTelemetryConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            marginTop: '1rem',
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('telemetry_config.save_button', 'Save Telemetry Config')}
        </button>
      </CollapsibleSection>

      {/* Status Message Config Section */}
      <CollapsibleSection
        id="admin-statusmessage-config"
        title={t('statusmessage_config.title', 'Status Message')}
        nested={true}
        headerActions={statusMessageHeaderActions}
      >
        {statusMessageIsDisabled && (
          <div style={{
            padding: '1rem',
            backgroundColor: 'var(--ctp-surface0)',
            borderRadius: '0.5rem',
            color: 'var(--ctp-subtext0)',
            fontStyle: 'italic',
            marginBottom: '1rem'
          }}>
            {t('statusmessage_config.unsupported', 'Unsupported by device firmware — Requires firmware 2.7.19 or greater')}
          </div>
        )}
        <div style={statusMessageIsDisabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
          <div className="setting-item">
            <label>
              {t('statusmessage_config.node_status', 'Node Status')}
              <span className="setting-description">
                {t('statusmessage_config.node_status_description', 'A short status message displayed on the node. Maximum 80 characters.')}
              </span>
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                maxLength={80}
                value={statusMessageNodeStatus}
                onChange={(e) => onStatusMessageConfigChange('nodeStatus', e.target.value)}
                disabled={isExecuting || statusMessageIsDisabled}
                className="setting-input"
                placeholder={t('statusmessage_config.node_status_placeholder', 'Enter status message...')}
              />
              <span style={{
                position: 'absolute',
                right: '0.5rem',
                bottom: '-1.2rem',
                fontSize: '0.75rem',
                color: statusMessageNodeStatus.length >= 70 ? 'var(--ctp-peach)' : 'var(--ctp-subtext0)'
              }}>
                {statusMessageNodeStatus.length}/80
              </span>
            </div>
          </div>
          <button
            className="save-button"
            onClick={onSaveStatusMessageConfig}
            disabled={isExecuting || selectedNodeNum === null || statusMessageIsDisabled}
            style={{
              marginTop: '1.5rem',
              opacity: (isExecuting || selectedNodeNum === null || statusMessageIsDisabled) ? 0.5 : 1,
              cursor: (isExecuting || selectedNodeNum === null || statusMessageIsDisabled) ? 'not-allowed' : 'pointer'
            }}
          >
            {isExecuting ? t('common.saving') : t('statusmessage_config.save_button', 'Save Status Message Config')}
          </button>
        </div>
      </CollapsibleSection>

      {/* Traffic Management Config Section */}
      <CollapsibleSection
        id="admin-trafficmanagement-config"
        title={t('trafficmanagement_config.title', 'Traffic Management')}
        nested={true}
        headerActions={trafficManagementHeaderActions}
      >
        {trafficManagementIsDisabled && (
          <div style={{
            padding: '1rem',
            backgroundColor: 'var(--ctp-surface0)',
            borderRadius: '0.5rem',
            color: 'var(--ctp-subtext0)',
            fontStyle: 'italic',
            marginBottom: '1rem'
          }}>
            {t('trafficmanagement_config.unsupported', 'Unsupported by device firmware — Not yet available in any firmware release')}
          </div>
        )}
        <div style={trafficManagementIsDisabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
          <div className="setting-item">
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                type="checkbox"
                checked={trafficManagementEnabled}
                onChange={(e) => onTrafficManagementConfigChange('enabled', e.target.checked)}
                disabled={isExecuting || trafficManagementIsDisabled}
                style={{ width: 'auto', margin: 0, flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('trafficmanagement_config.enabled', 'Enable Traffic Management')}</div>
                <span className="setting-description">{t('trafficmanagement_config.enabled_description', 'Enable traffic management features to control mesh network traffic')}</span>
              </div>
            </label>
          </div>

          {(trafficManagementEnabled || trafficManagementIsDisabled) && (
            <>
              {/* Position Dedup */}
              <div style={{ marginLeft: '1rem', paddingLeft: '1rem', borderLeft: '2px solid var(--ctp-surface1)', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--ctp-text)', marginBottom: '0.5rem' }}>{t('trafficmanagement_config.position_dedup', 'Position Deduplication')}</div>
                <div className="setting-item">
                  <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                    <input type="checkbox" checked={trafficManagementPositionDedupEnabled} onChange={(e) => onTrafficManagementConfigChange('positionDedupEnabled', e.target.checked)} disabled={isExecuting || trafficManagementIsDisabled} style={{ width: 'auto', margin: 0, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}><div>{t('trafficmanagement_config.position_dedup_enabled', 'Enable')}</div></div>
                  </label>
                </div>
                {(trafficManagementPositionDedupEnabled || trafficManagementIsDisabled) && (
                  <>
                    <div className="setting-item">
                      <label>{t('trafficmanagement_config.position_dedup_time', 'Time Window (seconds)')}</label>
                      <input type="number" min="0" value={trafficManagementPositionDedupTimeSecs} onChange={(e) => onTrafficManagementConfigChange('positionDedupTimeSecs', parseInt(e.target.value) || 0)} disabled={isExecuting || trafficManagementIsDisabled} className="setting-input" />
                    </div>
                    <div className="setting-item">
                      <label>{t('trafficmanagement_config.position_dedup_distance', 'Distance Threshold (meters)')}</label>
                      <input type="number" min="0" value={trafficManagementPositionDedupDistanceMeters} onChange={(e) => onTrafficManagementConfigChange('positionDedupDistanceMeters', parseInt(e.target.value) || 0)} disabled={isExecuting || trafficManagementIsDisabled} className="setting-input" />
                    </div>
                  </>
                )}
              </div>

              {/* NodeInfo Direct Response */}
              <div style={{ marginLeft: '1rem', paddingLeft: '1rem', borderLeft: '2px solid var(--ctp-surface1)', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--ctp-text)', marginBottom: '0.5rem' }}>{t('trafficmanagement_config.nodeinfo_direct_response', 'NodeInfo Direct Response')}</div>
                <div className="setting-item">
                  <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                    <input type="checkbox" checked={trafficManagementNodeinfoDirectResponseEnabled} onChange={(e) => onTrafficManagementConfigChange('nodeinfoDirectResponseEnabled', e.target.checked)} disabled={isExecuting || trafficManagementIsDisabled} style={{ width: 'auto', margin: 0, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}><div>{t('trafficmanagement_config.nodeinfo_direct_response_enabled', 'Enable')}</div></div>
                  </label>
                </div>
                {(trafficManagementNodeinfoDirectResponseEnabled || trafficManagementIsDisabled) && (
                  <div className="setting-item">
                    <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                      <input type="checkbox" checked={trafficManagementNodeinfoDirectResponseMyNodeOnly} onChange={(e) => onTrafficManagementConfigChange('nodeinfoDirectResponseMyNodeOnly', e.target.checked)} disabled={isExecuting || trafficManagementIsDisabled} style={{ width: 'auto', margin: 0, flexShrink: 0 }} />
                      <div style={{ flex: 1 }}><div>{t('trafficmanagement_config.nodeinfo_my_node_only', 'My Node Only')}</div></div>
                    </label>
                  </div>
                )}
              </div>

              {/* Rate Limiting */}
              <div style={{ marginLeft: '1rem', paddingLeft: '1rem', borderLeft: '2px solid var(--ctp-surface1)', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--ctp-text)', marginBottom: '0.5rem' }}>{t('trafficmanagement_config.rate_limiting', 'Rate Limiting')}</div>
                <div className="setting-item">
                  <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                    <input type="checkbox" checked={trafficManagementRateLimitEnabled} onChange={(e) => onTrafficManagementConfigChange('rateLimitEnabled', e.target.checked)} disabled={isExecuting || trafficManagementIsDisabled} style={{ width: 'auto', margin: 0, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}><div>{t('trafficmanagement_config.rate_limit_enabled', 'Enable')}</div></div>
                  </label>
                </div>
                {(trafficManagementRateLimitEnabled || trafficManagementIsDisabled) && (
                  <>
                    <div className="setting-item">
                      <label>{t('trafficmanagement_config.rate_limit_max', 'Max Packets Per Node')}</label>
                      <input type="number" min="0" value={trafficManagementRateLimitMaxPerNode} onChange={(e) => onTrafficManagementConfigChange('rateLimitMaxPerNode', parseInt(e.target.value) || 0)} disabled={isExecuting || trafficManagementIsDisabled} className="setting-input" />
                    </div>
                    <div className="setting-item">
                      <label>{t('trafficmanagement_config.rate_limit_window', 'Window (seconds)')}</label>
                      <input type="number" min="0" value={trafficManagementRateLimitWindowSecs} onChange={(e) => onTrafficManagementConfigChange('rateLimitWindowSecs', parseInt(e.target.value) || 0)} disabled={isExecuting || trafficManagementIsDisabled} className="setting-input" />
                    </div>
                  </>
                )}
              </div>

              {/* Unknown Packet Drop */}
              <div style={{ marginLeft: '1rem', paddingLeft: '1rem', borderLeft: '2px solid var(--ctp-surface1)', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--ctp-text)', marginBottom: '0.5rem' }}>{t('trafficmanagement_config.unknown_packet_drop', 'Unknown Packet Drop')}</div>
                <div className="setting-item">
                  <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                    <input type="checkbox" checked={trafficManagementUnknownPacketDropEnabled} onChange={(e) => onTrafficManagementConfigChange('unknownPacketDropEnabled', e.target.checked)} disabled={isExecuting || trafficManagementIsDisabled} style={{ width: 'auto', margin: 0, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}><div>{t('trafficmanagement_config.unknown_packet_drop_enabled', 'Enable')}</div></div>
                  </label>
                </div>
                {(trafficManagementUnknownPacketDropEnabled || trafficManagementIsDisabled) && (
                  <div className="setting-item">
                    <label>{t('trafficmanagement_config.unknown_packet_grace_period', 'Grace Period (seconds)')}</label>
                    <input type="number" min="0" value={trafficManagementUnknownPacketGracePeriodSecs} onChange={(e) => onTrafficManagementConfigChange('unknownPacketGracePeriodSecs', parseInt(e.target.value) || 0)} disabled={isExecuting || trafficManagementIsDisabled} className="setting-input" />
                  </div>
                )}
              </div>

              {/* Hop Exhaustion */}
              <div style={{ marginLeft: '1rem', paddingLeft: '1rem', borderLeft: '2px solid var(--ctp-surface1)', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--ctp-text)', marginBottom: '0.5rem' }}>{t('trafficmanagement_config.hop_exhaustion', 'Hop Exhaustion')}</div>
                <div className="setting-item">
                  <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                    <input type="checkbox" checked={trafficManagementHopExhaustionEnabled} onChange={(e) => onTrafficManagementConfigChange('hopExhaustionEnabled', e.target.checked)} disabled={isExecuting || trafficManagementIsDisabled} style={{ width: 'auto', margin: 0, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}><div>{t('trafficmanagement_config.hop_exhaustion_enabled', 'Enable')}</div></div>
                  </label>
                </div>
                {(trafficManagementHopExhaustionEnabled || trafficManagementIsDisabled) && (
                  <>
                    <div className="setting-item">
                      <label>{t('trafficmanagement_config.hop_exhaustion_min', 'Minimum Hops')}</label>
                      <input type="number" min="0" max="7" value={trafficManagementHopExhaustionMinHops} onChange={(e) => onTrafficManagementConfigChange('hopExhaustionMinHops', parseInt(e.target.value) || 0)} disabled={isExecuting || trafficManagementIsDisabled} className="setting-input" />
                    </div>
                    <div className="setting-item">
                      <label>{t('trafficmanagement_config.hop_exhaustion_max', 'Maximum Hops')}</label>
                      <input type="number" min="0" max="7" value={trafficManagementHopExhaustionMaxHops} onChange={(e) => onTrafficManagementConfigChange('hopExhaustionMaxHops', parseInt(e.target.value) || 0)} disabled={isExecuting || trafficManagementIsDisabled} className="setting-input" />
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          <button
            className="save-button"
            onClick={onSaveTrafficManagementConfig}
            disabled={isExecuting || selectedNodeNum === null || trafficManagementIsDisabled}
            style={{
              marginTop: '1rem',
              opacity: (isExecuting || selectedNodeNum === null || trafficManagementIsDisabled) ? 0.5 : 1,
              cursor: (isExecuting || selectedNodeNum === null || trafficManagementIsDisabled) ? 'not-allowed' : 'pointer'
            }}
          >
            {isExecuting ? t('common.saving') : t('trafficmanagement_config.save_button', 'Save Traffic Management Config')}
          </button>
        </div>
      </CollapsibleSection>
    </CollapsibleSection>
  );
};

