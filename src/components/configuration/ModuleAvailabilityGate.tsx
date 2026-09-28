import React, { useMemo } from 'react';
import { ModuleAvailabilityContext } from './moduleAvailabilityContext';
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
 * excluded from its firmware build, switches the controls off (#5065).
 *
 * The gate does not draw the notice itself: the section renders
 * <ModuleAvailabilityNotice /> right after its <h3>, so the notice sits under
 * its own header rather than under the section above (#5447).
 */
const ModuleAvailabilityGate: React.FC<ModuleAvailabilityGateProps> = ({
  available,
  moduleName,
  children,
}) => {
  const value = useMemo(() => ({ moduleName }), [moduleName]);

  if (available !== false) {
    return <>{children}</>;
  }

  return (
    <ModuleAvailabilityContext.Provider value={value}>
      <div className={styles.gated}>{children}</div>
    </ModuleAvailabilityContext.Provider>
  );
};

export default ModuleAvailabilityGate;
