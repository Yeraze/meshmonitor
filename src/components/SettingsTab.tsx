import React, { useState, useEffect } from 'react';
import { TemperatureUnit } from '../utils/temperature';
import { SortField, SortDirection } from '../types/ui';
import { version } from '../../package.json';
import apiService from '../services/api';
import { logger } from '../utils/logger';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { getAllTilesets, type TilesetId } from '../config/tilesets';
import PacketMonitorSettings from './PacketMonitorSettings';

type DistanceUnit = 'km' | 'mi';
type TimeFormat = '12' | '24';
type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY';

interface SettingsTabProps {
  maxNodeAgeHours: number;
  temperatureUnit: TemperatureUnit;
  distanceUnit: DistanceUnit;
  telemetryVisualizationHours: number;
  preferredSortField: SortField;
  preferredSortDirection: SortDirection;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  mapTileset: TilesetId;
  baseUrl: string;
  onMaxNodeAgeChange: (hours: number) => void;
  onTemperatureUnitChange: (unit: TemperatureUnit) => void;
  onDistanceUnitChange: (unit: DistanceUnit) => void;
  onTelemetryVisualizationChange: (hours: number) => void;
  onPreferredSortFieldChange: (field: SortField) => void;
  onPreferredSortDirectionChange: (direction: SortDirection) => void;
  onTimeFormatChange: (format: TimeFormat) => void;
  onDateFormatChange: (format: DateFormat) => void;
  onMapTilesetChange: (tilesetId: TilesetId) => void;
}

