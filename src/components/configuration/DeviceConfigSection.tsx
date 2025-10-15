import React, { useState } from 'react';
import { ROLE_OPTIONS } from './constants';

interface DeviceConfigSectionProps {
  role: number;
  nodeInfoBroadcastSecs: number;
  setRole: (value: number) => void;
  setNodeInfoBroadcastSecs: (value: number) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const DeviceConfigSection: React.FC<DeviceConfigSectionProps> = ({
  role,
  nodeInfoBroadcastSecs,
  setRole,
  setNodeInfoBroadcastSecs,
  isSaving,
  onSave
}) => {
  const [isRoleDropdownOpen, setIsRoleDropdownOpen] = useState(false);

  const handleRoleChange = (newRole: number) => {
    if (newRole === 2) {
      const confirmed = window.confirm(
        'Are you sure?\n\n' +
        'Setting the device role to ROUTER is generally not recommended for most users. ' +
        'ROUTER mode will cause your device to relay all packets, significantly increasing power consumption ' +
        'and airtime usage.\n\n' +
        'Click OK to confirm this change, or Cancel to keep your current setting.'
      );

      if (!confirmed) {
        setIsRoleDropdownOpen(false);
        return;
      }
    }

    setRole(newRole);
    setIsRoleDropdownOpen(false);
  };

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        Device Configuration
        <a
          href="https://meshmonitor.org/features/device#device-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title="View Device Configuration Documentation"
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="role">
          Device Role
          <span className="setting-description">
            Defines how your node behaves on the mesh network.{' '}
            <a
              href="https://meshtastic.org/docs/configuration/radio/device/#roles"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#4CAF50', textDecoration: 'underline' }}
            >
              For more information
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
          Node Info Broadcast Interval (seconds)
          <span className="setting-description">How often to broadcast node info. Range: 3600-4294967295 (default: 10800 = 3 hours, minimum: 3600 = 1 hour)</span>
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
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? 'Saving...' : 'Save Device Config'}
      </button>
    </div>
  );
};

export default DeviceConfigSection;
