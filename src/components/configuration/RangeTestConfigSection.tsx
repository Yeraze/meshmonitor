import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { UiIcon } from '../icons';
import styles from './RangeTestConfigSection.module.css';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';
import { useModuleExcluded } from './moduleAvailabilityContext';

interface RangeTestConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  sender: number;
  setSender: (value: number) => void;
  save: boolean;
  setSave: (value: boolean) => void;
  /**
   * True when the connected node's firmware no longer carries the Range Test
   * module — it was removed in Meshtastic 2.8 (#5031). The section stays
   * visible with an explanatory notice rather than disappearing, so users don't
   * conclude MeshMonitor broke. Defaults to false, which is also what an
   * unknown firmware version resolves to: fail open to the old behaviour.
   */
  isDisabled?: boolean;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
}

const RangeTestConfigSection: React.FC<RangeTestConfigSectionProps> = ({
  enabled,
  setEnabled,
  sender,
  setSender,
  save,
  setSave,
  isDisabled = false,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  // A 2.8 build also reports Range Test in excluded_modules, so the gate is
  // usually active too. Then the gate's notice carries the 2.8 context and ours
  // stays hidden: two notices saying the same thing read as noise.
  const gateExcluded = useModuleExcluded();

  // What the node holds; moves on a successful save (#5797)
  const values = {
    enabled, sender, save
  };
  const { baseline, hasChanges, commit } = useSectionBaseline(values);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setEnabled(baseline.enabled);
    setSender(baseline.sender);
    setSave(baseline.save);
  }, [baseline, setEnabled, setSender, setSave]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar. A removed module must never offer a save — the
  // firmware would drop the admin message silently.
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'rangetest-config',
    sectionName: t('rangetest_config.title'),
    hasChanges: hasChanges && !isDisabled,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  return (
    <NumberInputScope scope={numberScope}>
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('rangetest_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/range-test/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('rangetest_config.view_docs')}
        >
          ?
        </a>
      </h3>
      <ModuleAvailabilityNotice
        detail={isDisabled ? t('rangetest_config.removed_in_28_detail', 'It was removed from Meshtastic firmware in 2.8.') : undefined}
      />

      {isDisabled && !gateExcluded && (
        <div className={styles.removedNotice} role="status">
          <span className={styles.removedNoticeIcon}><UiIcon name="alert" /></span>
          <span>
            {t(
              'rangetest_config.removed_in_28',
              'Range Test was removed in Meshtastic 2.8 and is not available on this firmware. These settings cannot be changed.'
            )}
          </span>
        </div>
      )}

      {/* The gate already greys its section out; a second opacity would stack. */}
      <div className={isDisabled && !gateExcluded ? styles.disabledControls : undefined}>
        {/* Enable Module */}
        <div className="setting-item">
          <label htmlFor="rangetestEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              id="rangetestEnabled"
              type="checkbox"
              checked={enabled}
              disabled={isDisabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ marginTop: '0.2rem', flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('rangetest_config.enabled')}</div>
              <span className="setting-description">{t('rangetest_config.enabled_description')}</span>
            </div>
          </label>
        </div>

        {enabled && (
          <>
            {/* Sender Interval */}
            <div className="setting-item">
              <label htmlFor="rangetestSender">
                {t('rangetest_config.sender')}
                <span className="setting-description">{t('rangetest_config.sender_description')}</span>
              </label>
              <NumberInput
                id="rangetestSender"
                min={0}
                max={65535}
                value={sender}
                disabled={isDisabled}
                integer
                onChange={setSender}
                className="setting-input"
                placeholder="0"
              />
            </div>

            {/* Save Results */}
            <div className="setting-item">
              <label htmlFor="rangetestSave" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  id="rangetestSave"
                  type="checkbox"
                  checked={save}
                  disabled={isDisabled}
                  onChange={(e) => setSave(e.target.checked)}
                  style={{ marginTop: '0.2rem', flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>{t('rangetest_config.save')}</div>
                  <span className="setting-description">{t('rangetest_config.save_description')}</span>
                </div>
              </label>
            </div>
          </>
        )}
      </div>
    </div>
    </NumberInputScope>
  );
};

export default RangeTestConfigSection;
