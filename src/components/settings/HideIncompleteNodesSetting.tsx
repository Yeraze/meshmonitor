/**
 * Settings -> Node Display: "hide incomplete nodes" checkbox (#6258).
 *
 * Controlled, presentational. Shared by SettingsTab (Meshtastic) and
 * MeshCoreNodeDisplaySection. Only the completeness logic differs by protocol
 * (isNodeComplete vs isMeshCoreRowComplete), so callers pass their own hint.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './HideIncompleteNodesSetting.module.css';

export interface HideIncompleteNodesSettingProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Read-only form (no settings:write). */
  disabled?: boolean;
  /** Replaces the default description under the checkbox. */
  description?: string;
}

export const HideIncompleteNodesSetting: React.FC<HideIncompleteNodesSettingProps> = ({
  checked,
  onChange,
  disabled = false,
  description,
}) => {
  const { t } = useTranslation();
  return (
    <div className={`setting-item ${styles.item}`}>
      <label>
        <span className={styles.toggleRow}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          {t('settings.hide_incomplete_nodes')}
        </span>
        <span className="setting-description">
          {description ?? t('settings.hide_incomplete_description')}
        </span>
      </label>
    </div>
  );
};

export default HideIncompleteNodesSetting;
