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
import SystemBackupSection from './configuration/SystemBackupSection';
import AutoUpgradeTestSection from './configuration/AutoUpgradeTestSection';
import { CustomThemeManagement } from './CustomThemeManagement';
import { type Theme, useSettings } from '../contexts/SettingsContext';
import { PMTilesModal } from './PMTilesModal';

type DistanceUnit = 'km' | 'mi';
type TimeFormat = '12' | '24';
type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY';
type MapPinStyle = 'meshmonitor' | 'official';

interface SettingsTabProps {
  maxNodeAgeHours: number;
  temperatureUnit: TemperatureUnit;
  distanceUnit: DistanceUnit;
  telemetryVisualizationHours: number;
  favoriteTelemetryStorageDays: number;
  preferredSortField: SortField;
  preferredSortDirection: SortDirection;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  mapTileset: TilesetId;
  mapPinStyle: MapPinStyle;
  theme: Theme;
  solarMonitoringEnabled: boolean;
  solarMonitoringLatitude: number;
  solarMonitoringLongitude: number;
  solarMonitoringAzimuth: number;
  solarMonitoringDeclination: number;
  currentNodeId: string;
  nodes: any[];
  baseUrl: string;
  onMaxNodeAgeChange: (hours: number) => void;
  onTemperatureUnitChange: (unit: TemperatureUnit) => void;
  onDistanceUnitChange: (unit: DistanceUnit) => void;
  onTelemetryVisualizationChange: (hours: number) => void;
  onFavoriteTelemetryStorageDaysChange: (days: number) => void;
  onPreferredSortFieldChange: (field: SortField) => void;
  onPreferredSortDirectionChange: (direction: SortDirection) => void;
  onTimeFormatChange: (format: TimeFormat) => void;
  onDateFormatChange: (format: DateFormat) => void;
  onMapTilesetChange: (tilesetId: TilesetId) => void;
  onMapPinStyleChange: (style: MapPinStyle) => void;
  onThemeChange: (theme: Theme) => void;
  onSolarMonitoringEnabledChange: (enabled: boolean) => void;
  onSolarMonitoringLatitudeChange: (latitude: number) => void;
  onSolarMonitoringLongitudeChange: (longitude: number) => void;
  onSolarMonitoringAzimuthChange: (azimuth: number) => void;
  onSolarMonitoringDeclinationChange: (declination: number) => void;
}

