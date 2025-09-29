import React from 'react';
import { TemperatureUnit } from '../utils/temperature';
import { version } from '../../package.json';
import apiService from '../services/api';

interface SettingsTabProps {
  maxNodeAgeHours: number;
  tracerouteIntervalMinutes: number;
  temperatureUnit: TemperatureUnit;
  telemetryVisualizationHours: number;
  onMaxNodeAgeChange: (hours: number) => void;
  onTracerouteIntervalChange: (minutes: number) => void;
  onTemperatureUnitChange: (unit: TemperatureUnit) => void;
  onTelemetryVisualizationChange: (hours: number) => void;
}

const SettingsTab: React.FC<SettingsTabProps> = ({
  maxNodeAgeHours,
  tracerouteIntervalMinutes,
  temperatureUnit,
  telemetryVisualizationHours,
  onMaxNodeAgeChange,
  onTracerouteIntervalChange,
  onTemperatureUnitChange,
  onTelemetryVisualizationChange
}) => {
  const handlePurgeNodes = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to erase all nodes and traceroute history?\n\n' +
      'Impact:\n' +
      '• All node information will be deleted\n' +
      '• All traceroute history will be deleted\n' +
      '• A node refresh will be triggered to repopulate the list\n\n' +
      'This action cannot be undone!'
    );

    if (!confirmed) return;

    try {
      await apiService.purgeNodes(0);
      alert('Node list and traceroutes have been purged. Refreshing...');
      window.location.reload();
    } catch (error) {
      console.error('Error purging nodes:', error);
      alert('Error purging nodes. Please try again.');
    }
  };

  const handlePurgeTelemetry = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to purge all telemetry data?\n\n' +
      'Impact:\n' +
      '• All historical telemetry records will be deleted\n' +
      '• Telemetry graphs will show no historical data\n' +
      '• Current node states (battery, voltage) will be preserved\n' +
      '• New telemetry will continue to be collected\n\n' +
      'This action cannot be undone!'
    );

    if (!confirmed) return;

    try {
      await apiService.purgeTelemetry(0);
      alert('Telemetry has been purged. Refreshing...');
      window.location.reload();
    } catch (error) {
      console.error('Error purging telemetry:', error);
      alert('Error purging telemetry. Please try again.');
    }
  };

  const handlePurgeMessages = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to purge all messages?\n\n' +
      'Impact:\n' +
      '• All channel messages will be deleted\n' +
      '• All direct messages will be deleted\n' +
      '• New messages will continue to be received\n\n' +
      'This action cannot be undone!'
    );

    if (!confirmed) return;

    try {
      await apiService.purgeMessages(0);
      alert('Messages have been purged. Refreshing...');
      window.location.reload();
    } catch (error) {
      console.error('Error purging messages:', error);
      alert('Error purging messages. Please try again.');
    }
  };

  return (
    <div className="tab-content">
      <div className="settings-header-card">
        <img src="/logo.png" alt="MeshMonitor Logo" className="settings-logo" />
        <div className="settings-title-section">
          <h1 className="settings-app-name">MeshMonitor</h1>
          <p className="settings-version">Version {version}</p>
        </div>
      </div>
      <div className="settings-content">
        <div className="settings-section">
          <h3>Node Display</h3>
          <div className="setting-item">
            <label htmlFor="maxNodeAge">
              Maximum Age of Active Nodes (hours)
              <span className="setting-description">Nodes older than this will not appear in the Node List</span>
            </label>
            <input
              id="maxNodeAge"
              type="number"
              min="1"
              max="168"
              value={maxNodeAgeHours}
              onChange={(e) => onMaxNodeAgeChange(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
        </div>

        <div className="settings-section">
          <h3>Traceroute</h3>
          <div className="setting-item">
            <label htmlFor="tracerouteInterval">
              Automatic Traceroute Interval (minutes)
              <span className="setting-description">How often to automatically send traceroutes to nodes</span>
            </label>
            <input
              id="tracerouteInterval"
              type="number"
              min="1"
              max="60"
              value={tracerouteIntervalMinutes}
              onChange={(e) => onTracerouteIntervalChange(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
        </div>

        <div className="settings-section">
          <h3>Display Preferences</h3>
          <div className="setting-item">
            <label htmlFor="temperatureUnit">
              Temperature Unit
              <span className="setting-description">Choose between Celsius and Fahrenheit for temperature display</span>
            </label>
            <select
              id="temperatureUnit"
              value={temperatureUnit}
              onChange={(e) => onTemperatureUnitChange(e.target.value as TemperatureUnit)}
              className="setting-input"
            >
              <option value="C">Celsius (°C)</option>
              <option value="F">Fahrenheit (°F)</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="telemetryVisualizationHours">
              Telemetry Visualization (Hours)
              <span className="setting-description">How many hours of telemetry data to display in graphs (1-168)</span>
            </label>
            <input
              type="number"
              id="telemetryVisualizationHours"
              min="1"
              max="168"
              value={telemetryVisualizationHours}
              onChange={(e) => onTelemetryVisualizationChange(Math.min(168, Math.max(1, parseInt(e.target.value) || 24)))}
              className="setting-input"
            />
          </div>
        </div>

        <div className="settings-section danger-zone">
          <h3>⚠️ Danger Zone</h3>
          <p className="danger-zone-description">These actions cannot be undone. Use with caution.</p>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>Erase Node List</h4>
              <p>Removes all nodes and traceroute history from the database. A node refresh will be triggered to repopulate the list.</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeNodes}
            >
              Erase Nodes
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>Purge Telemetry</h4>
              <p>Removes all historical telemetry data (battery, voltage, temperature, etc.). Current node states will be preserved.</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeTelemetry}
            >
              Purge Telemetry
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>Purge Messages</h4>
              <p>Removes all messages from channels and direct message conversations. This action is permanent.</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeMessages}
            >
              Purge Messages
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsTab;