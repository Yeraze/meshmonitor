import React from 'react';

interface MQTTConfigSectionProps {
  mqttEnabled: boolean;
  mqttAddress: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttEncryptionEnabled: boolean;
  mqttJsonEnabled: boolean;
  mqttRoot: string;
  setMqttEnabled: (value: boolean) => void;
  setMqttAddress: (value: string) => void;
  setMqttUsername: (value: string) => void;
  setMqttPassword: (value: string) => void;
  setMqttEncryptionEnabled: (value: boolean) => void;
  setMqttJsonEnabled: (value: boolean) => void;
  setMqttRoot: (value: string) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const MQTTConfigSection: React.FC<MQTTConfigSectionProps> = ({
  mqttEnabled,
  mqttAddress,
  mqttUsername,
  mqttPassword,
  mqttEncryptionEnabled,
  mqttJsonEnabled,
  mqttRoot,
  setMqttEnabled,
  setMqttAddress,
  setMqttUsername,
  setMqttPassword,
  setMqttEncryptionEnabled,
  setMqttJsonEnabled,
  setMqttRoot,
  isSaving,
  onSave
}) => {
  return (
    <div className="settings-section">
      <h3>MQTT Module</h3>
      <div className="setting-item">
        <label htmlFor="mqttEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="mqttEnabled"
            type="checkbox"
            checked={mqttEnabled}
            onChange={(e) => setMqttEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>Enable MQTT</div>
            <span className="setting-description">Enable MQTT uplink/downlink gateway</span>
          </div>
        </label>
      </div>
      {mqttEnabled && (
        <>
          <div className="setting-item">
            <label htmlFor="mqttAddress">
              MQTT Server Address
              <span className="setting-description">Leave empty for default server (mqtt.meshtastic.org)</span>
            </label>
            <input
              id="mqttAddress"
              type="text"
              value={mqttAddress}
              onChange={(e) => setMqttAddress(e.target.value)}
              className="setting-input"
              placeholder="mqtt.meshtastic.org"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttUsername">
              MQTT Username
              <span className="setting-description">Username for MQTT authentication (optional)</span>
            </label>
            <input
              id="mqttUsername"
              type="text"
              value={mqttUsername}
              onChange={(e) => setMqttUsername(e.target.value)}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttPassword">
              MQTT Password
              <span className="setting-description">Password for MQTT authentication (optional)</span>
            </label>
            <input
              id="mqttPassword"
              type="password"
              value={mqttPassword}
              onChange={(e) => setMqttPassword(e.target.value)}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttRoot">
              MQTT Root Topic
              <span className="setting-description">Root topic for MQTT messages (e.g., "msh/US/MyRegion")</span>
            </label>
            <input
              id="mqttRoot"
              type="text"
              value={mqttRoot}
              onChange={(e) => setMqttRoot(e.target.value)}
              className="setting-input"
              placeholder="msh/US"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttEncryption" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="mqttEncryption"
                type="checkbox"
                checked={mqttEncryptionEnabled}
                onChange={(e) => setMqttEncryptionEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>Encryption Enabled</div>
                <span className="setting-description">Send encrypted packets to MQTT</span>
              </div>
            </label>
          </div>
          <div className="setting-item">
            <label htmlFor="mqttJson" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="mqttJson"
                type="checkbox"
                checked={mqttJsonEnabled}
                onChange={(e) => setMqttJsonEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>JSON Enabled</div>
                <span className="setting-description">Send/receive JSON packets on MQTT</span>
              </div>
            </label>
          </div>
        </>
      )}
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? 'Saving...' : 'Save MQTT Config'}
      </button>
    </div>
  );
};

export default MQTTConfigSection;
