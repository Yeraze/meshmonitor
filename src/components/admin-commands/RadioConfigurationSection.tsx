import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { MODEM_PRESET_OPTIONS, REGION_OPTIONS, isAmateurRadioRegion, getLegalPresetOptions } from '../configuration/constants';
import type { Channel } from '../../types/device';

interface RadioConfigurationSectionProps {
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

  // LoRa Config
  usePreset: boolean;
  modemPreset: number;
  bandwidth: number;
  spreadFactor: number;
  codingRate: number;
  frequencyOffset: number;
  overrideFrequency: number;
  region: number;
  hopLimit: number;
  txPower: number;
  channelNum: number;
  sx126xRxBoostedGain: boolean;
  ignoreMqtt: boolean;
  configOkToMqtt: boolean;
  onLoRaConfigChange: (field: string, value: any) => void;
  onSaveLoRaConfig: () => Promise<void>;

  // Security Config
  adminKeys: string[];
  isManaged: boolean;
  serialEnabled: boolean;
  debugLogApiEnabled: boolean;
  adminChannelEnabled: boolean;
  onSecurityConfigChange: (field: string, value: any) => void;
  onAdminKeyChange: (index: number, value: string) => void;
  onRemoveAdminKey: (index: number) => void;
  onSaveSecurityConfig: () => Promise<void>;

  // Channels
  nodes: any[];
  currentNodeId: string;
  remoteNodeChannels: Channel[];
  onEditChannel: (index: number) => void;
  onExportChannel: (index: number) => void;
  onImportChannel: (index: number) => void;
  selectedNodeNum: number | null;

  // Common
  isExecuting: boolean;
}

