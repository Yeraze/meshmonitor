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

  // Common
  isExecuting: boolean;
  selectedNodeNum: number | null;

  // Section header actions (load buttons)
  mqttHeaderActions?: React.ReactNode;
  neighborInfoHeaderActions?: React.ReactNode;
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
  isExecuting,
  selectedNodeNum,
  mqttHeaderActions,
  neighborInfoHeaderActions,
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
    </CollapsibleSection>
  );
};

