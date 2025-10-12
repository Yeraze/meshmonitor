import React from 'react';

interface NeighborInfoSectionProps {
  neighborInfoEnabled: boolean;
  neighborInfoInterval: number;
  setNeighborInfoEnabled: (value: boolean) => void;
  setNeighborInfoInterval: (value: number) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const NeighborInfoSection: React.FC<NeighborInfoSectionProps> = ({
  neighborInfoEnabled,
  neighborInfoInterval,
  setNeighborInfoEnabled,
  setNeighborInfoInterval,
  isSaving,
  onSave
}) => {
  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        Neighbor Info Module
        <a
          href="https://meshmonitor.org/features/device#neighbor-info"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title="View Neighbor Info Documentation"
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="neighborInfoEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="neighborInfoEnabled"
            type="checkbox"
            checked={neighborInfoEnabled}
            onChange={(e) => setNeighborInfoEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>Enable Neighbor Info</div>
            <span className="setting-description">Broadcast neighbor information to the mesh</span>
          </div>
        </label>
      </div>
      {neighborInfoEnabled && (
        <div className="setting-item">
          <label htmlFor="neighborInfoInterval">
            Update Interval (seconds)
            <span className="setting-description">How often to send neighbor info (minimum: 14400 = 4 hours)</span>
          </label>
          <input
            id="neighborInfoInterval"
            type="number"
            min="14400"
            max="86400"
            value={neighborInfoInterval}
            onChange={(e) => setNeighborInfoInterval(parseInt(e.target.value))}
            className="setting-input"
          />
        </div>
      )}
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? 'Saving...' : 'Save NeighborInfo Config'}
      </button>
    </div>
  );
};

export default NeighborInfoSection;
