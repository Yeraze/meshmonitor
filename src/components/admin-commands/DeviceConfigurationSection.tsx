import React from 'react';
import { useTranslation } from 'react-i18next';
import { ROLE_OPTIONS } from '../configuration/constants';

interface DeviceConfigurationSectionProps {
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

  // Owner Config
  ownerLongName: string;
  ownerShortName: string;
  ownerIsUnmessagable: boolean;
  onOwnerConfigChange: (field: string, value: any) => void;
  onSaveOwnerConfig: () => Promise<void>;

  // Device Config
  deviceRole: number;
  nodeInfoBroadcastSecs: number;
  isRoleDropdownOpen: boolean;
  onDeviceConfigChange: (field: string, value: any) => void;
  onRoleDropdownToggle: () => void;
  onRoleChange: (newRole: number) => void;
  onSaveDeviceConfig: () => Promise<void>;

  // Position Config (23 state variables)
  positionBroadcastSecs: number;
  positionSmartEnabled: boolean;
  fixedPosition: boolean;
  fixedLatitude: number;
  fixedLongitude: number;
  fixedAltitude: number;
  gpsUpdateInterval: number;
  rxGpio?: number;
  txGpio?: number;
  gpsEnGpio?: number;
  broadcastSmartMinimumDistance: number;
  broadcastSmartMinimumIntervalSecs: number;
  gpsMode: number;
  positionFlagAltitude: boolean;
  positionFlagAltitudeMsl: boolean;
  positionFlagGeoidalSeparation: boolean;
  positionFlagDop: boolean;
  positionFlagHvdop: boolean;
  positionFlagSatinview: boolean;
  positionFlagSeqNo: boolean;
  positionFlagTimestamp: boolean;
  positionFlagHeading: boolean;
  positionFlagSpeed: boolean;
  onPositionConfigChange: (field: string, value: any) => void;
  onPositionFlagChange: (flag: string, value: boolean) => void;
  onSavePositionConfig: () => Promise<void>;

  // Bluetooth Config
  bluetoothEnabled: boolean;
  bluetoothMode: number;
  bluetoothFixedPin: number;
  onBluetoothConfigChange: (field: string, value: any) => void;
  onSaveBluetoothConfig: () => Promise<void>;

  // Common
  isExecuting: boolean;
  selectedNodeNum: number | null;
}

