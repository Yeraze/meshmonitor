/**
 * `usePrivacyLinks` — the operator's disclosure links, for any surface that
 * renders them (#5156).
 *
 * Used by the sidebar footer, the login page, the standalone document page and
 * the embed map. Fetched once per mount from the unauthenticated
 * `/api/privacy/links`, so it works on the login screen and inside the
 * tokenless embed bundle alike.
 *
 * Never rejects: `apiService.getPrivacyLinks()` swallows its own errors and
 * returns `[]`. A footer that throws would take down the page it decorates,
 * and "no links configured" and "the request failed" should look identical to
 * a visitor either way.
 */
import { useEffect, useState } from 'react';
import apiService from '../services/api';
import type { PrivacyLink, PrivacyDocumentSlug } from '../types/privacy';

/**
 * Build the href for one link.
 *
 * External URLs are returned as-is (the server has already checked they are
 * http(s)). Hosted documents resolve to `<basename>/privacy/<slug>` — the
 * basename is passed in rather than imported so the embed bundle, which links
 * out of itself into the main app, can supply its own.
 */
export function privacyLinkHref(link: PrivacyLink, basename = ''): string {
  if (link.kind === 'url') return link.href ?? '#';
  const base = basename.replace(/\/$/, '');
  return `${base}/privacy/${link.slug}`;
}

/** True when the link leaves this origin and needs `target="_blank"`. */
export function isExternalPrivacyLink(link: PrivacyLink): boolean {
  return link.kind === 'url';
}

export interface UsePrivacyLinksResult {
  links: PrivacyLink[];
  loading: boolean;
}

export function usePrivacyLinks(): UsePrivacyLinksResult {
  const [links, setLinks] = useState<PrivacyLink[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void apiService
      .getPrivacyLinks()
      .then((result) => {
        if (!cancelled) setLinks(result);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { links, loading };
}

/** Look up one slug in a resolved link set. */
export function findPrivacyLink(
  links: PrivacyLink[],
  slug: PrivacyDocumentSlug,
): PrivacyLink | undefined {
  return links.find((l) => l.slug === slug);
}
