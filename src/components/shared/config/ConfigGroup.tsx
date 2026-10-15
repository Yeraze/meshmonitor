/**
 * ConfigGroup — a titled group of fields inside a ConfigSection (#5816).
 *
 * Single-form automation sections (Auto Acknowledge, Auto Announce) split
 * their fields into the same named groups on both protocols, so a user who
 * knows one layout can find a field in the other. `name` is a stable,
 * untranslated key written to `data-config-group`; tests read the group
 * order from it.
 */
import React, { useId } from 'react';
import styles from './ConfigGroup.module.css';

export interface ConfigGroupProps {
  title: React.ReactNode;
  /** Stable key for the group, e.g. "trigger". Written to `data-config-group`. */
  name?: string;
  /** Short muted line under the heading. */
  hint?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export const ConfigGroup: React.FC<ConfigGroupProps> = ({
  title,
  name,
  hint,
  className,
  children,
}) => {
  const headingId = useId();
  return (
    <section
      className={className ? `${styles.group} ${className}` : styles.group}
      aria-labelledby={headingId}
      data-config-group={name}
    >
      <h3 id={headingId} className={styles.title}>{title}</h3>
      {hint && <p className={styles.hint}>{hint}</p>}
      {children}
    </section>
  );
};

export default ConfigGroup;