export const DeviceConfigurationSection: React.FC<DeviceConfigurationSectionProps> = ({
  CollapsibleSection,
  ownerLongName,
  ownerShortName,
  ownerIsUnmessagable,
  onOwnerConfigChange,
  onSaveOwnerConfig,
  deviceRole,
  nodeInfoBroadcastSecs,
  isRoleDropdownOpen,
  onDeviceConfigChange,
  onRoleDropdownToggle,
  onRoleChange,
  onSaveDeviceConfig,
  positionBroadcastSecs,
  positionSmartEnabled,
  fixedPosition,
  fixedLatitude,
  fixedLongitude,
  fixedAltitude,
  gpsUpdateInterval,
  rxGpio,
  txGpio,
  gpsEnGpio,
  broadcastSmartMinimumDistance,
  broadcastSmartMinimumIntervalSecs,
  gpsMode,
  positionFlagAltitude,
  positionFlagAltitudeMsl,
  positionFlagGeoidalSeparation,
  positionFlagDop,
  positionFlagHvdop,
  positionFlagSatinview,
  positionFlagSeqNo,
  positionFlagTimestamp,
  positionFlagHeading,
  positionFlagSpeed,
  onPositionConfigChange,
  onPositionFlagChange,
  onSavePositionConfig,
  bluetoothEnabled,
  bluetoothMode,
  bluetoothFixedPin,
  onBluetoothConfigChange,
  onSaveBluetoothConfig,
  isExecuting,
  selectedNodeNum,
}) => {
  const { t } = useTranslation();

  return (
    <CollapsibleSection
      id="device-config"
      title={t('admin_commands.device_configuration', 'Device Configuration')}
    >
      {/* Set Owner Section */}
      <CollapsibleSection
        id="admin-set-owner"
        title={t('admin_commands.set_owner')}
        defaultExpanded={true}
        nested={true}
      >
        <div className="setting-item">
          <label>
            {t('admin_commands.long_name')}
            <span className="setting-description">
              {t('admin_commands.long_name_description')}
            </span>
          </label>
          <input
            type="text"
            value={ownerLongName}
            onChange={(e) => onOwnerConfigChange('longName', e.target.value)}
            disabled={isExecuting}
            placeholder={t('admin_commands.long_name_placeholder')}
            className="setting-input"
          />
        </div>
        <div className="setting-item">
          <label>
            {t('admin_commands.short_name')}
            <span className="setting-description">
              {t('admin_commands.short_name_description')}
            </span>
          </label>
          <input
            type="text"
            value={ownerShortName}
            onChange={(e) => onOwnerConfigChange('shortName', e.target.value)}
            disabled={isExecuting}
            placeholder={t('admin_commands.short_name_placeholder')}
            maxLength={4}
            className="setting-input"
          />
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={ownerIsUnmessagable}
              onChange={(e) => onOwnerConfigChange('isUnmessagable', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.mark_unmessagable')}</div>
              <span className="setting-description">{t('admin_commands.mark_unmessagable_description')}</span>
            </div>
          </label>
        </div>
        <button
          className="save-button"
          onClick={onSaveOwnerConfig}
          disabled={isExecuting || !ownerLongName.trim() || !ownerShortName.trim() || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || !ownerLongName.trim() || !ownerShortName.trim() || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || !ownerLongName.trim() || !ownerShortName.trim() || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.set_owner_button')}
        </button>
      </CollapsibleSection>

      {/* Device Config Section */}
      <CollapsibleSection
        id="admin-device-config"
        title={t('admin_commands.device_configuration')}
        nested={true}
      >
        <div className="setting-item">
          <label>
            {t('admin_commands.device_role')}
            <span className="setting-description">
              {t('admin_commands.device_role_description')}
            </span>
          </label>
          <div style={{ position: 'relative' }}>
            <div
              onClick={onRoleDropdownToggle}
              className="setting-input config-custom-dropdown"
              style={{
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.75rem',
                minHeight: '80px',
                width: '100%',
                maxWidth: '800px'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.1em', color: 'var(--ctp-text)', marginBottom: '0.5rem' }}>
                  {ROLE_OPTIONS.find(opt => opt.value === deviceRole)?.name || 'CLIENT'}
                </div>
                <div style={{ fontSize: '0.9em', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', lineHeight: '1.4' }}>
                  {ROLE_OPTIONS.find(opt => opt.value === deviceRole)?.shortDesc || ''}
                </div>
                <div style={{ fontSize: '0.85em', color: 'var(--ctp-subtext1)', fontStyle: 'italic', lineHeight: '1.4' }}>
                  {ROLE_OPTIONS.find(opt => opt.value === deviceRole)?.description || ''}
                </div>
              </div>
              <span style={{ fontSize: '1.2em', marginLeft: '1rem', flexShrink: 0 }}>{isRoleDropdownOpen ? '▲' : '▼'}</span>
            </div>
            {isRoleDropdownOpen && (
              <div
                className="config-custom-dropdown-menu"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  width: '100%',
                  maxWidth: '800px',
                  background: 'var(--ctp-base)',
                  border: '2px solid var(--ctp-surface2)',
                  borderRadius: '8px',
                  maxHeight: '500px',
                  overflowY: 'auto',
                  zIndex: 1000,
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
                }}
              >
                {ROLE_OPTIONS.map(option => (
                  <div
                    key={option.value}
                    onClick={() => onRoleChange(option.value)}
                    style={{
                      padding: '0.75rem 1rem',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--ctp-surface1)',
                      background: option.value === deviceRole ? 'var(--ctp-surface0)' : 'transparent',
                      transition: 'background 0.2s'
                    }}
                    onMouseEnter={(e) => {
                      if (option.value !== deviceRole) {
                        e.currentTarget.style.background = 'var(--ctp-surface0)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (option.value !== deviceRole) {
                        e.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    <div style={{ fontWeight: 'bold', fontSize: '1em', color: 'var(--ctp-text)', marginBottom: '0.4rem' }}>
                      {option.name}
                    </div>
                    <div style={{ fontSize: '0.9em', color: 'var(--ctp-subtext0)', marginBottom: '0.3rem', lineHeight: '1.4' }}>
                      {option.shortDesc}
                    </div>
                    <div style={{ fontSize: '0.85em', color: 'var(--ctp-subtext1)', fontStyle: 'italic', lineHeight: '1.4' }}>
                      {option.description}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="setting-item">
          <label>
            {t('admin_commands.node_info_broadcast')}
            <span className="setting-description">
              {t('admin_commands.node_info_broadcast_description')}
            </span>
          </label>
          <input
            type="number"
            min="3600"
            max="4294967295"
            value={nodeInfoBroadcastSecs}
            onChange={(e) => onDeviceConfigChange('nodeInfoBroadcastSecs', parseInt(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <button
          className="save-button"
          onClick={onSaveDeviceConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_device_config')}
        </button>
      </CollapsibleSection>

      {/* Position Config Section */}
      <CollapsibleSection
        id="admin-position-config"
        title={t('admin_commands.position_configuration')}
        nested={true}
      >
        <div className="setting-item">
          <label>
            {t('admin_commands.position_broadcast_interval')}
            <span className="setting-description">{t('admin_commands.position_broadcast_interval_description')}</span>
          </label>
          <input
            type="number"
            min="32"
            max="4294967295"
            value={positionBroadcastSecs}
            onChange={(e) => onPositionConfigChange('positionBroadcastSecs', parseInt(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={positionSmartEnabled}
              onChange={(e) => onPositionConfigChange('positionSmartEnabled', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.smart_position_broadcast')}</div>
              <span className="setting-description">{t('admin_commands.smart_position_broadcast_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={fixedPosition}
              onChange={(e) => onPositionConfigChange('fixedPosition', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.fixed_position')}</div>
              <span className="setting-description">{t('admin_commands.fixed_position_description')}</span>
            </div>
          </label>
        </div>
        {fixedPosition && (
          <>
            <div className="setting-item">
              <label>
                Latitude
                <span className="setting-description">Fixed latitude coordinate (-90 to 90)</span>
              </label>
              <input
                type="number"
                step="0.000001"
                min="-90"
                max="90"
                value={fixedLatitude}
                onChange={(e) => onPositionConfigChange('fixedLatitude', parseFloat(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Longitude
                <span className="setting-description">Fixed longitude coordinate (-180 to 180)</span>
              </label>
              <input
                type="number"
                step="0.000001"
                min="-180"
                max="180"
                value={fixedLongitude}
                onChange={(e) => onPositionConfigChange('fixedLongitude', parseFloat(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Altitude (meters)
                <span className="setting-description">Fixed altitude above sea level</span>
              </label>
              <input
                type="number"
                step="1"
                value={fixedAltitude}
                onChange={(e) => onPositionConfigChange('fixedAltitude', parseInt(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
          </>
        )}
        <div className="setting-item">
          <label>
            {t('admin_commands.gps_update_interval')}
            <span className="setting-description">{t('admin_commands.gps_update_interval_description')}</span>
          </label>
          <input
            type="number"
            min="0"
            max="4294967295"
            value={gpsUpdateInterval}
            onChange={(e) => onPositionConfigChange('gpsUpdateInterval', parseInt(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label>
            {t('admin_commands.gps_mode')}
            <span className="setting-description">{t('admin_commands.gps_mode_description')}</span>
          </label>
          <select
            value={gpsMode}
            onChange={(e) => onPositionConfigChange('gpsMode', parseInt(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          >
            <option value={0}>{t('admin_commands.gps_mode_disabled')}</option>
            <option value={1}>{t('admin_commands.gps_mode_enabled')}</option>
            <option value={2}>{t('admin_commands.gps_mode_not_present')}</option>
          </select>
        </div>
        {positionSmartEnabled && (
          <>
            <div className="setting-item">
              <label>
                {t('admin_commands.broadcast_smart_minimum_distance')}
                <span className="setting-description">{t('admin_commands.broadcast_smart_minimum_distance_description')}</span>
              </label>
              <input
                type="number"
                min="0"
                max="4294967295"
                value={broadcastSmartMinimumDistance}
                onChange={(e) => onPositionConfigChange('broadcastSmartMinimumDistance', parseInt(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                {t('admin_commands.broadcast_smart_minimum_interval')}
                <span className="setting-description">{t('admin_commands.broadcast_smart_minimum_interval_description')}</span>
              </label>
              <input
                type="number"
                min="0"
                max="4294967295"
                value={broadcastSmartMinimumIntervalSecs}
                onChange={(e) => onPositionConfigChange('broadcastSmartMinimumIntervalSecs', parseInt(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
          </>
        )}
        <div className="setting-item">
          <label style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>
            {t('admin_commands.position_flags')}
            <span className="setting-description">{t('admin_commands.position_flags_description')}</span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagAltitude}
                onChange={(e) => onPositionFlagChange('altitude', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_altitude')}</span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagAltitudeMsl}
                onChange={(e) => onPositionFlagChange('altitudeMsl', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_altitude_msl')}</span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagGeoidalSeparation}
                onChange={(e) => onPositionFlagChange('geoidalSeparation', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_geoidal_separation')}</span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagDop}
                onChange={(e) => onPositionFlagChange('dop', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_dop')}</span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagHvdop}
                onChange={(e) => onPositionFlagChange('hvdop', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_hvdop')}</span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagSatinview}
                onChange={(e) => onPositionFlagChange('satinview', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_satinview')}</span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagSeqNo}
                onChange={(e) => onPositionFlagChange('seqNo', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_seq_no')}</span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagTimestamp}
                onChange={(e) => onPositionFlagChange('timestamp', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_timestamp')}</span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagHeading}
                onChange={(e) => onPositionFlagChange('heading', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_heading')}</span>
            </label>
            <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={positionFlagSpeed}
                onChange={(e) => onPositionFlagChange('speed', e.target.checked)}
                disabled={isExecuting}
                style={{ width: 'auto', margin: 0 }}
              />
              <span>{t('admin_commands.position_flag_speed')}</span>
            </label>
          </div>
        </div>
        <div className="setting-item">
          <label style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>
            {t('admin_commands.gps_gpio_pins')}
            <span className="setting-description">{t('admin_commands.gps_gpio_pins_description')}</span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            <div>
              <label>
                {t('admin_commands.gps_rx_gpio')}
                <input
                  type="number"
                  min="0"
                  max="255"
                  value={rxGpio ?? ''}
                  onChange={(e) => onPositionConfigChange('rxGpio', e.target.value ? parseInt(e.target.value) : undefined)}
                  disabled={isExecuting}
                  className="setting-input"
                  style={{ width: '150px', marginLeft: '0.5rem' }}
                  placeholder={t('admin_commands.optional')}
                />
              </label>
            </div>
            <div>
              <label>
                {t('admin_commands.gps_tx_gpio')}
                <input
                  type="number"
                  min="0"
                  max="255"
                  value={txGpio ?? ''}
                  onChange={(e) => onPositionConfigChange('txGpio', e.target.value ? parseInt(e.target.value) : undefined)}
                  disabled={isExecuting}
                  className="setting-input"
                  style={{ width: '150px', marginLeft: '0.5rem' }}
                  placeholder={t('admin_commands.optional')}
                />
              </label>
            </div>
            <div>
              <label>
                {t('admin_commands.gps_en_gpio')}
                <input
                  type="number"
                  min="0"
                  max="255"
                  value={gpsEnGpio ?? ''}
                  onChange={(e) => onPositionConfigChange('gpsEnGpio', e.target.value ? parseInt(e.target.value) : undefined)}
                  disabled={isExecuting}
                  className="setting-input"
                  style={{ width: '150px', marginLeft: '0.5rem' }}
                  placeholder={t('admin_commands.optional')}
                />
              </label>
            </div>
          </div>
        </div>
        <button
          className="save-button"
          onClick={onSavePositionConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_position_config')}
        </button>
      </CollapsibleSection>

      {/* Bluetooth Config Section */}
      <CollapsibleSection
        id="admin-bluetooth-config"
        title={t('admin_commands.bluetooth_configuration', 'Bluetooth Configuration')}
        nested={true}
      >
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={bluetoothEnabled}
              onChange={(e) => onBluetoothConfigChange('enabled', e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.enable_bluetooth', 'Enable Bluetooth')}</div>
              <span className="setting-description">{t('admin_commands.enable_bluetooth_description', 'Enable Bluetooth on the device')}</span>
            </div>
          </label>
        </div>
        {bluetoothEnabled && (
          <>
            <div className="setting-item">
              <label>
                {t('admin_commands.bluetooth_pairing_mode', 'Pairing Mode')}
                <span className="setting-description">{t('admin_commands.bluetooth_pairing_mode_description', 'Determines the pairing strategy for the device')}</span>
              </label>
              <select
                value={bluetoothMode}
                onChange={(e) => onBluetoothConfigChange('mode', parseInt(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
              >
                <option value={0}>{t('admin_commands.bluetooth_mode_random_pin', 'Random PIN')}</option>
                <option value={1}>{t('admin_commands.bluetooth_mode_fixed_pin', 'Fixed PIN')}</option>
                <option value={2}>{t('admin_commands.bluetooth_mode_no_pin', 'No PIN')}</option>
              </select>
            </div>
            {bluetoothMode === 1 && (
              <div className="setting-item">
                <label>
                  {t('admin_commands.bluetooth_fixed_pin', 'Fixed PIN')}
                  <span className="setting-description">{t('admin_commands.bluetooth_fixed_pin_description', 'PIN code for pairing (required when using Fixed PIN mode)')}</span>
                </label>
                <input
                  type="number"
                  min="0"
                  max="999999"
                  value={bluetoothFixedPin}
                  onChange={(e) => onBluetoothConfigChange('fixedPin', parseInt(e.target.value) || 0)}
                  disabled={isExecuting}
                  className="setting-input"
                  style={{ width: '100%', maxWidth: '600px' }}
                  placeholder="123456"
                />
              </div>
            )}
          </>
        )}
        <button
          className="save-button"
          onClick={onSaveBluetoothConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_bluetooth_config', 'Save Bluetooth Config')}
        </button>
      </CollapsibleSection>
    </CollapsibleSection>
  );
};

