import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useUI } from '../contexts/UIContext';
import { useChannels } from '../hooks/useServerData';

// Meshtastic default PSK (base64 encoded single byte 0x01 = default/unencrypted)
const DEFAULT_UNENCRYPTED_PSK = 'AQ==';

interface NodeFilterPopupProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NodeFilterPopup: React.FC<NodeFilterPopupProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const {
    securityFilter,
    setSecurityFilter,
    channelFilter,
    setChannelFilter,
    showIncompleteNodes,
    setShowIncompleteNodes,
    showIgnoredNodes,
    setShowIgnoredNodes,
    filterRemoteAdminOnly,
    setFilterRemoteAdminOnly,
  } = useUI();
  const { channels } = useChannels();

  // Get unique channel numbers from available channels
  const availableChannels = (channels || []).map(ch => ch.id).sort((a, b) => a - b);

  // Check if the selected channel has a custom PSK (is secure/encrypted)
  const isSecureChannel = (channelId: number | 'all'): boolean => {
    if (channelId === 'all') return false;
    const channel = channels.find(ch => ch.id === channelId);
    // A channel is secure if it has a PSK that's not the default unencrypted one
    return !!(channel?.psk && channel.psk !== DEFAULT_UNENCRYPTED_PSK);
  };

  // Auto-hide incomplete nodes when switching to a secure channel
  useEffect(() => {
    if (channelFilter !== 'all' && isSecureChannel(channelFilter)) {
      // Automatically hide incomplete nodes on secure channels
      setShowIncompleteNodes(false);
    }
  }, [channelFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  const selectedChannelIsSecure = isSecureChannel(channelFilter);

  return (
    <div className="filter-popup-overlay" onClick={onClose}>
      <div className="filter-popup" onClick={(e) => e.stopPropagation()}>
        <div className="filter-popup-header">
          <h4>{t('node_filter.title')}</h4>
          <button className="filter-popup-close" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>

        <div className="filter-popup-content">
          {/* Security Filter */}
          <div className="filter-section">
            <span className="filter-section-title">{t('node_filter.security_status')}</span>
            <select
              value={securityFilter}
              onChange={(e) => setSecurityFilter(e.target.value as 'all' | 'flaggedOnly' | 'hideFlagged')}
              className="filter-dropdown"
            >
              <option value="all">{t('node_filter.all_nodes')}</option>
              <option value="flaggedOnly">{t('node_filter.flagged_only')}</option>
              <option value="hideFlagged">{t('node_filter.hide_flagged')}</option>
            </select>
          </div>

          {/* Channel Filter */}
          <div className="filter-section">
            <span className="filter-section-title">{t('node_filter.channel')}</span>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
              className="filter-dropdown"
            >
              <option value="all">{t('node_filter.all_channels')}</option>
              {availableChannels.map(channelId => {
                const channel = channels.find(ch => ch.id === channelId);
                const isSecure = isSecureChannel(channelId);
                return (
                  <option key={channelId} value={channelId}>
                    {t('node_filter.channel_number', { number: channelId })}{channel?.name ? ` (${channel.name})` : ''}{isSecure ? ' 🔒' : ''}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Incomplete Nodes Filter */}
          <div className="filter-section">
            <label className="filter-checkbox-label">
              <input
                type="checkbox"
                checked={!showIncompleteNodes}
                onChange={(e) => setShowIncompleteNodes(!e.target.checked)}
              />
              <span>{t('node_filter.hide_incomplete')}</span>
            </label>
            <div className="filter-help-text">
              {t('node_filter.incomplete_help')}
              {selectedChannelIsSecure && (
                <span className="filter-warning">
                  {' '}{t('node_filter.secure_channel_warning')}
                </span>
              )}
            </div>
          </div>

          {/* Ignored Nodes Filter */}
          <div className="filter-section">
            <label className="filter-checkbox-label">
              <input
                type="checkbox"
                checked={!showIgnoredNodes}
                onChange={(e) => setShowIgnoredNodes(!e.target.checked)}
              />
              <span>{t('node_filter.hide_ignored')}</span>
            </label>
            <div className="filter-help-text">
              {t('node_filter.ignored_help')}
            </div>
          </div>

          {/* Remote Admin Filter */}
          <div className="filter-section">
            <label className="filter-checkbox-label">
              <input
                type="checkbox"
                checked={filterRemoteAdminOnly}
                onChange={(e) => setFilterRemoteAdminOnly(e.target.checked)}
              />
              <span>{t('node_filter.remote_admin_only')}</span>
            </label>
            <div className="filter-help-text">
              {t('node_filter.remote_admin_help')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
