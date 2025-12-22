import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ROLE_OPTIONS, TIMEZONE_PRESETS, REBROADCAST_MODE_OPTIONS, BUZZER_MODE_OPTIONS } from './constants';

interface DeviceConfigSectionProps {
  role: number;
  nodeInfoBroadcastSecs: number;
  tzdef: string;
  rebroadcastMode: number;
  doubleTapAsButtonPress: boolean;
  disableTripleClick: boolean;
  ledHeartbeatDisabled: boolean;
  buzzerMode: number;
  buttonGpio: number;
  buzzerGpio: number;
  setRole: (value: number) => void;
  setNodeInfoBroadcastSecs: (value: number) => void;
  setTzdef: (value: string) => void;
  setRebroadcastMode: (value: number) => void;
  setDoubleTapAsButtonPress: (value: boolean) => void;
  setDisableTripleClick: (value: boolean) => void;
  setLedHeartbeatDisabled: (value: boolean) => void;
  setBuzzerMode: (value: number) => void;
  setButtonGpio: (value: number) => void;
  setBuzzerGpio: (value: number) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const DeviceConfigSection: React.FC<DeviceConfigSectionProps> = ({
  role,
  nodeInfoBroadcastSecs,
  tzdef,
  rebroadcastMode,
  doubleTapAsButtonPress,
  disableTripleClick,
  ledHeartbeatDisabled,
  buzzerMode,
  buttonGpio,
  buzzerGpio,
  setRole,
  setNodeInfoBroadcastSecs,
  setTzdef,
  setRebroadcastMode,
  setDoubleTapAsButtonPress,
  setDisableTripleClick,
  setLedHeartbeatDisabled,
  setBuzzerMode,
  setButtonGpio,
  setBuzzerGpio,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [isRoleDropdownOpen, setIsRoleDropdownOpen] = useState(false);
  const [isTimezoneDropdownOpen, setIsTimezoneDropdownOpen] = useState(false);
  const [timezoneFilter, setTimezoneFilter] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleRoleChange = (newRole: number) => {
    if (newRole === 2) {
      const confirmed = window.confirm(t('device_config.router_warning'));

      if (!confirmed) {
        setIsRoleDropdownOpen(false);
        return;
      }
    }

    setRole(newRole);
    setIsRoleDropdownOpen(false);
  };

  // Filter timezone presets based on search
  const filteredTimezones = useMemo(() => {
    if (!timezoneFilter) return TIMEZONE_PRESETS;
    const filter = timezoneFilter.toLowerCase();
    return TIMEZONE_PRESETS.filter(tz =>
      tz.label.toLowerCase().includes(filter) ||
      tz.region.toLowerCase().includes(filter) ||
      tz.value.toLowerCase().includes(filter)
    );
  }, [timezoneFilter]);

  // Group timezones by region
  const groupedTimezones = useMemo(() => {
    const groups: Record<string, typeof TIMEZONE_PRESETS> = {};
    for (const tz of filteredTimezones) {
      if (!groups[tz.region]) {
        groups[tz.region] = [];
      }
      groups[tz.region].push(tz);
    }
    return groups;
  }, [filteredTimezones]);

  // Find current timezone label
  const currentTimezoneLabel = useMemo(() => {
    if (!tzdef) return t('device_config.timezone_not_set');
    const preset = TIMEZONE_PRESETS.find(tz => tz.value === tzdef);
    return preset ? preset.label : tzdef;
  }, [tzdef, t]);

  const handleTimezoneSelect = (value: string) => {
    setTzdef(value);
    setIsTimezoneDropdownOpen(false);
    setTimezoneFilter('');
  };

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('device_config.title')}
        <a
          href="https://meshmonitor.org/features/device#device-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('device_config.view_docs')}
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="role">
          {t('device_config.device_role')}
          <span className="setting-description">
            {t('device_config.device_role_description')}{' '}
            <a
              href="https://meshtastic.org/docs/configuration/radio/device/#roles"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#4CAF50', textDecoration: 'underline' }}
            >
              {t('common.more_info')}
            </a>
          </span>
        </label>
        <div style={{ position: 'relative' }}>
          <div
            onClick={() => setIsRoleDropdownOpen(!isRoleDropdownOpen)}
            className="setting-input config-custom-dropdown"
            style={{
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.75rem',
              minHeight: '80px',
              width: '800px'
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 'bold', fontSize: '1.1em', color: '#fff', marginBottom: '0.5rem' }}>
                {ROLE_OPTIONS.find(opt => opt.value === role)?.name || 'CLIENT'}
              </div>
              <div style={{ fontSize: '0.9em', color: '#ddd', marginBottom: '0.25rem', lineHeight: '1.4' }}>
                {ROLE_OPTIONS.find(opt => opt.value === role)?.shortDesc || ''}
              </div>
              <div style={{ fontSize: '0.85em', color: '#bbb', fontStyle: 'italic', lineHeight: '1.4' }}>
                {ROLE_OPTIONS.find(opt => opt.value === role)?.description || ''}
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
                width: '800px',
                backgroundColor: 'white',
                border: '1px solid #ddd',
                borderRadius: '4px',
                maxHeight: '500px',
                overflowY: 'auto',
                zIndex: 1000,
                boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
              }}
            >
              {ROLE_OPTIONS.map(option => (
                <div
                  key={option.value}
                  onClick={() => handleRoleChange(option.value)}
                  style={{
                    padding: '0.75rem 1rem',
                    cursor: 'pointer',
                    borderBottom: '1px solid #eee',
                    backgroundColor: option.value === role ? '#e3f2fd' : 'white',
                    transition: 'background-color 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    if (option.value !== role) {
                      e.currentTarget.style.backgroundColor = '#f5f5f5';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (option.value !== role) {
                      e.currentTarget.style.backgroundColor = 'white';
                    }
                  }}
                >
                  <div style={{ fontWeight: 'bold', fontSize: '1em', color: '#000', marginBottom: '0.4rem' }}>
                    {option.name}
                  </div>
                  <div style={{ fontSize: '0.9em', color: '#333', marginBottom: '0.3rem', lineHeight: '1.4' }}>
                    {option.shortDesc}
                  </div>
                  <div style={{ fontSize: '0.85em', color: '#555', fontStyle: 'italic', lineHeight: '1.4' }}>
                    {option.description}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="setting-item">
        <label htmlFor="nodeInfoBroadcastSecs">
          {t('device_config.node_info_broadcast')}
          <span className="setting-description">{t('device_config.node_info_broadcast_description')}</span>
        </label>
        <input
          id="nodeInfoBroadcastSecs"
          type="number"
          min="3600"
          max="4294967295"
          value={nodeInfoBroadcastSecs}
          onChange={(e) => setNodeInfoBroadcastSecs(parseInt(e.target.value))}
          className="setting-input"
        />
      </div>

      {/* Timezone Setting */}
      <div className="setting-item">
        <label htmlFor="tzdef">
          {t('device_config.timezone')}
          <span className="setting-description">{t('device_config.timezone_description')}</span>
        </label>
        <div style={{ position: 'relative' }}>
          <div
            onClick={() => setIsTimezoneDropdownOpen(!isTimezoneDropdownOpen)}
            className="setting-input config-custom-dropdown"
            style={{
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.75rem',
              minHeight: '44px',
              width: '400px'
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ color: '#fff' }}>
                {currentTimezoneLabel}
              </div>
              {tzdef && !TIMEZONE_PRESETS.find(tz => tz.value === tzdef) && (
                <div style={{ fontSize: '0.85em', color: '#bbb', marginTop: '0.25rem' }}>
                  {t('device_config.custom_timezone')}
                </div>
              )}
            </div>
            <span style={{ fontSize: '1.2em', marginLeft: '1rem', flexShrink: 0 }}>{isTimezoneDropdownOpen ? '▲' : '▼'}</span>
          </div>
          {isTimezoneDropdownOpen && (
            <div
              className="config-custom-dropdown-menu"
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                width: '400px',
                backgroundColor: 'white',
                border: '1px solid #ddd',
                borderRadius: '4px',
                maxHeight: '400px',
                overflowY: 'auto',
                zIndex: 1000,
                boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
              }}
            >
              {/* Search/custom input */}
              <div style={{
                padding: '0.5rem',
                borderBottom: '1px solid #ddd',
                position: 'sticky',
                top: 0,
                backgroundColor: 'white'
              }}>
                <input
                  type="text"
                  placeholder={t('device_config.timezone_search_placeholder')}
                  value={timezoneFilter}
                  onChange={(e) => setTimezoneFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && timezoneFilter) {
                      handleTimezoneSelect(timezoneFilter);
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    fontSize: '0.9rem'
                  }}
                  autoFocus
                />
                <div style={{
                  fontSize: '0.75rem',
                  color: '#666',
                  marginTop: '0.25rem'
                }}>
                  {t('device_config.timezone_custom_hint')}
                </div>
              </div>

              {/* Clear timezone option */}
              <div
                onClick={() => handleTimezoneSelect('')}
                style={{
                  padding: '0.5rem 1rem',
                  cursor: 'pointer',
                  borderBottom: '1px solid #eee',
                  backgroundColor: !tzdef ? '#e3f2fd' : 'white',
                  color: '#666',
                  fontStyle: 'italic'
                }}
                onMouseEnter={(e) => {
                  if (tzdef) e.currentTarget.style.backgroundColor = '#f5f5f5';
                }}
                onMouseLeave={(e) => {
                  if (tzdef) e.currentTarget.style.backgroundColor = 'white';
                }}
              >
                {t('device_config.timezone_clear')}
              </div>

              {/* Use custom value button */}
              {timezoneFilter && !TIMEZONE_PRESETS.find(tz => tz.value === timezoneFilter) && (
                <div
                  onClick={() => handleTimezoneSelect(timezoneFilter)}
                  style={{
                    padding: '0.5rem 1rem',
                    cursor: 'pointer',
                    borderBottom: '1px solid #eee',
                    backgroundColor: '#e8f5e9',
                    color: '#2e7d32',
                    fontWeight: 'bold'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#c8e6c9';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#e8f5e9';
                  }}
                >
                  {t('device_config.timezone_use_custom')}: {timezoneFilter}
                </div>
              )}

              {/* Grouped timezone options */}
              {Object.entries(groupedTimezones).map(([region, timezones]) => (
                <div key={region}>
                  <div style={{
                    padding: '0.5rem 1rem',
                    backgroundColor: '#f5f5f5',
                    fontWeight: 'bold',
                    fontSize: '0.85rem',
                    color: '#666',
                    borderBottom: '1px solid #ddd'
                  }}>
                    {region}
                  </div>
                  {timezones.map(tz => (
                    <div
                      key={tz.value}
                      onClick={() => handleTimezoneSelect(tz.value)}
                      style={{
                        padding: '0.5rem 1rem 0.5rem 1.5rem',
                        cursor: 'pointer',
                        borderBottom: '1px solid #eee',
                        backgroundColor: tz.value === tzdef ? '#e3f2fd' : 'white',
                        transition: 'background-color 0.2s'
                      }}
                      onMouseEnter={(e) => {
                        if (tz.value !== tzdef) {
                          e.currentTarget.style.backgroundColor = '#f5f5f5';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (tz.value !== tzdef) {
                          e.currentTarget.style.backgroundColor = 'white';
                        }
                      }}
                    >
                      <div style={{ color: '#000' }}>{tz.label}</div>
                      <div style={{ fontSize: '0.75rem', color: '#666', fontFamily: 'monospace' }}>
                        {tz.value}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Rebroadcast Mode */}
      <div className="setting-item">
        <label htmlFor="rebroadcastMode">
          {t('device_config.rebroadcast_mode')}
          <span className="setting-description">{t('device_config.rebroadcast_mode_description')}</span>
        </label>
        <select
          id="rebroadcastMode"
          value={rebroadcastMode}
          onChange={(e) => setRebroadcastMode(parseInt(e.target.value))}
          className="setting-input"
        >
          {REBROADCAST_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.name} - {option.description}
            </option>
          ))}
        </select>
      </div>

      {/* Buzzer Mode */}
      <div className="setting-item">
        <label htmlFor="buzzerMode">
          {t('device_config.buzzer_mode')}
          <span className="setting-description">{t('device_config.buzzer_mode_description')}</span>
        </label>
        <select
          id="buzzerMode"
          value={buzzerMode}
          onChange={(e) => setBuzzerMode(parseInt(e.target.value))}
          className="setting-input"
        >
          {BUZZER_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.name} - {option.description}
            </option>
          ))}
        </select>
      </div>

      {/* Double Tap as Button Press */}
      <div className="setting-item">
        <label htmlFor="doubleTapAsButtonPress" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="doubleTapAsButtonPress"
            type="checkbox"
            checked={doubleTapAsButtonPress}
            onChange={(e) => setDoubleTapAsButtonPress(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('device_config.double_tap_as_button')}</div>
            <span className="setting-description">{t('device_config.double_tap_as_button_description')}</span>
          </div>
        </label>
      </div>

      {/* Disable Triple Click */}
      <div className="setting-item">
        <label htmlFor="disableTripleClick" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="disableTripleClick"
            type="checkbox"
            checked={disableTripleClick}
            onChange={(e) => setDisableTripleClick(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('device_config.disable_triple_click')}</div>
            <span className="setting-description">{t('device_config.disable_triple_click_description')}</span>
          </div>
        </label>
      </div>

      {/* LED Heartbeat Disabled */}
      <div className="setting-item">
        <label htmlFor="ledHeartbeatDisabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="ledHeartbeatDisabled"
            type="checkbox"
            checked={ledHeartbeatDisabled}
            onChange={(e) => setLedHeartbeatDisabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('device_config.led_heartbeat_disabled')}</div>
            <span className="setting-description">{t('device_config.led_heartbeat_disabled_description')}</span>
          </div>
        </label>
      </div>

      {/* Advanced Section Toggle */}
      <div className="setting-item">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="advanced-toggle-btn"
          style={{
            background: 'transparent',
            border: '1px solid var(--ctp-surface2)',
            color: 'var(--ctp-subtext0)',
            padding: '0.5rem 1rem',
            borderRadius: '4px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}
        >
          <span>{showAdvanced ? '▼' : '▶'}</span>
          {t('device_config.advanced_settings')}
        </button>
      </div>

      {/* Advanced Settings */}
      {showAdvanced && (
        <div className="advanced-section" style={{
          marginLeft: '1rem',
          paddingLeft: '1rem',
          borderLeft: '2px solid var(--ctp-surface2)'
        }}>
          {/* Button GPIO */}
          <div className="setting-item">
            <label htmlFor="buttonGpio">
              {t('device_config.button_gpio')}
              <span className="setting-description">{t('device_config.button_gpio_description')}</span>
            </label>
            <input
              id="buttonGpio"
              type="number"
              min="0"
              max="255"
              value={buttonGpio}
              onChange={(e) => setButtonGpio(parseInt(e.target.value) || 0)}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>

          {/* Buzzer GPIO */}
          <div className="setting-item">
            <label htmlFor="buzzerGpio">
              {t('device_config.buzzer_gpio')}
              <span className="setting-description">{t('device_config.buzzer_gpio_description')}</span>
            </label>
            <input
              id="buzzerGpio"
              type="number"
              min="0"
              max="255"
              value={buzzerGpio}
              onChange={(e) => setBuzzerGpio(parseInt(e.target.value) || 0)}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>
        </div>
      )}

      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('device_config.save_button')}
      </button>
    </div>
  );
};

export default DeviceConfigSection;
