import React, { useEffect } from 'react';
import { useUI } from '../contexts/UIContext';
import { useData } from '../contexts/DataContext';

// Meshtastic default PSK (base64 encoded single byte 0x01 = default/unencrypted)
const DEFAULT_UNENCRYPTED_PSK = 'AQ==';

interface NodeFilterPopupProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NodeFilterPopup: React.FC<NodeFilterPopupProps> = ({ isOpen, onClose }) => {
  const {
    securityFilter,
    setSecurityFilter,
    channelFilter,
    setChannelFilter,
    showIncompleteNodes,
    setShowIncompleteNodes,
  } = useUI();
  const { channels } = useData();

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
          <h4>Filter Nodes</h4>
          <button className="filter-popup-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="filter-popup-content">
          {/* Security Filter */}
          <div className="filter-section">
            <span className="filter-section-title">Security Status</span>
            <select
              value={securityFilter}
              onChange={(e) => setSecurityFilter(e.target.value as 'all' | 'flaggedOnly' | 'hideFlagged')}
              className="filter-dropdown"
            >
              <option value="all">All Nodes</option>
              <option value="flaggedOnly">Flagged Only</option>
              <option value="hideFlagged">Hide Flagged</option>
            </select>
          </div>

          {/* Channel Filter */}
          <div className="filter-section">
            <span className="filter-section-title">Channel</span>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
              className="filter-dropdown"
            >
              <option value="all">All Channels</option>
              {availableChannels.map(channelId => {
                const channel = channels.find(ch => ch.id === channelId);
                const isSecure = isSecureChannel(channelId);
                return (
                  <option key={channelId} value={channelId}>
                    Channel {channelId}{channel?.name ? ` (${channel.name})` : ''}{isSecure ? ' 🔒' : ''}
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
              <span>Hide incomplete nodes</span>
            </label>
            <div className="filter-help-text">
              Incomplete nodes are missing name or hardware info.
              {selectedChannelIsSecure && (
                <span className="filter-warning">
                  {' '}Recommended for secure channels.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
