import React from 'react';

interface NodeIdentitySectionProps {
  longName: string;
  shortName: string;
  setLongName: (value: string) => void;
  setShortName: (value: string) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const NodeIdentitySection: React.FC<NodeIdentitySectionProps> = ({
  longName,
  shortName,
  setLongName,
  setShortName,
  isSaving,
  onSave
}) => {
  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        Node Identity
        <a
          href="https://meshmonitor.org/features/device#node-identity"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title="View Node Identity Documentation"
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="longName">
          Long Name
          <span className="setting-description">Full name for your node (up to 40 characters)</span>
        </label>
        <input
          id="longName"
          type="text"
          maxLength={40}
          value={longName}
          onChange={(e) => setLongName(e.target.value)}
          className="setting-input"
          placeholder="My Meshtastic Node"
        />
      </div>
      <div className="setting-item">
        <label htmlFor="shortName">
          Short Name
          <span className="setting-description">Short identifier (up to 4 characters)</span>
        </label>
        <input
          id="shortName"
          type="text"
          maxLength={4}
          value={shortName}
          onChange={(e) => setShortName(e.target.value)}
          className="setting-input"
          placeholder="MESH"
        />
      </div>
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving || !longName || !shortName}
      >
        {isSaving ? 'Saving...' : 'Save Node Names'}
      </button>
    </div>
  );
};

export default NodeIdentitySection;
