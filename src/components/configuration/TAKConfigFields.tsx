import React from 'react';
import { useTranslation } from 'react-i18next';
import { TAK_ROLE_OPTIONS, TAK_TEAM_OPTIONS } from '../../utils/takConfig';
import styles from './TAKConfigSection.module.css';

interface TAKConfigFieldsProps {
  team: number;
  role: number;
  onChange: (field: 'team' | 'role', value: number) => void;
  disabled: boolean;
  /** Prefix for the control ids, so the Config and Admin copies do not clash. */
  idPrefix: string;
}

/**
 * The TAK team and role pickers plus their two notes (#5613). Shared by the
 * Configuration tab section and the Admin Commands (remote admin) section.
 *
 * Options come from `enum Team` / `enum MemberRole` in the pinned protobufs
 * (see `utils/takConfig.ts`).
 */
const TAKConfigFields: React.FC<TAKConfigFieldsProps> = ({ team, role, onChange, disabled, idPrefix }) => {
  const { t } = useTranslation();

  return (
    <>
      <p className={styles.note} data-testid={`${idPrefix}-role-note`}>
        {t('tak_config.tracker_only_note')}
      </p>
      <p className={styles.note} data-testid={`${idPrefix}-reboot-note`}>
        {t('tak_config.reboot_note')}
      </p>

      <div className="setting-item">
        <label htmlFor={`${idPrefix}Team`}>
          {t('tak_config.team')}
          <span className="setting-description">{t('tak_config.team_description')}</span>
        </label>
        <select
          id={`${idPrefix}Team`}
          className="setting-input"
          value={team}
          onChange={(e) => onChange('team', Number(e.target.value))}
          disabled={disabled}
        >
          {TAK_TEAM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(`tak_config.team_option_${o.name}`, o.label)}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-item">
        <label htmlFor={`${idPrefix}Role`}>
          {t('tak_config.role')}
          <span className="setting-description">{t('tak_config.role_description')}</span>
        </label>
        <select
          id={`${idPrefix}Role`}
          className="setting-input"
          value={role}
          onChange={(e) => onChange('role', Number(e.target.value))}
          disabled={disabled}
        >
          {TAK_ROLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(`tak_config.role_option_${o.name}`, o.label)}
            </option>
          ))}
        </select>
      </div>
    </>
  );
};

export default TAKConfigFields;