const SettingsTab: React.FC<SettingsTabProps> = ({
  maxNodeAgeHours,
  temperatureUnit,
  distanceUnit,
  telemetryVisualizationHours,
  preferredSortField,
  preferredSortDirection,
  timeFormat,
  dateFormat,
  mapTileset,
  baseUrl,
  onMaxNodeAgeChange,
  onTemperatureUnitChange,
  onDistanceUnitChange,
  onTelemetryVisualizationChange,
  onPreferredSortFieldChange,
  onPreferredSortDirectionChange,
  onTimeFormatChange,
  onDateFormatChange,
  onMapTilesetChange
}) => {
  const csrfFetch = useCsrfFetch();

  // Local state for editing
  const [localMaxNodeAge, setLocalMaxNodeAge] = useState(maxNodeAgeHours);
  const [localTemperatureUnit, setLocalTemperatureUnit] = useState(temperatureUnit);
  const [localDistanceUnit, setLocalDistanceUnit] = useState(distanceUnit);
  const [localTelemetryHours, setLocalTelemetryHours] = useState(telemetryVisualizationHours);
  const [localPreferredSortField, setLocalPreferredSortField] = useState(preferredSortField);
  const [localPreferredSortDirection, setLocalPreferredSortDirection] = useState(preferredSortDirection);
  const [localTimeFormat, setLocalTimeFormat] = useState(timeFormat);
  const [localDateFormat, setLocalDateFormat] = useState(dateFormat);
  const [localMapTileset, setLocalMapTileset] = useState(mapTileset);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDocker, setIsDocker] = useState<boolean | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const { showToast } = useToast();

  // Fetch system status to determine if running in Docker
  useEffect(() => {
    const fetchSystemStatus = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/system/status`, {
          credentials: 'include'
        });
        if (response.ok) {
          const data = await response.json();
          setIsDocker(data.isDocker);
        }
      } catch (error) {
        logger.error('Failed to fetch system status:', error);
      }
    };
    fetchSystemStatus();
  }, [baseUrl]);

  // Update local state when props change
  useEffect(() => {
    setLocalMaxNodeAge(maxNodeAgeHours);
    setLocalTemperatureUnit(temperatureUnit);
    setLocalDistanceUnit(distanceUnit);
    setLocalTelemetryHours(telemetryVisualizationHours);
    setLocalPreferredSortField(preferredSortField);
    setLocalPreferredSortDirection(preferredSortDirection);
    setLocalTimeFormat(timeFormat);
    setLocalDateFormat(dateFormat);
    setLocalMapTileset(mapTileset);
  }, [maxNodeAgeHours, temperatureUnit, distanceUnit, telemetryVisualizationHours, preferredSortField, preferredSortDirection, timeFormat, dateFormat, mapTileset]);

  // Check if any settings have changed
  useEffect(() => {
    const changed =
      localMaxNodeAge !== maxNodeAgeHours ||
      localTemperatureUnit !== temperatureUnit ||
      localDistanceUnit !== distanceUnit ||
      localTelemetryHours !== telemetryVisualizationHours ||
      localPreferredSortField !== preferredSortField ||
      localPreferredSortDirection !== preferredSortDirection ||
      localTimeFormat !== timeFormat ||
      localDateFormat !== dateFormat ||
      localMapTileset !== mapTileset;
    setHasChanges(changed);
  }, [localMaxNodeAge, localTemperatureUnit, localDistanceUnit, localTelemetryHours, localPreferredSortField, localPreferredSortDirection, localTimeFormat, localDateFormat, localMapTileset,
      maxNodeAgeHours, temperatureUnit, distanceUnit, telemetryVisualizationHours, preferredSortField, preferredSortDirection, timeFormat, dateFormat, mapTileset]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const settings = {
        maxNodeAgeHours: localMaxNodeAge,
        temperatureUnit: localTemperatureUnit,
        distanceUnit: localDistanceUnit,
        telemetryVisualizationHours: localTelemetryHours,
        preferredSortField: localPreferredSortField,
        preferredSortDirection: localPreferredSortDirection,
        timeFormat: localTimeFormat,
        dateFormat: localDateFormat,
        mapTileset: localMapTileset
      };

      // Save to server
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      // Update parent component state
      onMaxNodeAgeChange(localMaxNodeAge);
      onTemperatureUnitChange(localTemperatureUnit);
      onDistanceUnitChange(localDistanceUnit);
      onTelemetryVisualizationChange(localTelemetryHours);
      onPreferredSortFieldChange(localPreferredSortField);
      onPreferredSortDirectionChange(localPreferredSortDirection);
      onTimeFormatChange(localTimeFormat);
      onDateFormatChange(localDateFormat);
      onMapTilesetChange(localMapTileset);

      showToast('Settings saved successfully!', 'success');
      setHasChanges(false);
    } catch (error) {
      logger.error('Error saving settings:', error);
      showToast('Failed to save settings. Please try again.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to reset all settings to defaults?\n\n' +
      'Default values:\n' +
      '• Max Node Age: 24 hours\n' +
      '• Temperature Unit: Celsius\n' +
      '• Distance Unit: Kilometers\n' +
      '• Telemetry Hours: 24\n' +
      '• Preferred Sort: Long Name (Ascending)\n' +
      '• Time Format: 24-hour\n' +
      '• Date Format: MM/DD/YYYY\n' +
      '• Map Tileset: OpenStreetMap\n\n' +
      'This will affect all browsers accessing this system.'
    );

    if (!confirmed) return;

    setIsSaving(true);
    try {
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'DELETE'
      });

      // Set local state to defaults
      setLocalMaxNodeAge(24);
      setLocalTemperatureUnit('C');
      setLocalDistanceUnit('km');
      setLocalTelemetryHours(24);
      setLocalPreferredSortField('longName');
      setLocalPreferredSortDirection('asc');
      setLocalTimeFormat('24');
      setLocalDateFormat('MM/DD/YYYY');
      setLocalMapTileset('osm');

      // Update parent component with defaults
      onMaxNodeAgeChange(24);
      onTemperatureUnitChange('C');
      onDistanceUnitChange('km');
      onTelemetryVisualizationChange(24);
      onPreferredSortFieldChange('longName');
      onPreferredSortDirectionChange('asc');
      onTimeFormatChange('24');
      onDateFormatChange('MM/DD/YYYY');
      onMapTilesetChange('osm');

      showToast('Settings reset to defaults!', 'success');
      setHasChanges(false);
    } catch (error) {
      logger.error('Error resetting settings:', error);
      showToast('Failed to reset settings. Please try again.', 'error');
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
      showToast('Node list and traceroutes have been purged. Refreshing...', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging nodes:', error);
      showToast('Error purging nodes. Please try again.', 'error');
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
      showToast('Telemetry has been purged. Refreshing...', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging telemetry:', error);
      showToast('Error purging telemetry. Please try again.', 'error');
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
      showToast('Messages have been purged. Refreshing...', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging messages:', error);
      showToast('Error purging messages. Please try again.', 'error');
    }
  };

  const handleRestartContainer = async () => {
    const action = isDocker ? 'restart' : 'shut down';
    const confirmed = window.confirm(
      `Are you sure you want to ${action} MeshMonitor?\n\n` +
      (isDocker
        ? 'The container will restart automatically and be unavailable for approximately 10-30 seconds.'
        : 'MeshMonitor will shut down and will need to be manually restarted.')
    );

    if (!confirmed) return;

    setIsRestarting(true);
    try {
      const result = await apiService.restartContainer();
      showToast(result.message, 'success');

      if (isDocker) {
        // Wait a few seconds, then reload the page
        setTimeout(() => {
          window.location.reload();
        }, 5000);
      }
    } catch (error) {
      logger.error(`Error ${action}ing:`, error);
      showToast(`Failed to ${action}. Please try again.`, 'error');
      setIsRestarting(false);
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
        <a
          href="https://meshmonitor.org/features/settings"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            marginLeft: 'auto',
            padding: '0.5rem',
            fontSize: '1.5rem',
            color: '#89b4fa',
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}
          title="View Settings Documentation"
        >
          ❓
        </a>
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
          <h3>Display Preferences</h3>
          <div className="setting-item">
            <label htmlFor="preferredSortField">
              Preferred Node List Sorting - Field
              <span className="setting-description">Default sorting field for the Node List on the main page</span>
            </label>
            <select
              id="preferredSortField"
              value={localPreferredSortField}
              onChange={(e) => setLocalPreferredSortField(e.target.value as SortField)}
              className="setting-input"
            >
              <option value="longName">Long Name</option>
              <option value="shortName">Short Name</option>
              <option value="id">ID</option>
              <option value="lastHeard">Last Heard</option>
              <option value="snr">SNR</option>
              <option value="battery">Battery</option>
              <option value="hwModel">Hardware Model</option>
              <option value="hops">Hops</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="preferredSortDirection">
              Preferred Node List Sorting - Direction
              <span className="setting-description">Default sorting direction for the Node List on the main page</span>
            </label>
            <select
              id="preferredSortDirection"
              value={localPreferredSortDirection}
              onChange={(e) => setLocalPreferredSortDirection(e.target.value as SortDirection)}
              className="setting-input"
            >
              <option value="asc">Ascending (A-Z, 0-9, oldest-newest)</option>
              <option value="desc">Descending (Z-A, 9-0, newest-oldest)</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="timeFormat">
              Time Format
              <span className="setting-description">Choose between 12-hour or 24-hour time display</span>
            </label>
            <select
              id="timeFormat"
              value={localTimeFormat}
              onChange={(e) => setLocalTimeFormat(e.target.value as TimeFormat)}
              className="setting-input"
            >
              <option value="12">12-hour (e.g., 3:45 PM)</option>
              <option value="24">24-hour (e.g., 15:45)</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="dateFormat">
              Date Format
              <span className="setting-description">Choose your preferred date display format</span>
            </label>
            <select
              id="dateFormat"
              value={localDateFormat}
              onChange={(e) => setLocalDateFormat(e.target.value as DateFormat)}
              className="setting-input"
            >
              <option value="MM/DD/YYYY">MM/DD/YYYY (e.g., 12/31/2024)</option>
              <option value="DD/MM/YYYY">DD/MM/YYYY (e.g., 31/12/2024)</option>
            </select>
          </div>
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
          <div className="setting-item">
            <label htmlFor="mapTileset">
              Map Tileset
              <span className="setting-description">Choose the map style for the network visualization</span>
            </label>
            <select
              id="mapTileset"
              value={localMapTileset}
              onChange={(e) => setLocalMapTileset(e.target.value as TilesetId)}
              className="setting-input"
            >
              {getAllTilesets().map((tileset) => (
                <option key={tileset.id} value={tileset.id}>
                  {tileset.name} {tileset.description && `- ${tileset.description}`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings-section">
          <h3>Packet Monitor (Desktop Only)</h3>
          <p className="setting-description">Configure the mesh traffic monitor that displays all packets on the network. Requires both channels:read and messages:read permissions.</p>
          <div className="packet-monitor-settings">
            <PacketMonitorSettings baseUrl={baseUrl} />
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

          {isDocker !== null && (
            <div className="danger-action">
              <div className="danger-action-info">
                <h4>{isDocker ? 'Restart Container' : 'Shutdown MeshMonitor'}</h4>
                <p>
                  {isDocker
                    ? 'Restarts the Docker container. The system will be unavailable for approximately 10-30 seconds.'
                    : 'Shuts down MeshMonitor. You will need to manually restart it.'}
                </p>
              </div>
              <button
                className="danger-button"
                onClick={handleRestartContainer}
                disabled={isRestarting}
              >
                {isRestarting ? (isDocker ? 'Restarting...' : 'Shutting down...') : (isDocker ? '🔄 Restart Container' : '🛑 Shutdown')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsTab;