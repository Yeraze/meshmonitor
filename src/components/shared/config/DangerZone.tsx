/**
 * DangerZone — the last section of a Device Configuration page (#5830).
 *
 * Meshtastic and MeshCore both end their device page with the actions that
 * restart the node or throw data away. This gives them one look: a
 * ConfigSection with a red header, a row of actions, and an optional note
 * under them (e.g. a link to where the other device actions live).
 *
 * It owns layout only. Each action asks for its own in-app confirm and gates
 * itself; `canWrite={false}` disables every control in the body through the
 * ConfigSection fieldset as a backstop.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import { ConfigSection } from './ConfigSection';
import styles from './DangerZone.module.css';

export interface DangerZoneProps {
  /** Anchor id on the header, for SectionNav and deep links. */
  id?: string;
  /** Defaults to "Danger zone". */
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Default true. False disables every control in the body. */
  canWrite?: boolean;
  /** Line under the actions, e.g. a link to Admin Commands. */
  footer?: React.ReactNode;
  /** The action buttons (use DangerZoneButton) and any inline panels. */
  children: React.ReactNode;
}

export const DangerZone: React.FC<DangerZoneProps> = ({
  id,
  title,
  description,
  canWrite = true,
  footer,
  children,
}) => {
  const { t } = useTranslation();
  return (
    <ConfigSection
      id={id}
      tone="danger"
      icon={<UiIcon name="alert" />}
      title={title ?? t('config.danger_zone', 'Danger zone')}
      description={description}
      canWrite={canWrite}
    >
      <div className={styles.body} data-testid="danger-zone">
        {children}
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </ConfigSection>
  );
};

export interface DangerZoneButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** `danger` (default) for actions that restart or erase; `plain` for the rest. */
  variant?: 'danger' | 'plain';
}

/** A button styled for the DangerZone action row. */
export const DangerZoneButton: React.FC<DangerZoneButtonProps> = ({
  variant = 'danger',
  className,
  ...rest
}) => (
  <button
    type="button"
    className={`${variant === 'danger' ? styles.dangerButton : styles.plainButton}${className ? ` ${className}` : ''}`}
    {...rest}
  />
);

/** Lays out DangerZoneButtons in one wrapping row. */
export const DangerZoneActions: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className={styles.actions}>{children}</div>
);

export default DangerZone;
