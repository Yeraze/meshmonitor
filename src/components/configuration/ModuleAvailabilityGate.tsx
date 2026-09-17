import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import styles from './ModuleAvailabilityGate.module.css';

interface ModuleAvailabilityGateProps {
  /**
   * False only when the device's DeviceMetadata says this build excluded the
   * module. Undefined (an older firmware, or config not loaded yet) leaves the
   * section untouched — see the fail-open rule in #5065.
   */
  available?: boolean;
  /** Section name, used in the notice. */
  moduleName: string;
  children: React.ReactNode;
}

/**
 * Wraps a module config section and, when the device reports the module as
 * excluded from its firmware build, shows a notice and switches the controls
 * off (#5065).
 */
const ModuleAvailabilityGate: React.FC<ModuleAvailabilityGateProps> = ({
  available,
  moduleName,
  children,
}) => {
  const { t } = useTranslation();

  if (available !== false) {
    return <>{children}</>;
  }

  return (
    <>
      <div className={styles.notice} role="status">
        <span className={styles.noticeIcon}><UiIcon name="alert" /></span>
        <span>
          {t(
            'module_availability.excluded',
            '{{module}} is not included in this device\'s firmware build, so these settings cannot be changed.',
            { module: moduleName }
          )}
        </span>
      </div>
      <div className={styles.disabledControls}>{children}</div>
    </>
  );
};

export default ModuleAvailabilityGate;
