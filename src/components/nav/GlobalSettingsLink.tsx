/**
 * A link to the install-wide Global Settings page (`/settings`) from inside a
 * source page (#5683 follow-up).
 *
 * MeshCore and Reticulum source pages had no way to reach Global Settings:
 * their nav has no footer, and their gear opens the source's own Settings.
 * This is that link, in two shapes:
 *
 *   rail    the foot of the source nav, where the Meshtastic sidebar keeps its
 *           footer links. Icon only in the collapsed rail, icon and label in
 *           the expanded one.
 *   inline  one line on the source's Settings page. The phone layout docks the
 *           nav as a bottom bar with no foot, so the rail link is not there.
 *
 * The icon and the label come from GLOBAL_SETTINGS_NAV_ENTRY, so every link to
 * that page reads "Global Settings" and no per-source gear does.
 *
 * Shown to a viewer who may read settings on any source: the same rule the
 * dashboard footer uses for its link to the same page.
 */
import React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { UiIcon } from '../icons';
import { GLOBAL_SETTINGS_PATH, globalSettingsNav } from './sourceNavEntries';
import styles from './GlobalSettingsLink.module.css';

export interface GlobalSettingsLinkProps {
  variant?: 'rail' | 'inline';
  /** Rail only: the nav is collapsed, so show the icon alone. */
  collapsed?: boolean;
}

export const GlobalSettingsLink: React.FC<GlobalSettingsLinkProps> = ({
  variant = 'rail',
  collapsed = false,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  // The app always renders this inside its router. Rendered on its own (a
  // unit test of a host nav) it falls back to a plain anchor.
  const inRouter = useInRouterContext();
  if (!hasPermission('settings', 'read', { anySource: true })) return null;

  const { icon, label } = globalSettingsNav(t);

  if (variant === 'inline') {
    return (
      <p className={styles.inline} data-testid="global-settings-link-inline">
        <span>
          {t(
            'nav.global_settings_hint',
            'Language, units, map and other install-wide settings are in',
          )}
        </span>{' '}
        {inRouter ? (
          <Link className={styles.inlineLink} to={GLOBAL_SETTINGS_PATH}>
            <UiIcon name={icon} size={14} /> {label}
          </Link>
        ) : (
          <a className={styles.inlineLink} href={GLOBAL_SETTINGS_PATH}>
            <UiIcon name={icon} size={14} /> {label}
          </a>
        )}
      </p>
    );
  }

  const railProps = {
    className: `${styles.rail} ${collapsed ? styles.collapsed : ''}`.trim(),
    title: label,
    'aria-label': label,
    'data-testid': 'global-settings-link',
  };
  const railBody = (
    <>
      <UiIcon name={icon} size={18} />
      {!collapsed && <span className={styles.railLabel}>{label}</span>}
    </>
  );
  return inRouter
    ? <Link {...railProps} to={GLOBAL_SETTINGS_PATH}>{railBody}</Link>
    : <a {...railProps} href={GLOBAL_SETTINGS_PATH}>{railBody}</a>;
};

export default GlobalSettingsLink;
