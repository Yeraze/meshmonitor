/**
 * ReticulumSettingsView — the per-source Settings tab of a Reticulum source.
 *
 * MeshMonitor keeps no per-source setting for a Reticulum source yet. The one
 * control this tab used to hold, the destination retention cap, applies to
 * every Reticulum source, so it moved to Global Settings (#5683 follow-up; see
 * `settings/ReticulumRetentionSection.tsx`). What is left is a pointer to it.
 * The tab stays so a future per-source setting has a home and the nav matches
 * every other source type.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MovedSettingNote } from '../common/MovedSettingNote';
import { GLOBAL_SETTINGS_PATH } from '../nav/sourceNavEntries';
import { GlobalSettingsLink } from '../nav/GlobalSettingsLink';
import { RETICULUM_SETTINGS_SECTION_ID } from '../settings/ReticulumRetentionSection';
import styles from './ReticulumSettingsView.module.css';

interface ReticulumSettingsViewProps {
  /** Source UUID. Unused today: nothing on this tab is per-source yet. */
  sourceId: string;
}

export const ReticulumSettingsView: React.FC<ReticulumSettingsViewProps> = ({ sourceId: _sourceId }) => {
  const { t } = useTranslation();

  return (
    <div className={styles.view} data-testid="reticulum-settings-view">
      <h2 className={styles.title}>{t('nav.settings', 'Settings')}</h2>
      <GlobalSettingsLink variant="inline" />
      <p className={styles.empty}>
        {t(
          'reticulum.settings.none_per_source',
          'MeshMonitor has no settings of its own for this Reticulum source yet.',
        )}
      </p>
      <MovedSettingNote
        testId="reticulum-retention-moved"
        text={t(
          'moved.reticulum_retention',
          'The destination retention cap applies to every Reticulum source, so it moved to Global Settings.',
        )}
        linkLabel={t('moved.open_global_settings', 'Open Global Settings')}
        to={`${GLOBAL_SETTINGS_PATH}#${RETICULUM_SETTINGS_SECTION_ID}`}
      />
    </div>
  );
};

export default ReticulumSettingsView;
