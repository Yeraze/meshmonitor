/**
 * Settings -> Telemetry: visualization window and favorite retention (#6258).
 *
 * Controlled sub-form shared by SettingsTab (global save) and
 * MeshCoreTelemetrySettingsSection (per-source save) so the inputs and their
 * ranges cannot drift apart.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { NumberInput } from '../common/NumberInput';
import { TELEMETRY_RETENTION_RANGES } from '../../constants/nodeDisplayDefaults';

export interface TelemetryRetentionSettingsProps {
  visualizationHours: number;
  favoriteStorageDays: number;
  /** Read-only form (no settings:write). */
  disabled?: boolean;
  onVisualizationHoursChange: (value: number) => void;
  onFavoriteStorageDaysChange: (value: number) => void;
}

export const TelemetryRetentionSettings: React.FC<TelemetryRetentionSettingsProps> = ({
  visualizationHours,
  favoriteStorageDays,
  disabled = false,
  onVisualizationHoursChange,
  onFavoriteStorageDaysChange,
}) => {
  const { t } = useTranslation();
  const hoursRange = TELEMETRY_RETENTION_RANGES.telemetryVisualizationHours;
  const daysRange = TELEMETRY_RETENTION_RANGES.favoriteTelemetryStorageDays;

  return (
    <>
      <div className="setting-item">
        <label htmlFor="telemetryVisualizationHours">
          {t('settings.telemetry_hours_label')}
          <span className="setting-description">{t('settings.telemetry_hours_description')}</span>
        </label>
        <NumberInput
          id="telemetryVisualizationHours"
          min={hoursRange.min}
          max={hoursRange.max}
          integer
          value={visualizationHours}
          onChange={onVisualizationHoursChange}
          disabled={disabled}
          className="setting-input"
        />
      </div>
      <div className="setting-item">
        <label htmlFor="favoriteTelemetryStorageDays">
          {t('settings.fav_telemetry_label')}
          <span className="setting-description">{t('settings.fav_telemetry_description')}</span>
        </label>
        <NumberInput
          id="favoriteTelemetryStorageDays"
          min={daysRange.min}
          max={daysRange.max}
          integer
          value={favoriteStorageDays}
          onChange={onFavoriteStorageDaysChange}
          disabled={disabled}
          className="setting-input"
        />
      </div>
    </>
  );
};

export default TelemetryRetentionSettings;
