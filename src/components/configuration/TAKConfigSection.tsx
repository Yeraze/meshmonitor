import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import TAKConfigFields from './TAKConfigFields';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';
import styles from './TAKConfigSection.module.css';

interface TAKConfigSectionProps {
  team: number;
  setTeam: (value: number) => void;
  role: number;
  setRole: (value: number) => void;
  /** Firmware older than 2.8.0: the node drops this config. */
  isDisabled: boolean;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
}

/**
 * TAK team colour and member role (#5613): `ModuleConfig.TAKConfig`,
 * firmware 2.8.0+. The node sends them in its TAK position report, which it
 * builds only when its device role is TAK_TRACKER.
 */
const TAKConfigSection: React.FC<TAKConfigSectionProps> = ({
  team,
  setTeam,
  role,
  setRole,
  isDisabled,
  isSaving,
  onSave,
}) => {
  const { t } = useTranslation();

  // What the node holds; moves on a successful save (#5797)
  const values = { team, role };
  const { baseline, hasChanges, commit } = useSectionBaseline(values);

  const resetChanges = useCallback(() => {
    setTeam(baseline.team);
    setRole(baseline.role);
  }, [baseline, setTeam, setRole]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  useSaveBar({
    id: 'tak-config',
    sectionName: t('tak_config.title'),
    hasChanges: hasChanges && !isDisabled,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  return (
    <div className="settings-section">
      <h3>{t('tak_config.title')}</h3>
      <ModuleAvailabilityNotice />

      {isDisabled && (
        <div className={styles.unsupported} data-testid="tak-config-unsupported">
          {t('tak_config.unsupported')}
        </div>
      )}

      <div className={isDisabled ? styles.dimmed : undefined}>
        <TAKConfigFields
          team={team}
          role={role}
          onChange={(field, value) => (field === 'team' ? setTeam(value) : setRole(value))}
          disabled={isDisabled}
          idPrefix="takConfig"
        />
      </div>
    </div>
  );
};

export default TAKConfigSection;
