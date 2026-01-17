import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
import DatabaseMaintenanceSection from './configuration/DatabaseMaintenanceSection';
import AutoUpgradeTestSection from './configuration/AutoUpgradeTestSection';
import { CustomThemeManagement } from './CustomThemeManagement';
import { CustomTilesetManager } from './CustomTilesetManager';
import { type Theme, type NodeHopsCalculation, useSettings } from '../contexts/SettingsContext';
import { useUI } from '../contexts/UIContext';
import { LanguageSelector } from './LanguageSelector';
import SectionNav from './SectionNav';
import TapbackEmojiSettings from './TapbackEmojiSettings';

type DistanceUnit = 'km' | 'mi';
type TimeFormat = '12' | '24';
type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
type MapPinStyle = 'meshmonitor' | 'official';

interface SettingsTabProps {
  maxNodeAgeHours: number;
  inactiveNodeThresholdHours: number;
  inactiveNodeCheckIntervalMinutes: number;
  inactiveNodeCooldownHours: number;
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
  language: string;
  solarMonitoringEnabled: boolean;
  solarMonitoringLatitude: number;
  solarMonitoringLongitude: number;
  solarMonitoringAzimuth: number;
  solarMonitoringDeclination: number;
  currentNodeId: string;
  nodes: any[];
  baseUrl: string;
  onMaxNodeAgeChange: (hours: number) => void;
  onInactiveNodeThresholdHoursChange: (hours: number) => void;
  onInactiveNodeCheckIntervalMinutesChange: (minutes: number) => void;
  onInactiveNodeCooldownHoursChange: (hours: number) => void;
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
  onLanguageChange: (language: string) => void;
  onSolarMonitoringEnabledChange: (enabled: boolean) => void;
  onSolarMonitoringLatitudeChange: (latitude: number) => void;
  onSolarMonitoringLongitudeChange: (longitude: number) => void;
  onSolarMonitoringAzimuthChange: (azimuth: number) => void;
  onSolarMonitoringDeclinationChange: (declination: number) => void;
}

