import React, { useState, useEffect } from 'react';
import { TemperatureUnit } from '../utils/temperature';
import { version } from '../../package.json';
import apiService from '../services/api';

type DistanceUnit = 'km' | 'mi';

interface SettingsTabProps {
  maxNodeAgeHours: number;
  tracerouteIntervalMinutes: number;
  temperatureUnit: TemperatureUnit;
  distanceUnit: DistanceUnit;
  telemetryVisualizationHours: number;
  baseUrl: string;
  onMaxNodeAgeChange: (hours: number) => void;
  onTracerouteIntervalChange: (minutes: number) => void;
  onTemperatureUnitChange: (unit: TemperatureUnit) => void;
  onDistanceUnitChange: (unit: DistanceUnit) => void;
  onTelemetryVisualizationChange: (hours: number) => void;
}

const SettingsTab: React.FC<SettingsTabProps> = ({
  maxNodeAgeHours,
  tracerouteIntervalMinutes,
  temperatureUnit,
  distanceUnit,
  telemetryVisualizationHours,
  baseUrl,
  onMaxNodeAgeChange,
  onTracerouteIntervalChange,
  onTemperatureUnitChange,
  onDistanceUnitChange,
  onTelemetryVisualizationChange
}) => {
  // Local state for editing
  const [localMaxNodeAge, setLocalMaxNodeAge] = useState(maxNodeAgeHours);
  const [localTracerouteInterval, setLocalTracerouteInterval] = useState(tracerouteIntervalMinutes);
  const [localTemperatureUnit, setLocalTemperatureUnit] = useState(temperatureUnit);
  const [localDistanceUnit, setLocalDistanceUnit] = useState(distanceUnit);
  const [localTelemetryHours, setLocalTelemetryHours] = useState(telemetryVisualizationHours);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Update local state when props change
  useEffect(() => {
    setLocalMaxNodeAge(maxNodeAgeHours);
    setLocalTracerouteInterval(tracerouteIntervalMinutes);
    setLocalTemperatureUnit(temperatureUnit);
    setLocalDistanceUnit(distanceUnit);
    setLocalTelemetryHours(telemetryVisualizationHours);
  }, [maxNodeAgeHours, tracerouteIntervalMinutes, temperatureUnit, distanceUnit, telemetryVisualizationHours]);

  // Check if any settings have changed
  useEffect(() => {
    const changed =
      localMaxNodeAge !== maxNodeAgeHours ||
      localTracerouteInterval !== tracerouteIntervalMinutes ||
      localTemperatureUnit !== temperatureUnit ||
      localDistanceUnit !== distanceUnit ||
      localTelemetryHours !== telemetryVisualizationHours;
    setHasChanges(changed);
  }, [localMaxNodeAge, localTracerouteInterval, localTemperatureUnit, localDistanceUnit, localTelemetryHours,
      maxNodeAgeHours, tracerouteIntervalMinutes, temperatureUnit, distanceUnit, telemetryVisualizationHours]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const settings = {
        maxNodeAgeHours: localMaxNodeAge,
        tracerouteIntervalMinutes: localTracerouteInterval,
        temperatureUnit: localTemperatureUnit,
        distanceUnit: localDistanceUnit,
        telemetryVisualizationHours: localTelemetryHours
      };

      // Save to server
      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      // Update parent component state
      onMaxNodeAgeChange(localMaxNodeAge);
      onTracerouteIntervalChange(localTracerouteInterval);
      onTemperatureUnitChange(localTemperatureUnit);
      onDistanceUnitChange(localDistanceUnit);
      onTelemetryVisualizationChange(localTelemetryHours);

      alert('Settings saved successfully!');
      setHasChanges(false);
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Failed to save settings. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to reset all settings to defaults?\n\n' +
      'Default values:\n' +
      '• Max Node Age: 24 hours\n' +
      '• Traceroute Interval: 3 minutes (set to 0 to disable)\n' +
      '• Temperature Unit: Celsius\n' +
      '• Distance Unit: Kilometers\n' +
      '• Telemetry Hours: 24\n\n' +
      'This will affect all browsers accessing this system.'
    );

    if (!confirmed) return;

    setIsSaving(true);
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: 'DELETE'
      });

      // Set local state to defaults
      setLocalMaxNodeAge(24);
      setLocalTracerouteInterval(3);
      setLocalTemperatureUnit('C');
      setLocalDistanceUnit('km');
      setLocalTelemetryHours(24);

      // Update parent component with defaults
      onMaxNodeAgeChange(24);
      onTracerouteIntervalChange(3);
      onTemperatureUnitChange('C');
      onDistanceUnitChange('km');
      onTelemetryVisualizationChange(24);

      alert('Settings reset to defaults!');
      setHasChanges(false);
    } catch (error) {
      console.error('Error resetting settings:', error);
      alert('Failed to reset settings. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };
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
        <img src={`${baseUrl}/logo.png`} alt="MeshMonitor Logo" className="settings-logo" />
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
              value={localMaxNodeAge}
              onChange={(e) => setLocalMaxNodeAge(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
        </div>

        <div className="settings-section">
          <h3>Traceroute</h3>
          <div className="setting-item">
            <label htmlFor="tracerouteInterval">
              Automatic Traceroute Interval (minutes)
              <span className="setting-description">How often to automatically send traceroutes to nodes (0 = disabled). Requires container restart to take effect.</span>
            </label>
            <input
              id="tracerouteInterval"
              type="number"
              min="0"
              max="60"
              value={localTracerouteInterval}
              onChange={(e) => setLocalTracerouteInterval(parseInt(e.target.value))}
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
              value={localTemperatureUnit}
              onChange={(e) => setLocalTemperatureUnit(e.target.value as TemperatureUnit)}
              className="setting-input"
            >
              <option value="C">Celsius (°C)</option>
              <option value="F">Fahrenheit (°F)</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="distanceUnit">
              Distance Unit
              <span className="setting-description">Choose between Kilometers and Miles for distance display</span>
            </label>
            <select
              id="distanceUnit"
              value={localDistanceUnit}
              onChange={(e) => setLocalDistanceUnit(e.target.value as DistanceUnit)}
              className="setting-input"
            >
              <option value="km">Kilometers (km)</option>
              <option value="mi">Miles (mi)</option>
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
              value={localTelemetryHours}
              onChange={(e) => setLocalTelemetryHours(Math.min(168, Math.max(1, parseInt(e.target.value) || 24)))}
              className="setting-input"
            />
          </div>
        </div>

        <div className="settings-section">
          <h3>Settings Management</h3>
          <p className="setting-description">Changes are not applied until saved. Settings are stored on the server and persist across all browsers.</p>
          <div className="settings-buttons">
            <button
              className="save-button"
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
            >
              {isSaving ? 'Saving...' : 'Save Settings'}
            </button>
            <button
              className="reset-button"
              onClick={handleReset}
              disabled={isSaving}
            >
              Reset to Defaults
            </button>
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