/**
 * Settings -> Node Display: map-marker dimming (#6258).
 *
 * Controlled sub-form shared by SettingsTab (Meshtastic) and
 * MeshCoreNodeDisplaySection so the inputs cannot drift apart. The start/
 * min-opacity inputs only render while dimming is enabled.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { NumberInput } from '../common/NumberInput';
import { NODE_DIMMING_RANGES } from '../../constants/nodeDisplayDefaults';
import styles from './NodeDimmingSettings.module.css';

export interface NodeDimmingSettingsProps {
  enabled: boolean;
  startHours: number;
  minOpacity: number;
  /** Read-only form (no settings:write). */
  disabled?: boolean;
  /** Replaces the default description under the enable checkbox. */
  description?: string;
  onEnabledChange: (value: boolean) => void;
  onStartHoursChange: (value: number) => void;
  onMinOpacityChange: (value: number) => void;
}

export const NodeDimmingSettings: React.FC<NodeDimmingSettingsProps> = ({
  enabled,
  startHours,
  minOpacity,
  disabled = false,
  description,
  onEnabledChange,
  onStartHoursChange,
  onMinOpacityChange,
}) => {
  const { t } = useTranslation();
  const startRange = NODE_DIMMING_RANGES.nodeDimmingStartHours;
  const opacityRange = NODE_DIMMING_RANGES.nodeDimmingMinOpacity;

  return (
    <>
      <div className={`setting-item ${styles.item}`}>
        <label>
          <span className={styles.toggleRow}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={enabled}
              disabled={disabled}
              onChange={(e) => onEnabledChange(e.target.checked)}
            />
            {t('settings.node_dimming_enabled')}
          </span>
          <span className="setting-description">
            {description ?? t('settings.node_dimming_description')}
          </span>
        </label>
      </div>
      {enabled && (
        <>
          <div className="setting-item">
            <label htmlFor="nodeDimmingStartHours">
              {t('settings.node_dimming_start_hours')}
              <span className="setting-description">{t('settings.node_dimming_start_hours_description')}</span>
            </label>
            <NumberInput
              id="nodeDimmingStartHours"
              min={startRange.min}
              max={startRange.max}
              step={startRange.step}
              value={startHours}
              onChange={onStartHoursChange}
              disabled={disabled}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="nodeDimmingMinOpacity">
              {t('settings.node_dimming_min_opacity')}
              <span className="setting-description">{t('settings.node_dimming_min_opacity_description')}</span>
            </label>
            <NumberInput
              id="nodeDimmingMinOpacity"
              min={opacityRange.min}
              max={opacityRange.max}
              step={opacityRange.step}
              value={minOpacity}
              onChange={onMinOpacityChange}
              disabled={disabled}
              className="setting-input"
            />
          </div>
        </>
      )}
    </>
  );
};

export default NodeDimmingSettings;
