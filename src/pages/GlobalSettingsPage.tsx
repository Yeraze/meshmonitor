/**
 * GlobalSettingsPage — standalone page for global (non-source-specific) settings.
 *
 * Renders SettingsTab in `mode="global"` so only global sections are shown:
 * Language, Units & Formats, Appearance, Map, System Backup, Database
 * Maintenance, Auto-Upgrade, and Analytics.
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { UIProvider } from '../contexts/UIContext';
import { SaveBarProvider } from '../contexts/SaveBarContext';
import { ToastProvider } from '../components/ToastContainer';
import { SaveBar } from '../components/SaveBar';
import SettingsTab from '../components/SettingsTab';
import { appBasename } from '../init';
import '../styles/settings.css';

function GlobalSettingsInner() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    maxNodeAgeHours,
    inactiveNodeThresholdHours,
    inactiveNodeCheckIntervalMinutes,
    inactiveNodeCooldownHours,
    temperatureUnit,
    distanceUnit,
    positionHistoryLineStyle,
    telemetryVisualizationHours,
    favoriteTelemetryStorageDays,
    preferredSortField,
    preferredSortDirection,
    timeFormat,
    dateFormat,
    mapTileset,
    mapPinStyle,
    iconStyle,
    theme,
    language,
    solarMonitoringEnabled,
    solarMonitoringLatitude,
    solarMonitoringLongitude,
    solarMonitoringAzimuth,
    solarMonitoringDeclination,
    setMaxNodeAgeHours,
    setInactiveNodeThresholdHours,
    setInactiveNodeCheckIntervalMinutes,
    setInactiveNodeCooldownHours,
    setTemperatureUnit,
    setDistanceUnit,
    setPositionHistoryLineStyle,
    setTelemetryVisualizationHours,
    setFavoriteTelemetryStorageDays,
    setPreferredSortField,
    setPreferredSortDirection,
    setTimeFormat,
    setDateFormat,
    setMapTileset,
    setMapPinStyle,
    setIconStyle,
    setTheme,
    setLanguage,
    setSolarMonitoringEnabled,
    setSolarMonitoringLatitude,
    setSolarMonitoringLongitude,
    setSolarMonitoringAzimuth,
    setSolarMonitoringDeclination,
  } = useSettings();

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '1rem' }}>
      <button
        onClick={() => navigate('/')}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent-color)',
          cursor: 'pointer',
          fontSize: '0.9rem',
          marginBottom: '0.5rem',
          padding: 0,
        }}
      >
        {t('admin.back_to_dashboard')}
      </button>
      <SettingsTab
        mode="global"
        maxNodeAgeHours={maxNodeAgeHours}
        inactiveNodeThresholdHours={inactiveNodeThresholdHours}
        inactiveNodeCheckIntervalMinutes={inactiveNodeCheckIntervalMinutes}
        inactiveNodeCooldownHours={inactiveNodeCooldownHours}
        temperatureUnit={temperatureUnit}
        distanceUnit={distanceUnit}
        positionHistoryLineStyle={positionHistoryLineStyle}
        telemetryVisualizationHours={telemetryVisualizationHours}
        favoriteTelemetryStorageDays={favoriteTelemetryStorageDays}
        preferredSortField={preferredSortField}
        preferredSortDirection={preferredSortDirection}
        timeFormat={timeFormat}
        dateFormat={dateFormat}
        mapTileset={mapTileset}
        mapPinStyle={mapPinStyle}
        iconStyle={iconStyle}
        theme={theme}
        language={language}
        solarMonitoringEnabled={solarMonitoringEnabled}
        solarMonitoringLatitude={solarMonitoringLatitude}
        solarMonitoringLongitude={solarMonitoringLongitude}
        solarMonitoringAzimuth={solarMonitoringAzimuth}
        solarMonitoringDeclination={solarMonitoringDeclination}
        currentNodeId=""
        nodes={[]}
        baseUrl={appBasename}
        onMaxNodeAgeChange={setMaxNodeAgeHours}
        onInactiveNodeThresholdHoursChange={setInactiveNodeThresholdHours}
        onInactiveNodeCheckIntervalMinutesChange={setInactiveNodeCheckIntervalMinutes}
        onInactiveNodeCooldownHoursChange={setInactiveNodeCooldownHours}
        onTemperatureUnitChange={setTemperatureUnit}
        onDistanceUnitChange={setDistanceUnit}
        onPositionHistoryLineStyleChange={setPositionHistoryLineStyle}
        onTelemetryVisualizationChange={setTelemetryVisualizationHours}
        onFavoriteTelemetryStorageDaysChange={setFavoriteTelemetryStorageDays}
        onPreferredSortFieldChange={setPreferredSortField}
        onPreferredSortDirectionChange={setPreferredSortDirection}
        onTimeFormatChange={setTimeFormat}
        onDateFormatChange={setDateFormat}
        onMapTilesetChange={setMapTileset}
        onMapPinStyleChange={setMapPinStyle}
        onIconStyleChange={setIconStyle}
        onThemeChange={setTheme}
        onLanguageChange={setLanguage}
        onSolarMonitoringEnabledChange={setSolarMonitoringEnabled}
        onSolarMonitoringLatitudeChange={setSolarMonitoringLatitude}
        onSolarMonitoringLongitudeChange={setSolarMonitoringLongitude}
        onSolarMonitoringAzimuthChange={setSolarMonitoringAzimuth}
        onSolarMonitoringDeclinationChange={setSolarMonitoringDeclination}
      />
    </div>
  );
}

export default function GlobalSettingsPage() {
  return (
    <SettingsProvider>
      <UIProvider>
        <ToastProvider>
          <SaveBarProvider>
            <GlobalSettingsInner />
            <SaveBar />
          </SaveBarProvider>
        </ToastProvider>
      </UIProvider>
    </SettingsProvider>
  );
}
