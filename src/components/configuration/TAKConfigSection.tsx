import React, { useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
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
  onSave: () => Promise<void>;
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

  // Track initial values for change detection
  const initialValuesRef = useRef({ team, role });

  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return team !== initial.team || role !== initial.role;
  }, [team, role]);

  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setTeam(initial.team);
    setRole(initial.role);
  }, [setTeam, setRole]);

  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = { team, role };
  }, [onSave, team, role]);

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