const SettingsTab: React.FC<SettingsTabProps> = ({
  maxNodeAgeHours,
  temperatureUnit,
  distanceUnit,
  telemetryVisualizationHours,
  favoriteTelemetryStorageDays,
  preferredSortField,
  preferredSortDirection,
  timeFormat,
  dateFormat,
  mapTileset,
  mapPinStyle,
  theme,
  solarMonitoringEnabled,
  solarMonitoringLatitude,
  solarMonitoringLongitude,
  solarMonitoringAzimuth,
  solarMonitoringDeclination,
  currentNodeId,
  nodes,
  baseUrl,
  onMaxNodeAgeChange,
  onTemperatureUnitChange,
  onDistanceUnitChange,
  onTelemetryVisualizationChange,
  onFavoriteTelemetryStorageDaysChange,
  onPreferredSortFieldChange,
  onPreferredSortDirectionChange,
  onTimeFormatChange,
  onDateFormatChange,
  onMapTilesetChange,
  onMapPinStyleChange,
  onThemeChange,
  onSolarMonitoringEnabledChange,
  onSolarMonitoringLatitudeChange,
  onSolarMonitoringLongitudeChange,
  onSolarMonitoringAzimuthChange,
  onSolarMonitoringDeclinationChange
}) => {
  const csrfFetch = useCsrfFetch();
  const { customThemes } = useSettings();

  // Local state for editing
  const [localMaxNodeAge, setLocalMaxNodeAge] = useState(maxNodeAgeHours);
  const [localTemperatureUnit, setLocalTemperatureUnit] = useState(temperatureUnit);
  const [localDistanceUnit, setLocalDistanceUnit] = useState(distanceUnit);
  const [localTelemetryHours, setLocalTelemetryHours] = useState(telemetryVisualizationHours);
  const [localFavoriteTelemetryStorageDays, setLocalFavoriteTelemetryStorageDays] = useState(favoriteTelemetryStorageDays);
  const [localPreferredSortField, setLocalPreferredSortField] = useState(preferredSortField);
  const [localPreferredSortDirection, setLocalPreferredSortDirection] = useState(preferredSortDirection);
  const [localTimeFormat, setLocalTimeFormat] = useState(timeFormat);
  const [localDateFormat, setLocalDateFormat] = useState(dateFormat);
  const [localMapTileset, setLocalMapTileset] = useState(mapTileset);
  const [localMapPinStyle, setLocalMapPinStyle] = useState(mapPinStyle);
  const [localTheme, setLocalTheme] = useState(theme);
  const [localPacketLogEnabled, setLocalPacketLogEnabled] = useState(false);
  const [localPacketLogMaxCount, setLocalPacketLogMaxCount] = useState(1000);
  const [localPacketLogMaxAgeHours, setLocalPacketLogMaxAgeHours] = useState(24);
  const [localSolarMonitoringEnabled, setLocalSolarMonitoringEnabled] = useState(solarMonitoringEnabled);
  const [localSolarMonitoringLatitude, setLocalSolarMonitoringLatitude] = useState(solarMonitoringLatitude);
  const [localSolarMonitoringLongitude, setLocalSolarMonitoringLongitude] = useState(solarMonitoringLongitude);
  const [localSolarMonitoringAzimuth, setLocalSolarMonitoringAzimuth] = useState(solarMonitoringAzimuth);
  const [localSolarMonitoringDeclination, setLocalSolarMonitoringDeclination] = useState(solarMonitoringDeclination);
  const [isFetchingSolarEstimates, setIsFetchingSolarEstimates] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDocker, setIsDocker] = useState<boolean | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isPMTilesModalOpen, setIsPMTilesModalOpen] = useState(false);
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

  // Fetch packet monitor settings
  useEffect(() => {
    const fetchPacketMonitorSettings = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/settings`, {
          credentials: 'include'
        });
        if (response.ok) {
          const settings = await response.json();
          const enabled = settings.packet_log_enabled === '1';
          const maxCount = parseInt(settings.packet_log_max_count || '1000', 10);
          const maxAgeHours = parseInt(settings.packet_log_max_age_hours || '24', 10);

          setLocalPacketLogEnabled(enabled);
          setLocalPacketLogMaxCount(maxCount);
          setLocalPacketLogMaxAgeHours(maxAgeHours);
          setInitialPacketMonitorSettings({ enabled, maxCount, maxAgeHours });
        }
      } catch (error) {
        logger.error('Failed to fetch packet monitor settings:', error);
      }
    };
    fetchPacketMonitorSettings();
  }, [baseUrl]);

  // Update local state when props change
  useEffect(() => {
    setLocalMaxNodeAge(maxNodeAgeHours);
    setLocalTemperatureUnit(temperatureUnit);
    setLocalDistanceUnit(distanceUnit);
    setLocalTelemetryHours(telemetryVisualizationHours);
    setLocalFavoriteTelemetryStorageDays(favoriteTelemetryStorageDays);
    setLocalPreferredSortField(preferredSortField);
    setLocalPreferredSortDirection(preferredSortDirection);
    setLocalTimeFormat(timeFormat);
    setLocalDateFormat(dateFormat);
    setLocalMapTileset(mapTileset);
    setLocalMapPinStyle(mapPinStyle);
    setLocalTheme(theme);
    setLocalSolarMonitoringEnabled(solarMonitoringEnabled);
    setLocalSolarMonitoringLatitude(solarMonitoringLatitude);
    setLocalSolarMonitoringLongitude(solarMonitoringLongitude);
    setLocalSolarMonitoringAzimuth(solarMonitoringAzimuth);
    setLocalSolarMonitoringDeclination(solarMonitoringDeclination);
  }, [maxNodeAgeHours, temperatureUnit, distanceUnit, telemetryVisualizationHours, favoriteTelemetryStorageDays, preferredSortField, preferredSortDirection, timeFormat, dateFormat, mapTileset, mapPinStyle, solarMonitoringEnabled, solarMonitoringLatitude, solarMonitoringLongitude, solarMonitoringAzimuth, solarMonitoringDeclination]);

  // Default solar monitoring lat/long to device position if still at 0
  useEffect(() => {
    // Only set defaults if solar monitoring is enabled and values are at 0
    if (solarMonitoringLatitude === 0 && solarMonitoringLongitude === 0 && currentNodeId && nodes.length > 0) {
      const currentNode = nodes.find(n => n.user?.id === currentNodeId);
      if (currentNode?.position?.latitude != null && currentNode?.position?.longitude != null) {
        setLocalSolarMonitoringLatitude(currentNode.position.latitude);
        setLocalSolarMonitoringLongitude(currentNode.position.longitude);
      }
    }
  }, [currentNodeId, nodes, solarMonitoringLatitude, solarMonitoringLongitude]);

  // Check if any settings have changed
  // Note: We can't compare packet monitor settings to props since they're not in props
  // Instead, we'll track initial packet monitor values separately
  const [initialPacketMonitorSettings, setInitialPacketMonitorSettings] = useState({ enabled: false, maxCount: 1000, maxAgeHours: 24 });

  useEffect(() => {
    const changed =
      localMaxNodeAge !== maxNodeAgeHours ||
      localTemperatureUnit !== temperatureUnit ||
      localDistanceUnit !== distanceUnit ||
      localTelemetryHours !== telemetryVisualizationHours ||
      localFavoriteTelemetryStorageDays !== favoriteTelemetryStorageDays ||
      localPreferredSortField !== preferredSortField ||
      localPreferredSortDirection !== preferredSortDirection ||
      localTimeFormat !== timeFormat ||
      localDateFormat !== dateFormat ||
      localMapTileset !== mapTileset ||
      localMapPinStyle !== mapPinStyle ||
      localTheme !== theme ||
      localPacketLogEnabled !== initialPacketMonitorSettings.enabled ||
      localPacketLogMaxCount !== initialPacketMonitorSettings.maxCount ||
      localPacketLogMaxAgeHours !== initialPacketMonitorSettings.maxAgeHours ||
      localSolarMonitoringEnabled !== solarMonitoringEnabled ||
      localSolarMonitoringLatitude !== solarMonitoringLatitude ||
      localSolarMonitoringLongitude !== solarMonitoringLongitude ||
      localSolarMonitoringAzimuth !== solarMonitoringAzimuth ||
      localSolarMonitoringDeclination !== solarMonitoringDeclination;
    setHasChanges(changed);
  }, [localMaxNodeAge, localTemperatureUnit, localDistanceUnit, localTelemetryHours, localFavoriteTelemetryStorageDays, localPreferredSortField, localPreferredSortDirection, localTimeFormat, localDateFormat, localMapTileset, localMapPinStyle, localTheme,
      maxNodeAgeHours, temperatureUnit, distanceUnit, telemetryVisualizationHours, favoriteTelemetryStorageDays, preferredSortField, preferredSortDirection, timeFormat, dateFormat, mapTileset, mapPinStyle, theme,
      localPacketLogEnabled, localPacketLogMaxCount, localPacketLogMaxAgeHours, initialPacketMonitorSettings,
      localSolarMonitoringEnabled, localSolarMonitoringLatitude, localSolarMonitoringLongitude, localSolarMonitoringAzimuth, localSolarMonitoringDeclination,
      solarMonitoringEnabled, solarMonitoringLatitude, solarMonitoringLongitude, solarMonitoringAzimuth, solarMonitoringDeclination]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const settings = {
        maxNodeAgeHours: localMaxNodeAge,
        temperatureUnit: localTemperatureUnit,
        distanceUnit: localDistanceUnit,
        telemetryVisualizationHours: localTelemetryHours,
        favoriteTelemetryStorageDays: localFavoriteTelemetryStorageDays,
        preferredSortField: localPreferredSortField,
        preferredSortDirection: localPreferredSortDirection,
        timeFormat: localTimeFormat,
        dateFormat: localDateFormat,
        mapTileset: localMapTileset,
        mapPinStyle: localMapPinStyle,
        theme: localTheme,
        packet_log_enabled: localPacketLogEnabled ? '1' : '0',
        packet_log_max_count: localPacketLogMaxCount.toString(),
        packet_log_max_age_hours: localPacketLogMaxAgeHours.toString(),
        solarMonitoringEnabled: localSolarMonitoringEnabled ? '1' : '0',
        solarMonitoringLatitude: localSolarMonitoringLatitude.toString(),
        solarMonitoringLongitude: localSolarMonitoringLongitude.toString(),
        solarMonitoringAzimuth: localSolarMonitoringAzimuth.toString(),
        solarMonitoringDeclination: localSolarMonitoringDeclination.toString()
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
      onFavoriteTelemetryStorageDaysChange(localFavoriteTelemetryStorageDays);
      onPreferredSortFieldChange(localPreferredSortField);
      onPreferredSortDirectionChange(localPreferredSortDirection);
      onTimeFormatChange(localTimeFormat);
      onDateFormatChange(localDateFormat);
      onMapTilesetChange(localMapTileset);
      onMapPinStyleChange(localMapPinStyle);
      onThemeChange(localTheme);
      onSolarMonitoringEnabledChange(localSolarMonitoringEnabled);
      onSolarMonitoringLatitudeChange(localSolarMonitoringLatitude);
      onSolarMonitoringLongitudeChange(localSolarMonitoringLongitude);
      onSolarMonitoringAzimuthChange(localSolarMonitoringAzimuth);
      onSolarMonitoringDeclinationChange(localSolarMonitoringDeclination);

      // Update initial packet monitor settings after successful save
      setInitialPacketMonitorSettings({ enabled: localPacketLogEnabled, maxCount: localPacketLogMaxCount, maxAgeHours: localPacketLogMaxAgeHours });

      showToast('Settings saved successfully!', 'success');
      setHasChanges(false);
    } catch (error) {
      logger.error('Error saving settings:', error);
      showToast('Failed to save settings. Please try again.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleFetchSolarEstimates = async () => {
    setIsFetchingSolarEstimates(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/solar/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to trigger solar estimate fetch');
      }

      showToast('Solar estimates fetch triggered successfully!', 'success');
    } catch (error) {
      logger.error('Error triggering solar estimate fetch:', error);
      showToast('Failed to trigger solar estimate fetch', 'error');
    } finally {
      setIsFetchingSolarEstimates(false);
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
      '• Map Tileset: OpenStreetMap\n' +
      '• Map Pin Style: MeshMonitor\n' +
      '• Packet Monitor: Disabled\n' +
      '• Max Packets: 1000\n' +
      '• Packet Age: 24 hours\n\n' +
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
      setLocalFavoriteTelemetryStorageDays(7);
      setLocalPreferredSortField('longName');
      setLocalPreferredSortDirection('asc');
      setLocalTimeFormat('24');
      setLocalDateFormat('MM/DD/YYYY');
      setLocalMapTileset('osm');
      setLocalMapPinStyle('meshmonitor');
      setLocalTheme('mocha');
      setLocalPacketLogEnabled(false);
      setLocalPacketLogMaxCount(1000);
      setLocalPacketLogMaxAgeHours(24);
      setLocalSolarMonitoringEnabled(false);
      setLocalSolarMonitoringLatitude(0);
      setLocalSolarMonitoringLongitude(0);
      setLocalSolarMonitoringAzimuth(0);
      setLocalSolarMonitoringDeclination(30);

      // Update parent component with defaults
      onMaxNodeAgeChange(24);
      onTemperatureUnitChange('C');
      onDistanceUnitChange('km');
      onTelemetryVisualizationChange(24);
      onFavoriteTelemetryStorageDaysChange(7);
      onPreferredSortFieldChange('longName');
      onPreferredSortDirectionChange('asc');
      onTimeFormatChange('24');
      onDateFormatChange('MM/DD/YYYY');
      onMapTilesetChange('osm');
      onMapPinStyleChange('meshmonitor');
      onThemeChange('mocha');
      onSolarMonitoringEnabledChange(false);
      onSolarMonitoringLatitudeChange(0);
      onSolarMonitoringLongitudeChange(0);
      onSolarMonitoringAzimuthChange(0);
      onSolarMonitoringDeclinationChange(30);

      // Update initial packet monitor settings
      setInitialPacketMonitorSettings({ enabled: false, maxCount: 1000, maxAgeHours: 24 });

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

  const handlePurgeTraceroutes = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to reset all traceroutes?\n\n' +
      'Impact:\n' +
      '• All saved traceroutes will be deleted\n' +
      '• All traceroute history will be deleted\n' +
      '• All route segments (including record holders) will be deleted\n' +
      '• New traceroutes will continue to be collected\n\n' +
      'This action cannot be undone!'
    );

    if (!confirmed) return;

    try {
      await apiService.purgeTraceroutes();
      showToast('Traceroutes have been purged. Refreshing...', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging traceroutes:', error);
      showToast('Error purging traceroutes. Please try again.', 'error');
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
        <a
          href="https://ko-fi.com/yeraze"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            marginLeft: '0.5rem',
            padding: '0.5rem 1rem',
            fontSize: '1rem',
            color: '#ffffff',
            backgroundColor: '#89b4fa',
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            borderRadius: '6px',
            fontWeight: '500',
            transition: 'background-color 0.2s',
            border: 'none',
            cursor: 'pointer'
          }}
          title="Support MeshMonitor"
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#74a0e0'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#89b4fa'}
        >
          ❤️ Support MeshMonitor
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
            <label htmlFor="favoriteTelemetryStorageDays">
              Favorite Telemetry Storage Length (Days)
              <span className="setting-description">How many days to retain favorited telemetry data (7-90 days). Favorited telemetry is exempt from regular purge.</span>
            </label>
            <input
              type="number"
              id="favoriteTelemetryStorageDays"
              min="7"
              max="90"
              value={localFavoriteTelemetryStorageDays}
              onChange={(e) => setLocalFavoriteTelemetryStorageDays(Math.min(90, Math.max(7, parseInt(e.target.value) || 7)))}
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

          {/* PMTiles Offline Map Setup Button */}
          <div className="setting-item">
            <label>
              Offline Map Setup
              <span className="setting-description">Download and install PMTiles for offline mapping</span>
            </label>
            <button
              type="button"
              onClick={() => setIsPMTilesModalOpen(true)}
              className="btn btn-secondary"
            >
              Setup Offline Maps
            </button>
          </div>

          <div className="setting-item">
            <label htmlFor="mapPinStyle">
              Map Pin Style
              <span className="setting-description">Choose the style of node markers on the map</span>
            </label>
            <select
              id="mapPinStyle"
              value={localMapPinStyle}
              onChange={(e) => setLocalMapPinStyle(e.target.value as MapPinStyle)}
              className="setting-input"
            >
              <option value="meshmonitor">MeshMonitor - Pin markers with zoom-based labels</option>
              <option value="official">Official Meshtastic - Circle markers with always-visible labels</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="theme">
              Color Theme
              <span className="setting-description">Choose from 15 themes including accessibility-focused options</span>
            </label>
            <select
              id="theme"
              value={localTheme}
              onChange={(e) => setLocalTheme(e.target.value as Theme)}
              className="setting-input"
            >
              <optgroup label="Catppuccin">
                <option value="mocha">Mocha (Dark)</option>
                <option value="macchiato">Macchiato (Medium-Dark)</option>
                <option value="frappe">Frappé (Medium)</option>
                <option value="latte">Latte (Light)</option>
              </optgroup>
              <optgroup label="Popular Themes">
                <option value="nord">Nord</option>
                <option value="dracula">Dracula</option>
                <option value="solarized-dark">Solarized Dark</option>
                <option value="solarized-light">Solarized Light</option>
                <option value="gruvbox-dark">Gruvbox Dark</option>
                <option value="gruvbox-light">Gruvbox Light</option>
              </optgroup>
              <optgroup label="High Contrast (WCAG AAA)">
                <option value="high-contrast-dark">High Contrast Dark</option>
                <option value="high-contrast-light">High Contrast Light</option>
              </optgroup>
              <optgroup label="Color Blind Friendly">
                <option value="protanopia">Protanopia (Red-Blind)</option>
                <option value="deuteranopia">Deuteranopia (Green-Blind)</option>
                <option value="tritanopia">Tritanopia (Blue-Blind)</option>
              </optgroup>
              {customThemes.length > 0 && (
                <optgroup label="Custom Themes">
                  {customThemes.map((customTheme) => (
                    <option key={customTheme.id} value={customTheme.slug}>
                      {customTheme.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
        </div>

        <div className="settings-section">
          <CustomThemeManagement />
        </div>

        <div className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={localPacketLogEnabled}
                onChange={(e) => setLocalPacketLogEnabled(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>Packet Monitor</span>
            </label>
            <span style={{ fontSize: '0.85rem', fontWeight: 'normal', color: 'var(--text-secondary)' }}>(Desktop Only)</span>
          </h3>
          <p className="setting-description">Configure the mesh traffic monitor that displays all packets on the network. Requires both channels:read and messages:read permissions.</p>
          <div className="packet-monitor-settings">
            <PacketMonitorSettings
              enabled={localPacketLogEnabled}
              maxCount={localPacketLogMaxCount}
              maxAgeHours={localPacketLogMaxAgeHours}
              onMaxCountChange={setLocalPacketLogMaxCount}
              onMaxAgeHoursChange={setLocalPacketLogMaxAgeHours}
            />
          </div>
        </div>

        <div className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={localSolarMonitoringEnabled}
                onChange={(e) => setLocalSolarMonitoringEnabled(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>Solar Monitoring</span>
            </label>
          </h3>
          <p className="setting-description">
            Configure solar panel monitoring for production estimates. Thanks to{' '}
            <a href="https://forecast.solar/" target="_blank" rel="noopener noreferrer" style={{ color: '#89b4fa' }}>
              Forecast.Solar
            </a>
            {' '}for their Solar Estimates API!
          </p>
          {localSolarMonitoringEnabled && (
            <>
              <div className="setting-item">
                <label htmlFor="solarLatitude">
                  Latitude
                  <span className="setting-description">
                    North-south position on Earth (-90 south to +90 north) • <a href="https://gps-coordinates.org/" target="_blank" rel="noopener noreferrer" style={{ color: '#4a9eff', textDecoration: 'underline' }}>Find your GPS coordinates here</a>
                  </span>
                </label>
                <input
                  id="solarLatitude"
                  type="number"
                  min="-90"
                  max="90"
                  step="0.0001"
                  value={localSolarMonitoringLatitude}
                  onChange={(e) => setLocalSolarMonitoringLatitude(parseFloat(e.target.value) || 0)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="solarLongitude">
                  Longitude
                  <span className="setting-description">East-west position on Earth (-180 west to +180 east)</span>
                </label>
                <input
                  id="solarLongitude"
                  type="number"
                  min="-180"
                  max="180"
                  step="0.0001"
                  value={localSolarMonitoringLongitude}
                  onChange={(e) => setLocalSolarMonitoringLongitude(parseFloat(e.target.value) || 0)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="solarAzimuth">
                  Azimuth (degrees)
                  <span className="setting-description">Compass direction panels face: -180=north, -90=east, 0=south, 90=west, 180=north</span>
                </label>
                <input
                  id="solarAzimuth"
                  type="number"
                  min="-180"
                  max="180"
                  step="1"
                  value={localSolarMonitoringAzimuth}
                  onChange={(e) => setLocalSolarMonitoringAzimuth(parseInt(e.target.value) || 0)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="solarDeclination">
                  Declination/Tilt (degrees)
                  <span className="setting-description">Panel angle from ground: 0=horizontal, 90=vertical. Typical: 20-40 degrees</span>
                </label>
                <input
                  id="solarDeclination"
                  type="number"
                  min="0"
                  max="90"
                  step="1"
                  value={localSolarMonitoringDeclination}
                  onChange={(e) => setLocalSolarMonitoringDeclination(parseInt(e.target.value) || 30)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item" style={{ marginTop: '1rem' }}>
                <button
                  onClick={handleFetchSolarEstimates}
                  disabled={isFetchingSolarEstimates}
                  className="save-button"
                  style={{ width: 'auto', padding: '0.5rem 1rem' }}
                >
                  {isFetchingSolarEstimates ? 'Fetching...' : 'Fetch Estimates Now'}
                </button>
                <p className="setting-description" style={{ marginTop: '0.5rem' }}>
                  Manually trigger a solar estimate fetch from Forecast.Solar. Estimates are automatically fetched every hour at :05 past the hour.
                </p>
              </div>
            </>
          )}
        </div>

        <SystemBackupSection />

        <AutoUpgradeTestSection baseUrl={baseUrl} />

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

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>Reset Traceroutes</h4>
              <p>Removes all saved traceroutes, traceroute history, and route segments (including record holders). New traceroutes will continue to be collected.</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeTraceroutes}
            >
              Reset Traceroutes
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

      {/* PMTiles Modal */}
      <PMTilesModal
        isOpen={isPMTilesModalOpen}
        onClose={() => setIsPMTilesModalOpen(false)}
      />
    </div>
  );
};

export default SettingsTab;