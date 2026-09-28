import React, { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { ModuleAvailabilityContext } from './moduleAvailabilityContext';
import styles from './ModuleAvailabilityGate.module.css';

interface ModuleAvailabilityNoticeProps {
  /**
   * Optional extra sentence that says why the module is missing, e.g. Range
   * Test's removal in firmware 2.8. A section with its own "why" notice passes
   * it here instead of drawing a second notice under the gate's one.
   */
  detail?: string;
}

/**
 * The "this firmware build excludes the module" notice (#5065).
 *
 * Each gated section renders this directly after its own <h3>, so the notice
 * sits under the header it belongs to. When the gate drew it above the
 * section, it read as a warning about the section above (#5447).
 *
 * Renders nothing outside an excluding ModuleAvailabilityGate.
 */
const ModuleAvailabilityNotice: React.FC<ModuleAvailabilityNoticeProps> = ({ detail }) => {
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
        {detail ? ` ${detail}` : null}
      </span>
    </div>
  );
};

export default ModuleAvailabilityNotice;
