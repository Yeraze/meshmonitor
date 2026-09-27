/**
 * Settings -> Node Display: sign-flipped position correction (#5363).
 *
 * Controlled by SettingsTab's draft. The range is stored in km and shown in
 * the user's distance unit; it is clamped on save, not per keystroke, so
 * typing "250" does not snap to the minimum after the first digit.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { kmToMiles } from '../../utils/distance';
import { SIGN_FLIP_RANGE_KM, clampSignFlipRangeKm, isSignFlipReferenceValid } from '../../utils/signFlipPosition';
import type { DistanceUnit } from '../../contexts/SettingsContext';
import styles from './SignFlipCorrectionSettings.module.css';

const KM_PER_MILE = 1 / kmToMiles(1);

export interface SignFlipCorrectionSettingsProps {
  enabled: boolean;
  rangeKm: number;
  referenceLatitude: string;
  referenceLongitude: string;
  distanceUnit: DistanceUnit;
  onEnabledChange: (value: boolean) => void;
  onRangeKmChange: (value: number) => void;
  onReferenceLatitudeChange: (value: string) => void;
  onReferenceLongitudeChange: (value: string) => void;
}

export const SignFlipCorrectionSettings: React.FC<SignFlipCorrectionSettingsProps> = ({
  enabled,
  rangeKm,
  referenceLatitude,
  referenceLongitude,
  distanceUnit,
  onEnabledChange,
  onRangeKmChange,
  onReferenceLatitudeChange,
  onReferenceLongitudeChange,
}) => {
  const { t } = useTranslation();
  const isMiles = distanceUnit === 'mi';
  const unitLabel = isMiles ? 'mi' : 'km';
  const displayRange = Math.round(isMiles ? kmToMiles(rangeKm) : rangeKm);
  const displayMin = Math.ceil(isMiles ? kmToMiles(SIGN_FLIP_RANGE_KM.min) : SIGN_FLIP_RANGE_KM.min);
  const displayMax = Math.floor(isMiles ? kmToMiles(SIGN_FLIP_RANGE_KM.max) : SIGN_FLIP_RANGE_KM.max);
  const referenceValid = isSignFlipReferenceValid(referenceLatitude, referenceLongitude);

  return (
    <div className={styles.section} data-testid="sign-flip-settings">
      <h4 className={styles.heading}>
        <UiIcon name="location" /> {t('settings.sign_flip.title', 'Sign-flipped positions')}
      </h4>

      <div className="setting-item">
        <label className={styles.checkboxLabel}>
          <input
            id="signFlipCorrectionEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
          />
          {t('settings.sign_flip.enabled', 'Correct sign-flipped positions')}
        </label>
        <p className="setting-description">
          {t(
            'settings.sign_flip.help',
            'Some operators type their coordinates without the minus sign, which puts the node on the other side of the globe. When a node is outside the range below but exactly one mirror of its position (latitude, longitude, or both negated) is inside it, the maps show the mirror point and the node details say so. The stored position is never changed.',
          )}
        </p>
      </div>

      <div className="setting-item">
        <label htmlFor="signFlipCorrectionRange">
          {t('settings.sign_flip.range_label', 'Range ({{unit}})', { unit: unitLabel })}
        </label>
        <input
          id="signFlipCorrectionRange"
          type="number"
          min={displayMin}
          max={displayMax}
          step="1"
          disabled={!enabled}
          value={displayRange}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!Number.isNaN(v)) onRangeKmChange(isMiles ? v * KM_PER_MILE : v);
          }}
          onBlur={() => onRangeKmChange(clampSignFlipRangeKm(rangeKm))}
          className="setting-input"
        />
        <p className={`setting-description ${styles.warning}`}>
          {t(
            'settings.sign_flip.range_warning',
            'Keep this small. A wide range can move a genuine far-away node (for example one heard over MQTT) whose mirror point happens to fall inside it.',
          )}
        </p>
      </div>

      <div className="setting-item">
        <span className={styles.referenceLabel}>
          {t('settings.sign_flip.reference_label', 'Reference point (optional)')}
        </span>
        <div className={styles.referenceRow}>
          <input
            id="signFlipReferenceLatitude"
            type="text"
            inputMode="decimal"
            disabled={!enabled}
            value={referenceLatitude}
            placeholder={t('settings.sign_flip.latitude_placeholder', 'Latitude')}
            aria-label={t('settings.sign_flip.latitude_placeholder', 'Latitude')}
            onChange={(e) => onReferenceLatitudeChange(e.target.value)}
            className={`setting-input ${styles.coordInput}`}
          />
          <input
            id="signFlipReferenceLongitude"
            type="text"
            inputMode="decimal"
            disabled={!enabled}
            value={referenceLongitude}
            placeholder={t('settings.sign_flip.longitude_placeholder', 'Longitude')}
            aria-label={t('settings.sign_flip.longitude_placeholder', 'Longitude')}
            onChange={(e) => onReferenceLongitudeChange(e.target.value)}
            className={`setting-input ${styles.coordInput}`}
          />
        </div>
        <p className="setting-description">
          {t(
            'settings.sign_flip.reference_help',
            "Leave blank to use this source's own node position. Sources without a node of their own (MQTT) need a point here, or nothing is corrected.",
          )}
        </p>
        {!referenceValid && (
          <p className={`setting-description ${styles.error}`} data-testid="sign-flip-reference-invalid">
            {t(
              'settings.sign_flip.reference_invalid',
              'Enter both latitude (-90 to 90) and longitude (-180 to 180), or leave both blank. An incomplete point is ignored.',
            )}
          </p>
        )}
      </div>
    </div>
  );
};

export default SignFlipCorrectionSettings;
