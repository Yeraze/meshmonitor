import React from 'react';
import { useUI } from '../contexts/UIContext';
import { useData } from '../contexts/DataContext';
import './NodeFilterPopup.css';

interface NodeFilterPopupProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NodeFilterPopup: React.FC<NodeFilterPopupProps> = ({ isOpen, onClose }) => {
  const { securityFilter, setSecurityFilter, channelFilter, setChannelFilter } = useUI();
  const { channels } = useData();

  if (!isOpen) return null;

  // Get unique channel numbers from available channels
  const availableChannels = channels.map(ch => ch.id).sort((a, b) => a - b);

  return (
    <div className="node-filter-popup-overlay" onClick={onClose}>
      <div className="node-filter-popup" onClick={(e) => e.stopPropagation()}>
        <div className="node-filter-popup-header">
          <h3>Filter Nodes</h3>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="node-filter-popup-content">
          {/* Security Filter */}
          <div className="filter-section">
            <label>Security Status</label>
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
            <label>Channel</label>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
              className="filter-dropdown"
            >
              <option value="all">All Channels</option>
              {availableChannels.map(channelId => {
                const channel = channels.find(ch => ch.id === channelId);
                return (
                  <option key={channelId} value={channelId}>
                    Channel {channelId}{channel?.name ? ` (${channel.name})` : ''}
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        <div className="node-filter-popup-footer">
          <button
            className="reset-btn"
            onClick={() => {
              setSecurityFilter('all');
              setChannelFilter('all');
            }}
          >
            Reset Filters
          </button>
          <button className="apply-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