export const RadioConfigurationSection: React.FC<RadioConfigurationSectionProps> = ({
  CollapsibleSection,
  usePreset,
  modemPreset,
  bandwidth,
  spreadFactor,
  codingRate,
  frequencyOffset,
  overrideFrequency,
  region,
  hopLimit,
  txPower,
  channelNum,
  sx126xRxBoostedGain,
  ignoreMqtt,
  configOkToMqtt,
  onLoRaConfigChange,
  onSaveLoRaConfig,
  adminKeys,
  isManaged,
  serialEnabled,
  debugLogApiEnabled,
  adminChannelEnabled,
  onSecurityConfigChange,
  onAdminKeyChange,
  onRemoveAdminKey,
  onSaveSecurityConfig,
  nodes,
  currentNodeId,
  remoteNodeChannels,
  onEditChannel,
  onExportChannel,
  onImportChannel,
  selectedNodeNum,
  isExecuting,
}) => {
  const { t } = useTranslation();

  // Filter the modem-preset picker to presets legal for the selected region,
  // mirroring the official mobile apps (issue #3924, Part 1). The currently
  // selected preset is always retained so the picker reflects the device state.
  const legalPresetOptions = getLegalPresetOptions(region, modemPreset);
  const hasFilteredPresets = legalPresetOptions.length < MODEM_PRESET_OPTIONS.length;

  return (
    <CollapsibleSection
      id="radio-config"
      title={t('admin_commands.radio_configuration', 'Radio Configuration')}
    >
      {/* LoRa Config Section */}
      <CollapsibleSection
        id="admin-lora-config"
        title={t('admin_commands.lora_configuration')}
        nested={true}
      >
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={usePreset}
              onChange={(e) => onLoRaConfigChange('usePreset', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.use_modem_preset')}</div>
              <span className="setting-description">{t('admin_commands.use_modem_preset_description')}</span>
            </div>
          </label>
        </div>
        {usePreset ? (
          <div className="setting-item">
            <label>{t('admin_commands.modem_preset')}</label>
            <select
              value={modemPreset}
              onChange={(e) => onLoRaConfigChange('modemPreset', Number(e.target.value))}
              disabled={isExecuting}
              className="setting-input"
              style={{ width: '300px' }}
            >
              {legalPresetOptions.map(preset => (
                <option key={preset.value} value={preset.value}>
                  {preset.name} - {preset.description} ({preset.params})
                </option>
              ))}
            </select>
            {hasFilteredPresets && (
              <span className="setting-description" style={{ marginTop: '0.4rem', display: 'block' }}>
                {t('lora_config.preset_filtered_note')}
              </span>
            )}
          </div>
        ) : (
          <>
            <div className="setting-item">
              <label>{t('admin_commands.bandwidth')}</label>
              <input
                type="number"
                value={bandwidth}
                onChange={(e) => onLoRaConfigChange('bandwidth', Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>{t('admin_commands.spread_factor')}</label>
              <input
                type="number"
                min="7"
                max="12"
                value={spreadFactor}
                onChange={(e) => onLoRaConfigChange('spreadFactor', Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>Coding Rate</label>
              <input
                type="number"
                value={codingRate}
                onChange={(e) => onLoRaConfigChange('codingRate', Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>Frequency Offset</label>
              <input
                type="number"
                value={frequencyOffset}
                onChange={(e) => onLoRaConfigChange('frequencyOffset', Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>Override Frequency (Hz)</label>
              <input
                type="number"
                value={overrideFrequency}
                onChange={(e) => onLoRaConfigChange('overrideFrequency', Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
          </>
        )}
        <div className="setting-item">
          <label>Region</label>
          <select
            value={region}
            onChange={(e) => onLoRaConfigChange('region', Number(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '300px' }}
          >
            {REGION_OPTIONS.map(reg => (
              <option key={reg.value} value={reg.value}>
                {reg.label}
              </option>
            ))}
          </select>
          {isAmateurRadioRegion(region) && (
            <div
              role="alert"
              className="setting-description"
              style={{
                marginTop: '0.5rem',
                padding: '0.6rem 0.75rem',
                border: '1px solid var(--ctp-yellow)',
                borderRadius: '4px',
                backgroundColor: 'rgba(249, 226, 175, 0.12)',
                color: 'var(--ctp-yellow)',
                lineHeight: '1.4'
              }}
            >
              <UiIcon name="alert" /> {t('lora_config.amateur_band_warning')}
            </div>
          )}
        </div>
        <div className="setting-item">
          <label>Hop Limit (1-7)</label>
          <input
            type="number"
            min="1"
            max="7"
            value={hopLimit}
            onChange={(e) => onLoRaConfigChange('hopLimit', Number(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label>TX Power</label>
          <input
            type="number"
            value={txPower}
            onChange={(e) => onLoRaConfigChange('txPower', Number(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label>Channel Number</label>
          <input
            type="number"
            value={channelNum}
            onChange={(e) => onLoRaConfigChange('channelNum', Number(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={sx126xRxBoostedGain}
              onChange={(e) => onLoRaConfigChange('sx126xRxBoostedGain', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>SX126x RX Boosted Gain</div>
              <span className="setting-description">Enable boosted RX gain for SX126x radios</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={ignoreMqtt}
              onChange={(e) => onLoRaConfigChange('ignoreMqtt', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.ignore_mqtt')}</div>
              <span className="setting-description">{t('admin_commands.ignore_mqtt_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={configOkToMqtt}
              onChange={(e) => onLoRaConfigChange('configOkToMqtt', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.config_ok_to_mqtt')}</div>
              <span className="setting-description">{t('admin_commands.config_ok_to_mqtt_description')}</span>
            </div>
          </label>
        </div>
        <button
          className="save-button"
          onClick={onSaveLoRaConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_lora_config')}
        </button>
      </CollapsibleSection>

      {/* Security Config Section */}
      <CollapsibleSection
        id="admin-security-config"
        title={t('admin_commands.security_configuration')}
        nested={true}
      >
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          {t('admin_commands.security_config_description')}
        </p>
        <div className="setting-item">
          <label>
            {t('admin_commands.admin_keys')}
            <span className="setting-description">
              {t('admin_commands.admin_keys_description')}
            </span>
          </label>
          {adminKeys.map((key, index) => (
            <div key={index} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
              <input
                type="text"
                value={key}
                onChange={(e) => onAdminKeyChange(index, e.target.value)}
                disabled={isExecuting}
                placeholder={t('admin_commands.admin_key_placeholder')}
                className="setting-input"
                style={{ flex: 1 }}
              />
              {adminKeys.length > 1 && (
                <button
                  onClick={() => onRemoveAdminKey(index)}
                  disabled={isExecuting}
                  style={{
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--ctp-red)',
                    color: 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isExecuting ? 'not-allowed' : 'pointer',
                    fontSize: '0.875rem'
                  }}
                >
                  {t('common.remove')}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={isManaged}
              onChange={(e) => onSecurityConfigChange('isManaged', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.is_managed')}</div>
              <span className="setting-description">{t('admin_commands.is_managed_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={serialEnabled}
              onChange={(e) => onSecurityConfigChange('serialEnabled', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.serial_enabled')}</div>
              <span className="setting-description">{t('admin_commands.serial_enabled_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={debugLogApiEnabled}
              onChange={(e) => onSecurityConfigChange('debugLogApiEnabled', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.debug_log_api_enabled')}</div>
              <span className="setting-description">{t('admin_commands.debug_log_api_enabled_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={adminChannelEnabled}
              onChange={(e) => onSecurityConfigChange('adminChannelEnabled', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.admin_channel_enabled')}</div>
              <span className="setting-description">{t('admin_commands.admin_channel_enabled_description')}</span>
            </div>
          </label>
        </div>
        <button
          className="save-button"
          onClick={onSaveSecurityConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_security_config')}
        </button>
      </CollapsibleSection>

      {/* Channel Config Section */}
      <CollapsibleSection
        id="admin-channel-config"
        title={t('admin_commands.channel_configuration')}
        nested={true}
      >
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          {t('admin_commands.channel_config_description')}
        </p>

        <div style={{ display: 'grid', gap: '1rem' }}>
          {Array.from({ length: 8 }, (_, index) => {
            const localNodeNum = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId)?.nodeNum;
            const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;
            let channelsToUse: Channel[];
            if (isLocalNode) {
              channelsToUse = remoteNodeChannels.length > 0 ? remoteNodeChannels : [];
            } else {
              channelsToUse = remoteNodeChannels;
            }
            const channel = channelsToUse.find(ch => ch.id === index);

            return (
              <div
                key={index}
                style={{
                  border: channel?.role === 1
                    ? '2px solid var(--ctp-blue)'
                    : '1px solid var(--ctp-surface1)',
                  borderRadius: '8px',
                  padding: '1rem',
                  backgroundColor: channel ? 'var(--ctp-surface0)' : 'var(--ctp-mantle)',
                  opacity: channel?.role === 0 ? 0.5 : 1,
                  boxShadow: channel?.role === 1 ? '0 0 10px rgba(137, 180, 250, 0.3)' : 'none'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                  <div>
                    <h4 style={{ margin: 0, color: 'var(--ctp-text)' }}>
                      {t('admin_commands.channel_slot', { index })}: {channel ? (
                        <>
                          {channel.name && channel.name.trim().length > 0 ? channel.name : <span style={{ color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>{t('admin_commands.unnamed')}</span>}
                          {channel.role === 1 && <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-blue)', fontSize: '0.8rem' }}><UiIcon name="favorite" size={13} /> {t('admin_commands.primary')}</span>}
                          {channel.role === 2 && <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-green)', fontSize: '0.8rem' }}><UiIcon name="statusOn" size={13} /> {t('admin_commands.secondary')}</span>}
                          {channel.role === 0 && <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-overlay0)', fontSize: '0.8rem' }}><UiIcon name="blocked" size={13} /> {t('admin_commands.disabled')}</span>}
                        </>
                      ) : <span style={{ color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>{t('admin_commands.empty')}</span>}
                    </h4>
                    {channel && (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: 'var(--ctp-subtext1)' }}>
                        <div><UiIcon name={channel.psk && channel.psk !== 'AQ==' ? 'encrypted' : 'unencrypted'} /> {channel.psk && channel.psk !== 'AQ==' ? t('admin_commands.encrypted') : t('admin_commands.unencrypted')}</div>
                        <div>
                          {channel.uplinkEnabled && <><UiIcon name="sortAscending" /> {t('admin_commands.uplink')} </>}
                          {channel.downlinkEnabled && <><UiIcon name="sortDescending" /> {t('admin_commands.downlink')}</>}
                          {!channel.uplinkEnabled && !channel.downlinkEnabled && t('admin_commands.no_bridge')}
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      onClick={() => onEditChannel(index)}
                      disabled={isExecuting || selectedNodeNum === null}
                      style={{
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.9rem',
                        backgroundColor: 'var(--ctp-blue)',
                        color: 'var(--ctp-base)',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer',
                        opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1
                      }}
                    >
                      <UiIcon name="edit" /> {t('common.edit')}
                    </button>
                    {channel && (
                      <button
                        onClick={() => onExportChannel(index)}
                        disabled={isExecuting || selectedNodeNum === null}
                        style={{
                          padding: '0.5rem 0.75rem',
                          fontSize: '0.9rem',
                          backgroundColor: 'var(--ctp-green)',
                          color: 'var(--ctp-base)',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer',
                          opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1
                        }}
                      >
                        <UiIcon name="download" /> {t('common.export')}
                      </button>
                    )}
                    <button
                      onClick={() => onImportChannel(index)}
                      disabled={isExecuting || selectedNodeNum === null}
                      style={{
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.9rem',
                        backgroundColor: 'var(--ctp-yellow)',
                        color: 'var(--ctp-base)',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer',
                        opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1
                      }}
                    >
                      <UiIcon name="upload" /> {t('common.import')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleSection>
    </CollapsibleSection>
  );
};
