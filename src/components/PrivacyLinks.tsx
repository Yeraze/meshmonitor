/**
 * `PrivacyLinks` — the operator's disclosure link strip (#5156).
 *
 * One component so the sidebar footer, the login page and the embed map cannot
 * drift apart. Renders nothing at all when the operator has configured no
 * links, which is the default: a homelab instance should not grow a legal
 * footer it never asked for.
 *
 * Hosted documents open in the same tab (they are a route of this app);
 * external URLs open in a new tab with `rel="noopener noreferrer"`.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { usePrivacyLinks, privacyLinkHref, isExternalPrivacyLink } from '../hooks/usePrivacyLinks';
import { PRIVACY_LINK_FALLBACK_LABEL, type PrivacyLink } from '../types/privacy';
import styles from './PrivacyLinks.module.css';

export interface PrivacyLinksProps {
  /**
   * Basename to prefix hosted-document hrefs with. The main app passes its
   * router basename; the embed bundle passes the app's base URL so its link
   * escapes the iframe-friendly embed bundle into the real page.
   */
  basename?: string;
  /** Forces a new tab even for hosted documents (used by the embed). */
  alwaysNewTab?: boolean;
  /** Extra class on the wrapper, for surface-specific spacing. */
  className?: string;
}

const PrivacyLinks: React.FC<PrivacyLinksProps> = ({
  basename = '',
  alwaysNewTab = false,
  className,
}) => {
  const { t } = useTranslation();
  const { links } = usePrivacyLinks();

  if (links.length === 0) return null;

  const label = (link: PrivacyLink): string =>
    // A hosted document's own title wins — the operator named it. Otherwise
    // fall back to the translated generic label.
    link.title?.trim() ||
    t(`privacy.link.${link.slug}`, PRIVACY_LINK_FALLBACK_LABEL[link.slug]);

  return (
    <nav
      className={[styles.links, className].filter(Boolean).join(' ')}
      aria-label={t('privacy.links_label', 'Site policies')}
    >
      {links.map((link) => {
        const external = isExternalPrivacyLink(link);
        const newTab = external || alwaysNewTab;
        return (
          <a
            key={link.slug}
            className={styles.link}
            href={privacyLinkHref(link, basename)}
            {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {label(link)}
          </a>
        );
      })}
    </nav>
  );
};

export default PrivacyLinks;
