/**
 * Privacy disclosure types shared by the main app bundle and the embed bundle
 * (#5156).
 *
 * Kept out of the server tree on purpose: `EmbedMap` and the standalone
 * document page both need these, and the embed entry point must not drag
 * server modules into its bundle.
 */

/** The three documents an operator can publish. Also the URL segment. */
export const PRIVACY_DOCUMENT_SLUGS = ['privacy', 'terms', 'contact'] as const;
export type PrivacyDocumentSlug = (typeof PRIVACY_DOCUMENT_SLUGS)[number];

/** True when an arbitrary string is one of the three known slugs. */
export function isPrivacyDocumentSlug(value: unknown): value is PrivacyDocumentSlug {
  return typeof value === 'string' && (PRIVACY_DOCUMENT_SLUGS as readonly string[]).includes(value);
}

/**
 * One resolved disclosure link.
 *
 * `kind: 'hosted'` means the operator wrote the document inside MeshMonitor;
 * the client links to `/privacy/:slug` under its own basename. `kind: 'url'`
 * means they pointed at an external page and `href` is an http(s) URL the
 * server has already validated.
 */
export interface PrivacyLink {
  slug: PrivacyDocumentSlug;
  kind: 'hosted' | 'url';
  href?: string;
  title?: string;
}

/** A hosted document as served to anonymous readers. */
export interface PrivacyDocumentPayload {
  slug: PrivacyDocumentSlug;
  title: string;
  /** Markdown source. Rendered with raw HTML disabled — never inject as HTML. */
  content: string;
  /**
   * Unix timestamp in MILLISECONDS (the DB column is BIGINT ms, matching
   * `Date.now()`). Pass straight to `new Date(...)`; do NOT multiply by 1000.
   */
  updatedAt: number;
}

/** A hosted document as served to the settings editor. */
export interface PrivacyDocumentAdmin extends PrivacyDocumentPayload {
  id: number;
  updatedBy: string | null;
  createdAt: number;
}

/** Default link labels, keyed by slug. Overridden by i18n at the call site. */
export const PRIVACY_LINK_FALLBACK_LABEL: Record<PrivacyDocumentSlug, string> = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Service',
  contact: 'Contact',
};
