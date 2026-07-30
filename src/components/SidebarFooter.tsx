/**
 * SidebarFooter — shared footer for the unified dashboard sidebar and the
 * per-source sidebar (issue #4436).
 *
 * One component renders the full link set — Users (admin only), Settings
 * (settings:read), News, GitHub, Discord, Website — so the two surfaces
 * cannot drift apart again. Permission gates are resolved by the caller and
 * passed as plain booleans because the two hosts use different auth shapes
 * (AuthContext hook vs. a hasPermission prop).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import packageJson from '../../package.json';
import { BrandIcon, UiIcon } from './icons';
import styles from './SidebarFooter.module.css';

export const MESHMONITOR_GITHUB_URL = 'https://github.com/Yeraze/meshmonitor';
export const MESHMONITOR_DISCORD_URL = 'https://discord.gg/JVR3VBETQE';
export const MESHMONITOR_WEBSITE_URL = 'https://meshmonitor.org';

export interface SidebarFooterProps {
  /** Shows the Users link. */
  isAdmin: boolean;
  /** Shows the Settings link (settings:read). */
  canReadSettings: boolean;
  /** Navigates to user administration. */
  onUsersClick: () => void;
  /** Navigates to settings. */
  onSettingsClick: () => void;
  /** Opens the News popup. The button renders disabled when absent. */
  onNewsClick?: () => void;
  /** Hides the version line (per-source sidebar collapsed state). */
  hideVersion?: boolean;
  /** Pins the footer to the bottom of a flex-column sidebar. */
  pinToBottom?: boolean;
  /** Hides the footer on short landscape screens (per-source sidebar). */
  hideOnCompactLandscape?: boolean;
}

const SidebarFooter: React.FC<SidebarFooterProps> = ({
  isAdmin,
  canReadSettings,
  onUsersClick,
  onSettingsClick,
  onNewsClick,
  hideVersion = false,
  pinToBottom = false,
  hideOnCompactLandscape = false,
}) => {
  const { t } = useTranslation();

  const footerClass = [
    styles.footer,
    pinToBottom ? styles.pinToBottom : '',
    hideOnCompactLandscape ? styles.hideOnCompactLandscape : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={footerClass}>
      {!hideVersion && <span className={styles.version}>v{packageJson.version}</span>}
      <div className={styles.icons}>
        {isAdmin && (
          <button
            className={styles.btn}
            title={t('source.sidebar.users')}
            onClick={onUsersClick}
          >
            <UiIcon name="users" size={18} />
          </button>
        )}
        {canReadSettings && (
          <button
            className={styles.btn}
            title={t('source.sidebar.settings')}
            onClick={onSettingsClick}
          >
            <UiIcon name="settings" size={18} />
          </button>
        )}
        <button
          className={styles.btn}
          title={t('source.sidebar.news')}
          onClick={onNewsClick}
          disabled={!onNewsClick}
        >
          <UiIcon name="news" size={18} />
        </button>
        <a
          className={styles.btn}
          href={MESHMONITOR_GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={t('source.sidebar.github')}
        >
          <BrandIcon brand="github" size={18} />
        </a>
        <a
          className={styles.btn}
          href={MESHMONITOR_DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={t('source.sidebar.discord', 'Discord')}
        >
          <BrandIcon brand="discord" size={18} />
        </a>
        <a
          className={styles.btn}
          href={MESHMONITOR_WEBSITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={t('source.sidebar.website')}
        >
          <UiIcon name="link" size={18} />
        </a>
      </div>
    </div>
  );
};

export default SidebarFooter;
