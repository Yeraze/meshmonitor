/**
 * ConfigSection — protocol-neutral chrome for a config section (#5807).
 *
 * Renders the header bar (optional enable checkbox, icon, title, docs link,
 * right-hand actions), an optional notice slot (with the shared receive-only
 * note), and the body (description + children). It owns layout only: saving,
 * dirty tracking and the SaveBar stay in the section that uses it.
 *
 * `canWrite={false}` disables the enable checkbox and wraps the body in a
 * `<fieldset disabled>`, so every native control inside is disabled without
 * each input checking the permission. Header actions are outside the
 * fieldset; the caller gates them.
 *
 * `collapsible` adds a disclosure button around the title that hides the
 * body (#5818). The body stays mounted while hidden, so unsaved input
 * survives a collapse.
 */
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import { ReceiveOnlyNote } from './ReceiveOnlyNote';
import styles from './ConfigSection.module.css';

export interface ConfigSectionProps {
  title: React.ReactNode;
  /** Anchor id, placed on the header. */
  id?: string;
  /** Icon shown before the title. */
  icon?: React.ReactNode;
  /** Current enabled state; drives the checkbox and the body fade. */
  enabled?: boolean;
  /** When passed, a checkbox before the title toggles `enabled`. */
  onEnabledChange?: (enabled: boolean) => void;
  /** Accessible name for the enable checkbox. */
  enableLabel?: string;
  /** Docs page for this section; renders a help link after the title. */
  docsUrl?: string;
  /** Right-hand header slot (buttons, counts, switches). */
  headerActions?: React.ReactNode;
  /** Slot between the header and the body. */
  notice?: React.ReactNode;
  description?: React.ReactNode;
  /** Default true. False disables the enable checkbox and every body control. */
  canWrite?: boolean;
  /** Shows the paused note in the notice slot. */
  receiveOnly?: boolean;
  /** Replaces the default paused-note wording. */
  receiveOnlyNote?: React.ReactNode;
  /** Fade the body while disabled. Defaults to true when `enabled` is set. */
  fadeWhenDisabled?: boolean;
  /** Extra class on the body's inner container (the fieldset). */
  bodyClassName?: string;
  /** Title becomes a button that shows and hides the body. */
  collapsible?: boolean;
  /** With `collapsible`, start with the body hidden. Default false. */
  defaultCollapsed?: boolean;
  /** `danger` marks the header in the error colour (the shared DangerZone). */
  tone?: 'default' | 'danger';
  children?: React.ReactNode;
}

export const ConfigSection: React.FC<ConfigSectionProps> = ({
  title,
  id,
  icon,
  enabled,
  onEnabledChange,
  enableLabel,
  docsUrl,
  headerActions,
  notice,
  description,
  canWrite = true,
  receiveOnly = false,
  receiveOnlyNote,
  fadeWhenDisabled,
  bodyClassName,
  collapsible = false,
  defaultCollapsed = false,
  tone = 'default',
  children,
}) => {
  const { t } = useTranslation();
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed);
  const hidden = collapsible && collapsed;
  const fade = (fadeWhenDisabled ?? enabled !== undefined) && enabled === false;
  const docsTitle = t('automation.view_docs', 'View Documentation');

  return (
    <>
      <div
        id={id}
        className={`automation-section-header ${styles.header}${tone === 'danger' ? ` ${styles.danger}` : ''}`}
      >
        <h2 className={styles.title}>
          {onEnabledChange && (
            <input
              type="checkbox"
              className={styles.toggle}
              checked={!!enabled}
              disabled={!canWrite}
              onChange={(e) => onEnabledChange(e.target.checked)}
              aria-label={enableLabel}
            />
          )}
          {icon && <span className={styles.icon}>{icon}</span>}
          {collapsible ? (
            <button
              type="button"
              className={styles.collapseToggle}
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              onClick={() => setCollapsed((v) => !v)}
            >
              <UiIcon name={collapsed ? 'chevronRight' : 'chevronDown'} size={16} />
              {title}
            </button>
          ) : (
            title
          )}
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.docsLink}
              title={docsTitle}
              aria-label={docsTitle}
            >
              <UiIcon name="help" size={18} />
            </a>
          )}
        </h2>
        {headerActions && <div className={styles.actions}>{headerActions}</div>}
      </div>

      <ReceiveOnlyNote receiveOnly={receiveOnly}>{receiveOnlyNote}</ReceiveOnlyNote>
      {notice}

      <div
        id={collapsible ? bodyId : undefined}
        hidden={hidden}
        className={`settings-section ${styles.body}${fade ? ` ${styles.faded}` : ''}`}
      >
        <fieldset
          className={bodyClassName ? `${styles.fieldset} ${bodyClassName}` : styles.fieldset}
          disabled={!canWrite}
        >
          {description && <p className={styles.description}>{description}</p>}
          {children}
        </fieldset>
      </div>
    </>
  );
};

/** Small muted count for the header's right-hand slot, e.g. "3 triggers". */
export const ConfigHeaderCount: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className={styles.count}>{children}</span>
);

export default ConfigSection;
