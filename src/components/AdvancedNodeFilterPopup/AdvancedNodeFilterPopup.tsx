import React from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeFilters, SecurityFilter } from '../../types/ui';
import type { Channel } from '../../types/device';
import { ROLE_NAMES } from '../../constants';
import './AdvancedNodeFilterPopup.css';

interface AdvancedNodeFilterPopupProps {
  isOpen: boolean;
  nodeFilters: NodeFilters;
  securityFilter: SecurityFilter;
  channels: Channel[];
  onNodeFiltersChange: (filters: NodeFilters) => void;
  onSecurityFilterChange: (filter: SecurityFilter) => void;
  onClose: () => void;
}

const DEFAULT_FILTERS: NodeFilters = {
  filterMode: 'show',
  showMqtt: false,
  showTelemetry: false,
  showEnvironment: false,
  powerSource: 'both',
  showPosition: false,
  minHops: 0,
  maxHops: 10,
  showPKI: false,
  showRemoteAdmin: false,
  showUnknown: false,
  showIgnored: false,
  deviceRoles: [],
  channels: [],
};

export const AdvancedNodeFilterPopup: React.FC<AdvancedNodeFilterPopupProps> = ({
  isOpen,
  nodeFilters,
  securityFilter,
  channels,
  onNodeFiltersChange,
  onSecurityFilterChange,
  onClose,
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  const handleReset = () => {
    onNodeFiltersChange(DEFAULT_FILTERS);
  };

  const handleRoleChange = (roleNum: number, checked: boolean) => {
    const allRoles = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    if (checked) {
      // If all were selected (empty array), keep it empty (already showing all)
      if (nodeFilters.deviceRoles.length === 0) {
        return;
      } else {
        // Add this role to the array
        const newRoles = [...nodeFilters.deviceRoles, roleNum];
        // If all are now selected, set to empty array (show all)
        if (newRoles.length === 13) {
          onNodeFiltersChange({ ...nodeFilters, deviceRoles: [] });
        } else {
          onNodeFiltersChange({ ...nodeFilters, deviceRoles: newRoles });
        }
      }
    } else {
      // Unchecking a role
      if (nodeFilters.deviceRoles.length === 0) {
        // All were selected (empty array), now exclude this one
        const newRoles = allRoles.filter((r: number) => r !== roleNum);
        onNodeFiltersChange({ ...nodeFilters, deviceRoles: newRoles });
      } else {
        // Remove this role from the array
        const newRoles = nodeFilters.deviceRoles.filter((r: number) => r !== roleNum);
        onNodeFiltersChange({ ...nodeFilters, deviceRoles: newRoles });
      }
    }
  };

  const handleChannelChange = (channelId: number, checked: boolean) => {
    const allChannels = (channels || []).map(c => c.id);

    if (checked) {
      if (nodeFilters.channels.length === 0) {
        return;
      } else {
        const newChannels = [...nodeFilters.channels, channelId];
        if (newChannels.length === (channels || []).length) {
          onNodeFiltersChange({ ...nodeFilters, channels: [] });
        } else {
          onNodeFiltersChange({ ...nodeFilters, channels: newChannels });
        }
      }
    } else {
      if (nodeFilters.channels.length === 0) {
        const newChannels = allChannels.filter((c: number) => c !== channelId);
        onNodeFiltersChange({ ...nodeFilters, channels: newChannels });
      } else {
        const newChannels = nodeFilters.channels.filter((c: number) => c !== channelId);
        onNodeFiltersChange({ ...nodeFilters, channels: newChannels });
      }
    }
  };

  return (
    <div className="filter-popup-overlay" onClick={onClose}>
      <div className="filter-popup" onClick={e => e.stopPropagation()}>
        <div className="filter-popup-header">
          <h4>{t('node_filter.title', 'Filter Nodes')}</h4>
          <button className="filter-popup-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="filter-popup-content">
          <div className="filter-section">
            <div className="filter-section-title">{t('node_filter.filter_mode', 'Filter Mode')}</div>
            <div className="filter-toggle-group">
              <button
                className={`filter-toggle-btn ${nodeFilters.filterMode === 'show' ? 'active' : ''}`}
                onClick={() => onNodeFiltersChange({ ...nodeFilters, filterMode: 'show' })}
              >
                {t('node_filter.show_only', 'Show only')}
              </button>
              <button
                className={`filter-toggle-btn ${nodeFilters.filterMode === 'hide' ? 'active' : ''}`}
                onClick={() => onNodeFiltersChange({ ...nodeFilters, filterMode: 'hide' })}
              >
                {t('node_filter.hide_matching', 'Hide matching')}
              </button>
            </div>
            <div className="filter-mode-description">
              {nodeFilters.filterMode === 'show'
                ? t('node_filter.show_description', 'Show only nodes that match all selected filters')
                : t('node_filter.hide_description', 'Hide nodes that match any selected filters')}
            </div>
          </div>

          <div className="filter-section">
            <div className="filter-section-title">
              <span className="filter-icon-wrapper">
                <span className="filter-icon">⚠️</span>
              </span>
              <span>{t('node_filter.security', 'Security')}</span>
            </div>
            <div className="filter-radio-group">
              <label className="filter-radio">
                <input
                  type="radio"
                  name="securityFilter"
                  value="all"
                  checked={securityFilter === 'all'}
                  onChange={e => onSecurityFilterChange(e.target.value as SecurityFilter)}
                />
                <span>{t('node_filter.all_nodes', 'All Nodes')}</span>
              </label>
              <label className="filter-radio">
                <input
                  type="radio"
                  name="securityFilter"
                  value="flaggedOnly"
                  checked={securityFilter === 'flaggedOnly'}
                  onChange={e => onSecurityFilterChange(e.target.value as SecurityFilter)}
                />
                <span>⚠️ {t('node_filter.flagged_only', 'Flagged Only')}</span>
              </label>
              <label className="filter-radio">
                <input
                  type="radio"
                  name="securityFilter"
                  value="hideFlagged"
                  checked={securityFilter === 'hideFlagged'}
                  onChange={e => onSecurityFilterChange(e.target.value as SecurityFilter)}
                />
                <span>{t('node_filter.hide_flagged', 'Hide Flagged')}</span>
              </label>
            </div>
          </div>

          <div className="filter-section">
            <div className="filter-section-title">{t('node_filter.node_features', 'Node Features')}</div>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={nodeFilters.showTelemetry}
                onChange={e => onNodeFiltersChange({ ...nodeFilters, showTelemetry: e.target.checked })}
              />
              <span className="filter-label-with-icon">
                <span className="filter-icon">📊</span>
                <span>{t('node_filter.telemetry', 'Telemetry data')}</span>
              </span>
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={nodeFilters.showEnvironment}
                onChange={e => onNodeFiltersChange({ ...nodeFilters, showEnvironment: e.target.checked })}
              />
              <span className="filter-label-with-icon">
                <span className="filter-icon">☀️</span>
                <span>{t('node_filter.environment', 'Environment metrics')}</span>
              </span>
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={nodeFilters.showPosition}
                onChange={e => onNodeFiltersChange({ ...nodeFilters, showPosition: e.target.checked })}
              />
              <span className="filter-label-with-icon">
                <span className="filter-icon">📍</span>
                <span>{t('node_filter.position', 'Position data')}</span>
              </span>
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={nodeFilters.showPKI}
                onChange={e => onNodeFiltersChange({ ...nodeFilters, showPKI: e.target.checked })}
              />
              <span className="filter-label-with-icon">
                <span className="filter-icon">🔐</span>
                <span>{t('node_filter.pkc', 'Public Key Crypto')}</span>
              </span>
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={nodeFilters.showRemoteAdmin}
                onChange={e => onNodeFiltersChange({ ...nodeFilters, showRemoteAdmin: e.target.checked })}
              />
              <span className="filter-label-with-icon">
                <span className="filter-icon">🛠️</span>
                <span>{t('node_filter.remote_admin', 'Remote Admin')}</span>
              </span>
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={nodeFilters.showMqtt}
                onChange={e => onNodeFiltersChange({ ...nodeFilters, showMqtt: e.target.checked })}
              />
              <span className="filter-label-with-icon">
                <span className="filter-icon">🌐</span>
                <span>{t('node_filter.mqtt', 'MQTT nodes')}</span>
              </span>
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={nodeFilters.showUnknown}
                onChange={e => onNodeFiltersChange({ ...nodeFilters, showUnknown: e.target.checked })}
              />
              <span className="filter-label-with-icon">
                <span className="filter-icon">❓</span>
                <span>{t('node_filter.unknown', 'Unknown nodes')}</span>
              </span>
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={nodeFilters.showIgnored}
                onChange={e => onNodeFiltersChange({ ...nodeFilters, showIgnored: e.target.checked })}
              />
              <span className="filter-label-with-icon">
                <span className="filter-icon">🚫</span>
                <span>{t('node_filter.ignored', 'Show ignored nodes')}</span>
              </span>
            </label>
          </div>

          <div className="filter-section">
            <div className="filter-section-title">
              <span className="filter-icon-wrapper">
                <span className="filter-icon">🔋</span>
              </span>
              <span>{t('node_filter.power_source', 'Power Source')}</span>
            </div>
            <div className="filter-radio-group">
              <label className="filter-radio">
                <input
                  type="radio"
                  name="powerSource"
                  value="both"
                  checked={nodeFilters.powerSource === 'both'}
                  onChange={e => onNodeFiltersChange({ ...nodeFilters, powerSource: e.target.value as 'both' })}
                />
                <span>{t('node_filter.both', 'Both')}</span>
              </label>
              <label className="filter-radio">
                <input
                  type="radio"
                  name="powerSource"
                  value="powered"
                  checked={nodeFilters.powerSource === 'powered'}
                  onChange={e => onNodeFiltersChange({ ...nodeFilters, powerSource: e.target.value as 'powered' })}
                />
                <span>🔌 {t('node_filter.powered_only', 'Powered only')}</span>
              </label>
              <label className="filter-radio">
                <input
                  type="radio"
                  name="powerSource"
                  value="battery"
                  checked={nodeFilters.powerSource === 'battery'}
                  onChange={e => onNodeFiltersChange({ ...nodeFilters, powerSource: e.target.value as 'battery' })}
                />
                <span>🔋 {t('node_filter.battery_only', 'Battery only')}</span>
              </label>
            </div>
          </div>

          <div className="filter-section">
            <div className="filter-section-title">
              <span className="filter-icon-wrapper">
                <span className="filter-icon">🔗</span>
              </span>
              <span>{t('node_filter.hops_away', 'Hops Away')}</span>
            </div>
            <div className="filter-range-group">
              <div className="filter-range-input">
                <label>{t('node_filter.min', 'Min')}:</label>
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={nodeFilters.minHops}
                  onChange={e => onNodeFiltersChange({ ...nodeFilters, minHops: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div className="filter-range-input">
                <label>{t('node_filter.max', 'Max')}:</label>
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={nodeFilters.maxHops}
                  onChange={e => {
                    const val = parseInt(e.target.value);
                    onNodeFiltersChange({ ...nodeFilters, maxHops: isNaN(val) ? 10 : val });
                  }}
                />
              </div>
            </div>
          </div>

          <div className="filter-section">
            <div className="filter-section-title">
              <span className="filter-icon-wrapper">
                <span className="filter-icon">👤</span>
              </span>
              <span>{t('node_filter.device_role', 'Device Role')}</span>
            </div>
            <div className="filter-role-group">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(roleNum => (
                <label key={roleNum} className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={nodeFilters.deviceRoles.length === 0 || nodeFilters.deviceRoles.includes(roleNum)}
                    onChange={e => handleRoleChange(roleNum, e.target.checked)}
                  />
                  <span>{ROLE_NAMES[roleNum]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="filter-section">
            <div className="filter-section-title">
              <span className="filter-icon-wrapper">
                <span className="filter-icon">📡</span>
              </span>
              <span>{t('node_filter.channel', 'Channel')}</span>
            </div>
            <div className="filter-role-group">
              {(channels || []).map(ch => (
                <label key={ch.id} className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={nodeFilters.channels.length === 0 || nodeFilters.channels.includes(ch.id)}
                    onChange={e => handleChannelChange(ch.id, e.target.checked)}
                  />
                  <span>
                    {t('node_filter.channel_number', 'Channel {{number}}', { number: ch.id })}
                    {ch.name ? ` (${ch.name})` : ''}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="filter-popup-actions">
          <button className="filter-reset-btn" onClick={handleReset}>
            {t('node_filter.reset_all', 'Reset All')}
          </button>
          <button className="filter-apply-btn" onClick={onClose}>
            {t('node_filter.apply', 'Apply')}
          </button>
        </div>
      </div>
    </div>
  );
};