const SettingsTab: React.FC<SettingsTabProps> = ({
  maxNodeAgeHours,
  inactiveNodeThresholdHours,
  inactiveNodeCheckIntervalMinutes,
  inactiveNodeCooldownHours,
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
  language,
  solarMonitoringEnabled,
  solarMonitoringLatitude,
  solarMonitoringLongitude,
  solarMonitoringAzimuth,
  solarMonitoringDeclination,
  currentNodeId,
  nodes,
  baseUrl,
  onMaxNodeAgeChange,
  onInactiveNodeThresholdHoursChange,
  onInactiveNodeCheckIntervalMinutesChange,
  onInactiveNodeCooldownHoursChange,
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
  onLanguageChange,
  onSolarMonitoringEnabledChange,
  onSolarMonitoringLatitudeChange,
  onSolarMonitoringLongitudeChange,
  onSolarMonitoringAzimuthChange,
  onSolarMonitoringDeclinationChange
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const {
    customThemes,
    customTilesets,
    enableAudioNotifications,
    setEnableAudioNotifications,
    nodeDimmingEnabled,
    setNodeDimmingEnabled,
    nodeDimmingStartHours,
    setNodeDimmingStartHours,
    nodeDimmingMinOpacity,
    setNodeDimmingMinOpacity,
    nodeHopsCalculation,
    setNodeHopsCalculation
  } = useSettings();
  const { showIncompleteNodes, setShowIncompleteNodes } = useUI();

  // Local state for editing
  const [localMaxNodeAge, setLocalMaxNodeAge] = useState(maxNodeAgeHours);
  const [localInactiveNodeThresholdHours, setLocalInactiveNodeThresholdHours] = useState(inactiveNodeThresholdHours);
  const [localInactiveNodeCheckIntervalMinutes, setLocalInactiveNodeCheckIntervalMinutes] = useState(inactiveNodeCheckIntervalMinutes);
  const [localInactiveNodeCooldownHours, setLocalInactiveNodeCooldownHours] = useState(inactiveNodeCooldownHours);
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
  const [localNodeHopsCalculation, setLocalNodeHopsCalculation] = useState(nodeHopsCalculation);
  const [localPacketLogEnabled, setLocalPacketLogEnabled] = useState(false);
  const [localPacketLogMaxCount, setLocalPacketLogMaxCount] = useState(1000);
  const [localPacketLogMaxAgeHours, setLocalPacketLogMaxAgeHours] = useState(24);
  const [localSolarMonitoringEnabled, setLocalSolarMonitoringEnabled] = useState(solarMonitoringEnabled);
  const [localSolarMonitoringLatitude, setLocalSolarMonitoringLatitude] = useState(solarMonitoringLatitude);
  const [localSolarMonitoringLongitude, setLocalSolarMonitoringLongitude] = useState(solarMonitoringLongitude);
  const [localSolarMonitoringAzimuth, setLocalSolarMonitoringAzimuth] = useState(solarMonitoringAzimuth);
  const [localSolarMonitoringDeclination, setLocalSolarMonitoringDeclination] = useState(solarMonitoringDeclination);
  // Note: localHideIncompleteNodes is inverted from showIncompleteNodes because
  // the UI checkbox says "Hide" while the context uses "show" semantics
  const [localHideIncompleteNodes, setLocalHideIncompleteNodes] = useState(!showIncompleteNodes);
  const [isFetchingSolarEstimates, setIsFetchingSolarEstimates] = useState(false);
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

  // Fetch packet monitor and other server-stored settings
  useEffect(() => {
    const fetchServerSettings = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/settings`, {
          credentials: 'include'
        });
        if (response.ok) {
          const settings = await response.json();
          const enabled = settings.packet_log_enabled === '1';
          const maxCount = parseInt(settings.packet_log_max_count || '1000', 10);
          const maxAgeHours = parseInt(settings.packet_log_max_age_hours || '24', 10);
          const hideIncomplete = settings.hideIncompleteNodes === '1';

          setLocalPacketLogEnabled(enabled);
          setLocalPacketLogMaxCount(maxCount);
          setLocalPacketLogMaxAgeHours(maxAgeHours);
          setInitialPacketMonitorSettings({ enabled, maxCount, maxAgeHours });

          // Load hide incomplete nodes setting
          setLocalHideIncompleteNodes(hideIncomplete);
          setShowIncompleteNodes(!hideIncomplete);
        }
      } catch (error) {
        logger.error('Failed to fetch server settings:', error);
      }
    };
    fetchServerSettings();
  }, [baseUrl, setShowIncompleteNodes]);

  // Update local state when props change
  useEffect(() => {
    setLocalMaxNodeAge(maxNodeAgeHours);
    setLocalInactiveNodeThresholdHours(inactiveNodeThresholdHours);
    setLocalInactiveNodeCheckIntervalMinutes(inactiveNodeCheckIntervalMinutes);
    setLocalInactiveNodeCooldownHours(inactiveNodeCooldownHours);
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
    setLocalNodeHopsCalculation(nodeHopsCalculation);
    setLocalSolarMonitoringEnabled(solarMonitoringEnabled);
    setLocalSolarMonitoringLatitude(solarMonitoringLatitude);
    setLocalSolarMonitoringLongitude(solarMonitoringLongitude);
    setLocalSolarMonitoringAzimuth(solarMonitoringAzimuth);
    setLocalSolarMonitoringDeclination(solarMonitoringDeclination);
    setLocalHideIncompleteNodes(!showIncompleteNodes);
  }, [maxNodeAgeHours, inactiveNodeThresholdHours, inactiveNodeCheckIntervalMinutes, inactiveNodeCooldownHours, temperatureUnit, distanceUnit, telemetryVisualizationHours, favoriteTelemetryStorageDays, preferredSortField, preferredSortDirection, timeFormat, dateFormat, mapTileset, mapPinStyle, nodeHopsCalculation, solarMonitoringEnabled, solarMonitoringLatitude, solarMonitoringLongitude, solarMonitoringAzimuth, solarMonitoringDeclination, showIncompleteNodes]);

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
      localInactiveNodeThresholdHours !== inactiveNodeThresholdHours ||
      localInactiveNodeCheckIntervalMinutes !== inactiveNodeCheckIntervalMinutes ||
      localInactiveNodeCooldownHours !== inactiveNodeCooldownHours ||
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
      localNodeHopsCalculation !== nodeHopsCalculation ||
      localPacketLogEnabled !== initialPacketMonitorSettings.enabled ||
      localPacketLogMaxCount !== initialPacketMonitorSettings.maxCount ||
      localPacketLogMaxAgeHours !== initialPacketMonitorSettings.maxAgeHours ||
      localSolarMonitoringEnabled !== solarMonitoringEnabled ||
      localSolarMonitoringLatitude !== solarMonitoringLatitude ||
      localSolarMonitoringLongitude !== solarMonitoringLongitude ||
      localSolarMonitoringAzimuth !== solarMonitoringAzimuth ||
      localSolarMonitoringDeclination !== solarMonitoringDeclination ||
      localHideIncompleteNodes !== !showIncompleteNodes;
    setHasChanges(changed);
  }, [localMaxNodeAge, localInactiveNodeThresholdHours, localInactiveNodeCheckIntervalMinutes, localInactiveNodeCooldownHours, localTemperatureUnit, localDistanceUnit, localTelemetryHours, localFavoriteTelemetryStorageDays, localPreferredSortField, localPreferredSortDirection, localTimeFormat, localDateFormat, localMapTileset, localMapPinStyle, localTheme, localNodeHopsCalculation,
      maxNodeAgeHours, inactiveNodeThresholdHours, inactiveNodeCheckIntervalMinutes, inactiveNodeCooldownHours, temperatureUnit, distanceUnit, telemetryVisualizationHours, favoriteTelemetryStorageDays, preferredSortField, preferredSortDirection, timeFormat, dateFormat, mapTileset, mapPinStyle, theme, nodeHopsCalculation,
      localPacketLogEnabled, localPacketLogMaxCount, localPacketLogMaxAgeHours, initialPacketMonitorSettings,
      localSolarMonitoringEnabled, localSolarMonitoringLatitude, localSolarMonitoringLongitude, localSolarMonitoringAzimuth, localSolarMonitoringDeclination,
      solarMonitoringEnabled, solarMonitoringLatitude, solarMonitoringLongitude, solarMonitoringAzimuth, solarMonitoringDeclination,
      localHideIncompleteNodes, showIncompleteNodes]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const settings = {
        maxNodeAgeHours: localMaxNodeAge,
        inactiveNodeThresholdHours: localInactiveNodeThresholdHours,
        inactiveNodeCheckIntervalMinutes: localInactiveNodeCheckIntervalMinutes,
        inactiveNodeCooldownHours: localInactiveNodeCooldownHours,
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
        solarMonitoringDeclination: localSolarMonitoringDeclination.toString(),
        hideIncompleteNodes: localHideIncompleteNodes ? '1' : '0'
      };

      // Save to server
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      // Update parent component state
      onMaxNodeAgeChange(localMaxNodeAge);
      onInactiveNodeThresholdHoursChange(localInactiveNodeThresholdHours);
      onInactiveNodeCheckIntervalMinutesChange(localInactiveNodeCheckIntervalMinutes);
      onInactiveNodeCooldownHoursChange(localInactiveNodeCooldownHours);
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
      setNodeHopsCalculation(localNodeHopsCalculation);
      onSolarMonitoringEnabledChange(localSolarMonitoringEnabled);
      onSolarMonitoringLatitudeChange(localSolarMonitoringLatitude);
      onSolarMonitoringLongitudeChange(localSolarMonitoringLongitude);
      onSolarMonitoringAzimuthChange(localSolarMonitoringAzimuth);
      onSolarMonitoringDeclinationChange(localSolarMonitoringDeclination);
      setShowIncompleteNodes(!localHideIncompleteNodes);

      // Update initial packet monitor settings after successful save
      setInitialPacketMonitorSettings({ enabled: localPacketLogEnabled, maxCount: localPacketLogMaxCount, maxAgeHours: localPacketLogMaxAgeHours });

      showToast(t('settings.saved_success'), 'success');
      setHasChanges(false);
    } catch (error) {
      logger.error('Error saving settings:', error);
      showToast(t('settings.save_failed'), 'error');
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

      showToast(t('settings.solar_fetch_success'), 'success');
    } catch (error) {
      logger.error('Error triggering solar estimate fetch:', error);
      showToast(t('settings.solar_fetch_failed'), 'error');
    } finally {
      setIsFetchingSolarEstimates(false);
    }
  };

  const handleReset = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_reset_title') + '\n\n' +
      t('settings.confirm_reset_defaults') + '\n' +
      '• ' + t('settings.confirm_reset_max_age') + '\n' +
      '• ' + t('settings.confirm_reset_temp') + '\n' +
      '• ' + t('settings.confirm_reset_dist') + '\n' +
      '• ' + t('settings.confirm_reset_telemetry') + '\n' +
      '• ' + t('settings.confirm_reset_sort') + '\n' +
      '• ' + t('settings.confirm_reset_time') + '\n' +
      '• ' + t('settings.confirm_reset_date') + '\n' +
      '• ' + t('settings.confirm_reset_tileset') + '\n' +
      '• ' + t('settings.confirm_reset_pins') + '\n' +
      '• ' + t('settings.confirm_reset_packet') + '\n' +
      '• ' + t('settings.confirm_reset_max_packets') + '\n' +
      '• ' + t('settings.confirm_reset_packet_age') + '\n\n' +
      t('settings.confirm_reset_affects')
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
      setLocalNodeHopsCalculation('nodeinfo');
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
      setNodeHopsCalculation('nodeinfo');
      onSolarMonitoringEnabledChange(false);
      onSolarMonitoringLatitudeChange(0);
      onSolarMonitoringLongitudeChange(0);
      onSolarMonitoringAzimuthChange(0);
      onSolarMonitoringDeclinationChange(30);

      // Update initial packet monitor settings
      setInitialPacketMonitorSettings({ enabled: false, maxCount: 1000, maxAgeHours: 24 });

      showToast(t('settings.reset_success'), 'success');
      setHasChanges(false);
    } catch (error) {
      logger.error('Error resetting settings:', error);
      showToast(t('settings.reset_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  };
  const handlePurgeNodes = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_purge_nodes_title') + '\n\n' +
      t('settings.confirm_purge_nodes_impact') + '\n' +
      '• ' + t('settings.confirm_purge_nodes_item1') + '\n' +
      '• ' + t('settings.confirm_purge_nodes_item2') + '\n' +
      '• ' + t('settings.confirm_purge_nodes_item3') + '\n\n' +
      t('settings.confirm_cannot_undo')
    );

    if (!confirmed) return;

    try {
      await apiService.purgeNodes(0);
      showToast(t('toast.nodes_purged'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging nodes:', error);
      showToast(t('toast.node_purge_failed'), 'error');
    }
  };

  const handlePurgeTelemetry = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_purge_telemetry_title') + '\n\n' +
      t('settings.confirm_purge_nodes_impact') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item1') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item2') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item3') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item4') + '\n\n' +
      t('settings.confirm_cannot_undo')
    );

    if (!confirmed) return;

    try {
      await apiService.purgeTelemetry(0);
      showToast(t('toast.telemetry_purged'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging telemetry:', error);
      showToast(t('toast.telemetry_purge_failed'), 'error');
    }
  };

  const handlePurgeMessages = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_purge_messages_title') + '\n\n' +
      t('settings.confirm_purge_nodes_impact') + '\n' +
      '• ' + t('settings.confirm_purge_messages_item1') + '\n' +
      '• ' + t('settings.confirm_purge_messages_item2') + '\n' +
      '• ' + t('settings.confirm_purge_messages_item3') + '\n\n' +
      t('settings.confirm_cannot_undo')
    );

    if (!confirmed) return;

    try {
      await apiService.purgeMessages(0);
      showToast(t('messages.purged_success'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging messages:', error);
      showToast(t('messages.error_purging'), 'error');
    }
  };

  const handlePurgeTraceroutes = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_purge_traceroutes_title') + '\n\n' +
      t('settings.confirm_purge_nodes_impact') + '\n' +
      '• ' + t('settings.confirm_purge_traceroutes_item1') + '\n' +
      '• ' + t('settings.confirm_purge_traceroutes_item2') + '\n' +
      '• ' + t('settings.confirm_purge_traceroutes_item3') + '\n' +
      '• ' + t('settings.confirm_purge_traceroutes_item4') + '\n\n' +
      t('settings.confirm_cannot_undo')
    );

    if (!confirmed) return;

    try {
      await apiService.purgeTraceroutes();
      showToast(t('toast.traceroutes_purged'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging traceroutes:', error);
      showToast(t('toast.traceroutes_purge_failed'), 'error');
    }
  };

  const handleRestartContainer = async () => {
    const action = isDocker ? t('settings.restart_action') : t('settings.shutdown_action');
    const confirmed = window.confirm(
      t('settings.confirm_restart_title', { action }) + '\n\n' +
      (isDocker
        ? t('settings.confirm_restart_docker')
        : t('settings.confirm_restart_manual'))
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
      showToast(t('settings.restart_failed', { action }), 'error');
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
          title={t('settings.view_docs')}
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
          title={t('settings.support')}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#74a0e0'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#89b4fa'}
        >
          ❤️ {t('settings.support')}</a>
      </div>
      <SectionNav items={[
        { id: 'settings-language', label: t('settings.language') },
        { id: 'settings-node-display', label: t('settings.node_display') },
        { id: 'settings-display-prefs', label: t('settings.display_prefs') },
        { id: 'settings-tapback-emojis', label: t('settings.tapback_emojis', 'Tapback Emojis') },
        { id: 'settings-packet-monitor', label: t('settings.packet_monitor') },
        { id: 'settings-solar', label: t('settings.solar_monitoring') },
        { id: 'settings-backup', label: t('settings.system_backup', 'System Backup') },
        { id: 'settings-maintenance', label: t('maintenance.title', 'Database Maintenance') },
        { id: 'settings-management', label: t('settings.settings_management') },
        { id: 'settings-danger', label: t('settings.danger_zone') },
      ]} />
      <div className="settings-content">
        <div id="settings-language" className="settings-section">
          <h3>{t('settings.language')}</h3>
          <div className="setting-item">
            <label htmlFor="language">
              {t('settings.languageDescription')}
            </label>
            <LanguageSelector
              value={language}
              onChange={onLanguageChange}
            />
          </div>
          <p className="setting-description" style={{ marginTop: '0.5rem' }}>
            {t('settings.language_contribute')}{' '}
            <a
              href="https://hosted.weblate.org/projects/meshmonitor/meshmonitor/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent-color)' }}
            >
              Weblate
            </a>
          </p>
        </div>

        <div id="settings-node-display" className="settings-section">
          <h3>{t('settings.node_display')}</h3>
          <div className="setting-item">
            <label htmlFor="maxNodeAge">
              {t('settings.max_node_age_label')}
              <span className="setting-description">{t('settings.max_node_age_description')}</span>
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
          <div className="setting-item">
            <label htmlFor="inactiveNodeThresholdHours">
              {t('settings.inactive_node_threshold_label')}
              <span className="setting-description">{t('settings.inactive_node_threshold_description')}</span>
            </label>
            <input
              id="inactiveNodeThresholdHours"
              type="number"
              min="1"
              max="720"
              value={localInactiveNodeThresholdHours}
              onChange={(e) => setLocalInactiveNodeThresholdHours(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="inactiveNodeCheckIntervalMinutes">
              {t('settings.inactive_node_check_interval_label')}
              <span className="setting-description">{t('settings.inactive_node_check_interval_description')}</span>
            </label>
            <input
              id="inactiveNodeCheckIntervalMinutes"
              type="number"
              min="1"
              max="1440"
              value={localInactiveNodeCheckIntervalMinutes}
              onChange={(e) => setLocalInactiveNodeCheckIntervalMinutes(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="inactiveNodeCooldownHours">
              {t('settings.inactive_node_cooldown_label')}
              <span className="setting-description">{t('settings.inactive_node_cooldown_description')}</span>
            </label>
            <input
              id="inactiveNodeCooldownHours"
              type="number"
              min="1"
              max="720"
              value={localInactiveNodeCooldownHours}
              onChange={(e) => setLocalInactiveNodeCooldownHours(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="nodeHopsCalculation">
              {t('settings.node_hops_calculation')}
              <span className="setting-description">{t('settings.node_hops_calculation_description')}</span>
            </label>
            <select
              id="nodeHopsCalculation"
              value={localNodeHopsCalculation}
              onChange={(e) => setLocalNodeHopsCalculation(e.target.value as NodeHopsCalculation)}
              className="setting-input"
            >
              <option value="nodeinfo">{t('settings.node_hops_nodeinfo')}</option>
              <option value="traceroute">{t('settings.node_hops_traceroute')}</option>
              <option value="messages">{t('settings.node_hops_messages')}</option>
            </select>
          </div>
        </div>

        <div id="settings-display-prefs" className="settings-section">
          <h3>{t('settings.display_prefs')}</h3>
          <div className="setting-item">
            <label htmlFor="preferredSortField">
              {t('settings.sort_field_label')}
              <span className="setting-description">{t('settings.sort_field_description')}</span>
            </label>
            <select
              id="preferredSortField"
              value={localPreferredSortField}
              onChange={(e) => setLocalPreferredSortField(e.target.value as SortField)}
              className="setting-input"
            >
              <option value="longName">{t('settings.sort_long_name')}</option>
              <option value="shortName">{t('settings.sort_short_name')}</option>
              <option value="id">{t('settings.sort_id')}</option>
              <option value="lastHeard">{t('settings.sort_last_heard')}</option>
              <option value="snr">{t('settings.sort_snr')}</option>
              <option value="battery">{t('settings.sort_battery')}</option>
              <option value="hwModel">{t('settings.sort_hw_model')}</option>
              <option value="hops">{t('settings.sort_hops')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="preferredSortDirection">
              {t('settings.sort_direction_label')}
              <span className="setting-description">{t('settings.sort_direction_description')}</span>
            </label>
            <select
              id="preferredSortDirection"
              value={localPreferredSortDirection}
              onChange={(e) => setLocalPreferredSortDirection(e.target.value as SortDirection)}
              className="setting-input"
            >
              <option value="asc">{t('settings.sort_ascending')}</option>
              <option value="desc">{t('settings.sort_descending')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="timeFormat">
              {t('settings.time_format_label')}
              <span className="setting-description">{t('settings.time_format_description')}</span>
            </label>
            <select
              id="timeFormat"
              value={localTimeFormat}
              onChange={(e) => setLocalTimeFormat(e.target.value as TimeFormat)}
              className="setting-input"
            >
              <option value="12">{t('settings.time_12_hour')}</option>
              <option value="24">{t('settings.time_24_hour')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="dateFormat">
              {t('settings.date_format_label')}
              <span className="setting-description">{t('settings.date_format_description')}</span>
            </label>
            <select
              id="dateFormat"
              value={localDateFormat}
              onChange={(e) => setLocalDateFormat(e.target.value as DateFormat)}
              className="setting-input"
            >
              <option value="MM/DD/YYYY">{t('settings.date_mdy')}</option>
              <option value="DD/MM/YYYY">{t('settings.date_dmy')}</option>
              <option value="YYYY-MM-DD">{t('settings.date_iso')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="temperatureUnit">
              {t('settings.temp_unit_label')}
              <span className="setting-description">{t('settings.temp_unit_description')}</span>
            </label>
            <select
              id="temperatureUnit"
              value={localTemperatureUnit}
              onChange={(e) => setLocalTemperatureUnit(e.target.value as TemperatureUnit)}
              className="setting-input"
            >
              <option value="C">{t('settings.temp_celsius')}</option>
              <option value="F">{t('settings.temp_fahrenheit')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="distanceUnit">
              {t('settings.dist_unit_label')}
              <span className="setting-description">{t('settings.dist_unit_description')}</span>
            </label>
            <select
              id="distanceUnit"
              value={localDistanceUnit}
              onChange={(e) => setLocalDistanceUnit(e.target.value as DistanceUnit)}
              className="setting-input"
            >
              <option value="km">{t('settings.dist_km')}</option>
              <option value="mi">{t('settings.dist_mi')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="telemetryVisualizationHours">
              {t('settings.telemetry_hours_label')}
              <span className="setting-description">{t('settings.telemetry_hours_description')}</span>
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
              {t('settings.fav_telemetry_label')}
              <span className="setting-description">{t('settings.fav_telemetry_description')}</span>
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
              {t('settings.map_tileset_label')}
              <span className="setting-description">{t('settings.map_tileset_description')}</span>
            </label>
            <select
              id="mapTileset"
              value={localMapTileset}
              onChange={(e) => setLocalMapTileset(e.target.value as TilesetId)}
              className="setting-input"
            >
              {getAllTilesets(customTilesets).map((tileset) => (
                <option key={tileset.id} value={tileset.id}>
                  {tileset.name} {tileset.description && `- ${tileset.description}`}
                  {tileset.isCustom && ' [Custom]'}
                </option>
              ))}
            </select>
          </div>
          <CustomTilesetManager />
          <div className="setting-item">
            <label htmlFor="mapPinStyle">
              {t('settings.map_pin_label')}
              <span className="setting-description">{t('settings.map_pin_description')}</span>
            </label>
            <select
              id="mapPinStyle"
              value={localMapPinStyle}
              onChange={(e) => setLocalMapPinStyle(e.target.value as MapPinStyle)}
              className="setting-input"
            >
              <option value="meshmonitor">{t('settings.map_pin_meshmonitor')}</option>
              <option value="official">{t('settings.map_pin_official')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="theme">
              {t('settings.theme_label')}
              <span className="setting-description">{t('settings.theme_description')}</span>
            </label>
            <select
              id="theme"
              value={localTheme}
              onChange={(e) => setLocalTheme(e.target.value as Theme)}
              className="setting-input"
            >
              <optgroup label={t('settings.theme_catppuccin')}>
                <option value="mocha">{t('settings.theme_mocha')}</option>
                <option value="macchiato">{t('settings.theme_macchiato')}</option>
                <option value="frappe">{t('settings.theme_frappe')}</option>
                <option value="latte">{t('settings.theme_latte')}</option>
              </optgroup>
              <optgroup label={t('settings.theme_popular')}>
                <option value="nord">{t('settings.theme_nord')}</option>
                <option value="dracula">{t('settings.theme_dracula')}</option>
                <option value="solarized-dark">{t('settings.theme_solarized_dark')}</option>
                <option value="solarized-light">{t('settings.theme_solarized_light')}</option>
                <option value="gruvbox-dark">{t('settings.theme_gruvbox_dark')}</option>
                <option value="gruvbox-light">{t('settings.theme_gruvbox_light')}</option>
              </optgroup>
              <optgroup label={t('settings.theme_high_contrast')}>
                <option value="high-contrast-dark">{t('settings.theme_hc_dark')}</option>
                <option value="high-contrast-light">{t('settings.theme_hc_light')}</option>
              </optgroup>
              <optgroup label={t('settings.theme_colorblind')}>
                <option value="protanopia">{t('settings.theme_protanopia')}</option>
                <option value="deuteranopia">{t('settings.theme_deuteranopia')}</option>
                <option value="tritanopia">{t('settings.theme_tritanopia')}</option>
              </optgroup>
              {customThemes.length > 0 && (
                <optgroup label={t('settings.theme_custom')}>
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

        <TapbackEmojiSettings />

        <div className="settings-section">
          <h3>{t('settings.reset_ui_positions')}</h3>
          <p className="setting-description">{t('settings.reset_ui_positions_description')}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              // Clear all draggable UI element positions from localStorage
              localStorage.removeItem('nodesSidebarPosition');
              localStorage.removeItem('nodesSidebarSize');
              localStorage.removeItem('mapControlsPosition');
              localStorage.removeItem('draggable_position_map-legend');
              localStorage.removeItem('draggable_position_tileset-selector');
              showToast(t('settings.reset_ui_positions_success'), 'success');
            }}
          >
            {t('settings.reset_ui_positions_button')}
          </button>
        </div>

        <div id="settings-packet-monitor" className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={localPacketLogEnabled}
                onChange={(e) => setLocalPacketLogEnabled(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.packet_monitor')}</span>
            </label>
            <span style={{ fontSize: '0.85rem', fontWeight: 'normal', color: 'var(--text-secondary)' }}>{t('settings.packet_monitor_desktop_only')}</span>
          </h3>
          <p className="setting-description">{t('settings.packet_monitor_description')}</p>
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
                checked={enableAudioNotifications}
                onChange={(e) => setEnableAudioNotifications(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.enable_audio_notifications')}</span>
            </label>
          </h3>
          <p className="setting-description">
            {t('settings.enable_audio_notifications_description')}
          </p>
        </div>

        <div className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={localHideIncompleteNodes}
                onChange={(e) => setLocalHideIncompleteNodes(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.hide_incomplete_nodes')}</span>
            </label>
          </h3>
          <p className="setting-description">
            {t('settings.hide_incomplete_description')}
          </p>
        </div>

        <div className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={nodeDimmingEnabled}
                onChange={(e) => setNodeDimmingEnabled(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.node_dimming_enabled')}</span>
            </label>
          </h3>
          <p className="setting-description">
            {t('settings.node_dimming_description')}
          </p>
          {nodeDimmingEnabled && (
            <>
              <div className="setting-item">
                <label htmlFor="nodeDimmingStartHours">
                  {t('settings.node_dimming_start_hours')}
                  <span className="setting-description">{t('settings.node_dimming_start_hours_description')}</span>
                </label>
                <input
                  id="nodeDimmingStartHours"
                  type="number"
                  min="0.5"
                  max="24"
                  step="0.5"
                  value={nodeDimmingStartHours}
                  onChange={(e) => setNodeDimmingStartHours(Math.min(24, Math.max(0.5, parseFloat(e.target.value) || 1)))}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="nodeDimmingMinOpacity">
                  {t('settings.node_dimming_min_opacity')}
                  <span className="setting-description">{t('settings.node_dimming_min_opacity_description')}</span>
                </label>
                <input
                  id="nodeDimmingMinOpacity"
                  type="number"
                  min="0.1"
                  max="0.9"
                  step="0.1"
                  value={nodeDimmingMinOpacity}
                  onChange={(e) => setNodeDimmingMinOpacity(Math.min(0.9, Math.max(0.1, parseFloat(e.target.value) || 0.3)))}
                  className="setting-input"
                />
              </div>
            </>
          )}
        </div>

        <div id="settings-solar" className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={localSolarMonitoringEnabled}
                onChange={(e) => setLocalSolarMonitoringEnabled(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.solar_monitoring')}</span>
            </label>
          </h3>
          <p className="setting-description">
            {t('settings.solar_monitoring_description', { link: '' })}
            <a href="https://forecast.solar/" target="_blank" rel="noopener noreferrer" style={{ color: '#89b4fa' }}>
              Forecast.Solar
            </a>
          </p>
          {localSolarMonitoringEnabled && (
            <>
              <div className="setting-item">
                <label htmlFor="solarLatitude">
                  {t('settings.solar_latitude')}
                  <span className="setting-description">
                    {t('settings.solar_latitude_description')} • <a href="https://gps-coordinates.org/" target="_blank" rel="noopener noreferrer" style={{ color: '#4a9eff', textDecoration: 'underline' }}>{t('settings.solar_find_coords')}</a>
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
                  {t('settings.solar_longitude')}
                  <span className="setting-description">{t('settings.solar_longitude_description')}</span>
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
                  {t('settings.solar_azimuth')}
                  <span className="setting-description">{t('settings.solar_azimuth_description')}</span>
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
                  {t('settings.solar_declination')}
                  <span className="setting-description">{t('settings.solar_declination_description')}</span>
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
                  {isFetchingSolarEstimates ? t('settings.solar_fetching') : t('settings.solar_fetch_now')}
                </button>
                <p className="setting-description" style={{ marginTop: '0.5rem' }}>
                  {t('settings.solar_fetch_description')}
                </p>
              </div>
            </>
          )}
        </div>

        <div id="settings-backup">
          <SystemBackupSection />
        </div>

        <DatabaseMaintenanceSection />

        <AutoUpgradeTestSection baseUrl={baseUrl} />

        <div id="settings-management" className="settings-section">
          <h3>{t('settings.settings_management')}</h3>
          <p className="setting-description">{t('settings.settings_management_description')}</p>
          <div className="settings-buttons">
            <button
              className="save-button"
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
            >
              {isSaving ? t('settings.saving') : t('settings.save_settings')}
            </button>
            <button
              className="reset-button"
              onClick={handleReset}
              disabled={isSaving}
            >
              {t('settings.reset_defaults')}
            </button>
          </div>
        </div>

        <div id="settings-danger" className="settings-section danger-zone">
          <h3>⚠️ {t('settings.danger_zone')}</h3>
          <p className="danger-zone-description">{t('settings.danger_zone_description')}</p>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>{t('settings.erase_nodes_title')}</h4>
              <p>{t('settings.erase_nodes_description')}</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeNodes}
            >
              {t('settings.erase_nodes_button')}
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>{t('settings.purge_telemetry_title')}</h4>
              <p>{t('settings.purge_telemetry_description')}</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeTelemetry}
            >
              {t('settings.purge_telemetry_button')}
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>{t('settings.purge_messages_title')}</h4>
              <p>{t('settings.purge_messages_description')}</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeMessages}
            >
              {t('settings.purge_messages_button')}
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>{t('settings.reset_traceroutes_title')}</h4>
              <p>{t('settings.reset_traceroutes_description')}</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeTraceroutes}
            >
              {t('settings.reset_traceroutes_button')}
            </button>
          </div>

          {isDocker !== null && (
            <div className="danger-action">
              <div className="danger-action-info">
                <h4>{isDocker ? t('settings.restart_container_title') : t('settings.shutdown_title')}</h4>
                <p>
                  {isDocker
                    ? t('settings.restart_container_description')
                    : t('settings.shutdown_description')}
                </p>
              </div>
              <button
                className="danger-button"
                onClick={handleRestartContainer}
                disabled={isRestarting}
              >
                {isRestarting ? (isDocker ? t('settings.restarting') : t('settings.shutting_down')) : (isDocker ? '🔄 ' + t('settings.restart_button') : '🛑 ' + t('settings.shutdown_button'))}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsTab;