import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreAdvertMode } from '../../types/meshcoreAdvert';
import { UiIcon } from '../icons';
import styles from './MeshCoreAdvertModeField.module.css';

interface MeshCoreAdvertModeFieldProps {
  value: MeshCoreAdvertMode;
  onChange: (mode: MeshCoreAdvertMode) => void;
  disabled?: boolean;
}

/**
 * Zero-hop / Flood choice for an AUTOMATED advert (auto-announce burst, timer
 * trigger). While Flood is selected, its airtime cost and the server-side
 * floor (one automated flood per hour per source) show right under it.
 */
export const MeshCoreAdvertModeField: React.FC<MeshCoreAdvertModeFieldProps> = ({ value, onChange, disabled = false }) => {
  const { t } = useTranslation();
  const name = useId();

  return (
    <fieldset className={styles.field}>
      <legend className={styles.legend}>{t('meshcore.advert.mode_label', 'Advert reach')}</legend>
      <label className={styles.option}>
        <input
          type="radio"
          name={name}
          value="zero_hop"
          checked={value === 'zero_hop'}
          onChange={() => onChange('zero_hop')}
          disabled={disabled}
        />
        <span>{t('meshcore.advert.mode_zero_hop', 'Zero-hop (nearby nodes only)')}</span>
      </label>
      <label className={styles.option}>
        <input
          type="radio"
          name={name}
          value="flood"
          checked={value === 'flood'}
          onChange={() => onChange('flood')}
          disabled={disabled}
        />
        <span>{t('meshcore.advert.mode_flood', 'Flood (whole mesh, costly)')}</span>
      </label>
      {value === 'flood' && (
        <div className={styles.warning} role="note">
          <UiIcon name="alert" size={14} />
          <span>
            {t(
              'meshcore.advert.flood_automated_warning',
              'Flood adverts are repeated by every repeater within 8 hops: with 20 repeaters in reach about 9 s (US) / 25 s (EU) of channel time each. Automated flood adverts run at most once per hour per source; extra floods are skipped.',
            )}
          </span>
        </div>
      )}
    </fieldset>
  );
};
