import React, { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { ModuleAvailabilityContext } from './moduleAvailabilityContext';
import styles from './ModuleAvailabilityGate.module.css';

/**
 * The "this firmware build excludes the module" notice (#5065).
 *
 * Each gated section renders this directly after its own <h3>, so the notice
 * sits under the header it belongs to. When the gate drew it above the
 * section, it read as a warning about the section above (#5447).
 *
 * Renders nothing outside an excluding ModuleAvailabilityGate.
 */
const ModuleAvailabilityNotice: React.FC = () => {
  const { t } = useTranslation();
  const ctx = useContext(ModuleAvailabilityContext);

  if (!ctx) return null;

  return (
    <div className={styles.notice} role="status">
      <span className={styles.noticeIcon}><UiIcon name="alert" /></span>
      <span>
        {t(
          'module_availability.excluded',
          '{{module}} is not included in this device\'s firmware build, so these settings cannot be changed.',
          { module: ctx.moduleName }
        )}
      </span>
    </div>
  );
};

export default ModuleAvailabilityNotice;
