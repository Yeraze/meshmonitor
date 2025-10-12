import React from 'react';

interface PositionConfigSectionProps {
  positionBroadcastSecs: number;
  positionSmartEnabled: boolean;
  fixedPosition: boolean;
  fixedLatitude: number;
  fixedLongitude: number;
  fixedAltitude: number;
  setPositionBroadcastSecs: (value: number) => void;
  setPositionSmartEnabled: (value: boolean) => void;
  setFixedPosition: (value: boolean) => void;
  setFixedLatitude: (value: number) => void;
  setFixedLongitude: (value: number) => void;
  setFixedAltitude: (value: number) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const PositionConfigSection: React.FC<PositionConfigSectionProps> = ({
  positionBroadcastSecs,
  positionSmartEnabled,
  fixedPosition,
  fixedLatitude,
  fixedLongitude,
  fixedAltitude,
  setPositionBroadcastSecs,
  setPositionSmartEnabled,
  setFixedPosition,
  setFixedLatitude,
  setFixedLongitude,
  setFixedAltitude,
  isSaving,
  onSave
}) => {
  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        Position Broadcast
        <a
          href="https://meshmonitor.org/features/device#position-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title="View Position Configuration Documentation"
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="positionBroadcastSecs">
          Position Broadcast Interval (seconds)
          <span className="setting-description">How often to broadcast position. Range: 32-4294967295 (default: 900 = 15 minutes, minimum: 32 seconds)</span>
        </label>
        <input
          id="positionBroadcastSecs"
          type="number"
          min="32"
          max="4294967295"
          value={positionBroadcastSecs}
          onChange={(e) => setPositionBroadcastSecs(parseInt(e.target.value))}
          className="setting-input"
        />
      </div>
      <div className="setting-item">
        <label htmlFor="positionSmartEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="positionSmartEnabled"
            type="checkbox"
            checked={positionSmartEnabled}
            onChange={(e) => setPositionSmartEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>Smart Position Broadcast</div>
            <span className="setting-description">Only broadcast when position has changed significantly</span>
          </div>
        </label>
      </div>
      <div className="setting-item">
        <label htmlFor="fixedPosition" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="fixedPosition"
            type="checkbox"
            checked={fixedPosition}
            onChange={(e) => setFixedPosition(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>Fixed Position</div>
            <span className="setting-description">Node is at a fixed position (disables GPS updates)</span>
          </div>
        </label>
      </div>
      {fixedPosition && (
        <>
          <div className="setting-item">
            <label htmlFor="fixedLatitude">
              Latitude
              <span className="setting-description">
                Range: -90 to 90 (decimal degrees) • <a href="https://gps-coordinates.org/" target="_blank" rel="noopener noreferrer" style={{ color: '#4a9eff', textDecoration: 'underline' }}>Find your GPS coordinates here</a>
              </span>
            </label>
            <input
              id="fixedLatitude"
              type="number"
              step="0.000001"
              min="-90"
              max="90"
              value={fixedLatitude}
              onChange={(e) => setFixedLatitude(parseFloat(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="fixedLongitude">
              Longitude
              <span className="setting-description">Range: -180 to 180 (decimal degrees)</span>
            </label>
            <input
              id="fixedLongitude"
              type="number"
              step="0.000001"
              min="-180"
              max="180"
              value={fixedLongitude}
              onChange={(e) => setFixedLongitude(parseFloat(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="fixedAltitude">
              Altitude (meters)
              <span className="setting-description">Elevation above sea level in meters</span>
            </label>
            <input
              id="fixedAltitude"
              type="number"
              step="1"
              value={fixedAltitude}
              onChange={(e) => setFixedAltitude(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
        </>
      )}
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? 'Saving...' : 'Save Position Config'}
      </button>
    </div>
  );
};

export default PositionConfigSection;
