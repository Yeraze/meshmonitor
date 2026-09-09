/**
 * Privacy disclosure routes (#5156).
 *
 * A publicly-reachable MeshMonitor re-serves mesh data to anonymous visitors
 * and, through `embedPublicRoutes`, to viewers with no session at all. The
 * operator needs somewhere to disclose the privacy policy that applies. Each
 * of the three documents ('privacy' | 'terms' | 'contact') resolves one of
 * three ways:
 *
 *   1. an operator-hosted document in `privacy_documents`  → `{ kind: 'hosted' }`
 *   2. else a URL in the matching global setting            → `{ kind: 'url' }`
 *   3. else nothing — the client renders no link at all.
 *
 * Hosted wins over URL deliberately: an operator who bothered to write the
 * document in MeshMonitor meant it to be the canonical copy.
 *
 * ## Two routers, two audiences
 *
 * `privacyPublicRouter` is mounted BEFORE the api router, so it carries no
 * auth and no CSRF — the whole point is that a logged-out visitor can read
 * the policy. It exposes only two GETs and calls `next()` on anything else,
 * so `/api/privacy/admin/*` falls through to the authenticated router.
 *
 * `privacyAdminRouter` is mounted INSIDE the api router and is therefore
 * behind rate limiting, CSRF and `requirePermission('settings', …)`.
 *
 * ## Why the hosted body is Markdown
 *
 * `content` is Markdown source and is rendered client-side by `react-markdown`
 * with raw-HTML passthrough disabled. Accepting HTML here would be stored XSS
 * on an origin that anonymous visitors and embed viewers load, so the write
 * path rejects anything that looks like a full HTML document and the read path
 * never sets a text/html content type.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import {
  PRIVACY_DOCUMENT_SLUGS,
  type PrivacyDocumentSlug,
} from '../../db/schema/privacyDocuments.js';
import { isPrivacyDocumentSlug } from '../../db/repositories/privacyDocuments.js';

/** Settings key holding the external URL for each slug. */
const URL_SETTING_KEY: Record<PrivacyDocumentSlug, string> = {
  privacy: 'privacyPolicyUrl',
  terms: 'termsOfServiceUrl',
  contact: 'contactUrl',
};

/**
 * Largest document we will store, in bytes of UTF-8. Sits deliberately above
 * MySQL's 64 KiB TEXT cap — the column is LONGTEXT, so the limit is a policy
 * choice rather than a silent truncation boundary.
 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/** Largest title we will store, matching the MySQL VARCHAR(255) column. */
export const MAX_TITLE_LENGTH = 255;

/**
 * Accept only `http:` and `https:` absolute URLs.
 *
 * These values are typed by an operator and rendered as an anchor `href` to
 * anonymous visitors, so a `javascript:` or `data:` URL here would be a
 * self-inflicted XSS. Validated on READ as well as on write, because a value
 * may predate this check or have been written straight to the settings table.
 */
export function isSafeExternalUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Reject content that is trying to be an HTML document rather than Markdown.
 *
 * This is not a sanitizer — `react-markdown` not rendering raw HTML is what
 * actually keeps the page safe. It is a guard against the honest mistake of
 * pasting an exported HTML policy and getting a page full of visible tags.
 */
export function looksLikeHtmlDocument(content: string): boolean {
  return /<\s*(!doctype\s+html|html|head|body|script|style|link|meta|iframe|object|embed|svg|form)\b/i.test(
    content,
  );
}

/** A rejected document, as `fail()` arguments. */
export interface DocumentRejection {
  status: number;
  code: string;
  message: string;
}

/**
 * Validate a document write. Pure, so the size and shape rules are testable
 * without driving them over HTTP.
 *
 * The size cap in particular is awkward to exercise through the route test
 * harness: the harness mounts a global `express.json()` at body-parser's
 * 100 KB default, while production mounts `express.json({ limit: '10mb' })`
 * (`server.ts`). Since body-parser skips once `req._body` is set, whichever
 * parser runs first wins — so a route-level parser here would be dead code,
 * and a 256 KB body never reaches the handler under the harness at all.
 *
 * @returns `null` when the document is acceptable.
 */
export function validateDocumentPayload(
  title: string,
  content: string,
): DocumentRejection | null {
  if (!title.trim()) {
    return { status: 400, code: 'PRIVACY_TITLE_REQUIRED', message: 'A document title is required' };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return {
      status: 400,
      code: 'PRIVACY_TITLE_TOO_LONG',
      message: `Title must be ${MAX_TITLE_LENGTH} characters or fewer`,
    };
  }
  if (!content.trim()) {
    return { status: 400, code: 'PRIVACY_CONTENT_REQUIRED', message: 'Document content is required' };
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    return {
      status: 413,
      code: 'PRIVACY_CONTENT_TOO_LARGE',
      message: `Document must be ${Math.floor(MAX_DOCUMENT_BYTES / 1024)} KB or smaller`,
    };
  }
  if (looksLikeHtmlDocument(content)) {
    return {
      status: 400,
      code: 'PRIVACY_CONTENT_NOT_MARKDOWN',
      message:
        'Documents are stored as Markdown. HTML tags are not rendered — paste or write Markdown instead.',
    };
  }
  return null;
}

/** One resolved link, as the clients consume it. */
export interface PrivacyLink {
  slug: PrivacyDocumentSlug;
  /** 'hosted' → render an in-app link to /privacy/:slug. 'url' → link out. */
  kind: 'hosted' | 'url';
  /** Only set for `kind: 'url'`. Always an http(s) absolute URL. */
  href?: string;
  /** Only set for `kind: 'hosted'`. The operator's document title. */
  title?: string;
}

/**
 * Resolve all three links. Shared by the public endpoint and by tests.
 *
 * Deliberately returns titles but never document bodies — an anonymous
 * visitor deciding whether a footer link exists does not need the policy
 * text shipped to them on every page load.
 */
export async function resolvePrivacyLinks(): Promise<PrivacyLink[]> {
  // Meta-only: this runs on every page load from three surfaces, and a
  // document can be 256 KB. Bodies are served by /documents/:slug alone.
  const hosted = await databaseService.privacyDocuments.getAllMetaAsync();
  const byslug = new Map(hosted.map((d) => [d.slug, d]));

  // The remaining URL lookups are independent, so issue them together rather
  // than awaiting each in turn.
  const needUrl = PRIVACY_DOCUMENT_SLUGS.filter((slug) => !byslug.has(slug));
  const urls = await Promise.all(
    needUrl.map((slug) => databaseService.settings.getSetting(URL_SETTING_KEY[slug])),
  );
  const urlBySlug = new Map(needUrl.map((slug, i) => [slug, urls[i]]));

  const links: PrivacyLink[] = [];
  for (const slug of PRIVACY_DOCUMENT_SLUGS) {
    const doc = byslug.get(slug);
    if (doc) {
      links.push({ slug, kind: 'hosted', title: doc.title });
      continue;
    }
    const url = urlBySlug.get(slug)?.trim();
    if (isSafeExternalUrl(url)) {
      links.push({ slug, kind: 'url', href: url });
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Public router — no auth, no CSRF. Mounted before the api router.
// ---------------------------------------------------------------------------

export const privacyPublicRouter: Router = Router();

/**
 * GET /api/privacy/links
 * Which disclosure links exist and how to reach them. Safe for anonymous
 * viewers and for the embed bundle; returns titles, never bodies.
 */
privacyPublicRouter.get('/links', async (_req: Request, res: Response) => {
  try {
    return ok(res, await resolvePrivacyLinks());
  } catch (error) {
    logger.error('[PrivacyRoutes] Failed to resolve privacy links:', error);
    return fail(res, 500, 'PRIVACY_LINKS_FAILED', 'Failed to load privacy links');
  }
});

/**
 * GET /api/privacy/documents/:slug
 * The Markdown source of one hosted document. Public by design.
 */
privacyPublicRouter.get('/documents/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  if (!isPrivacyDocumentSlug(slug)) {
    return fail(res, 400, 'INVALID_PRIVACY_SLUG', `Unknown document: ${slug}`);
  }
  try {
    const doc = await databaseService.privacyDocuments.getBySlugAsync(slug);
    if (!doc) {
      return fail(res, 404, 'PRIVACY_DOCUMENT_NOT_FOUND', 'No such document');
    }
    return ok(res, {
      slug: doc.slug,
      title: doc.title,
      content: doc.content,
      updatedAt: doc.updatedAt,
    });
  } catch (error) {
    logger.error(`[PrivacyRoutes] Failed to read privacy document "${slug}":`, error);
    return fail(res, 500, 'PRIVACY_DOCUMENT_FAILED', 'Failed to load document');
  }
});

// ---------------------------------------------------------------------------
// Admin router — mounted inside the api router (rate limit + CSRF + auth).
// ---------------------------------------------------------------------------

export const privacyAdminRouter: Router = Router();

/**
 * GET /api/privacy/admin/documents
 * Every hosted document, bodies included, for the settings editor.
 */
privacyAdminRouter.get(
  '/documents',
  requirePermission('settings', 'read'),
  async (_req: Request, res: Response) => {
    try {
      return ok(res, await databaseService.privacyDocuments.getAllAsync());
    } catch (error) {
      logger.error('[PrivacyRoutes] Failed to list privacy documents:', error);
      return fail(res, 500, 'PRIVACY_DOCUMENTS_FAILED', 'Failed to load documents');
    }
  },
);

/**
 * PUT /api/privacy/admin/documents/:slug
 * Create or replace one hosted document. Body: `{ title, content }`.
 */
privacyAdminRouter.put(
  '/documents/:slug',
  requirePermission('settings', 'write'),
  async (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!isPrivacyDocumentSlug(slug)) {
      return fail(res, 400, 'INVALID_PRIVACY_SLUG', `Unknown document: ${slug}`);
    }

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';

    // No route-level body parser: the app mounts express.json globally at
    // 10 MB and body-parser skips once req._body is set, so one here would
    // never run. See validateDocumentPayload for the rest of that story.
    const rejection = validateDocumentPayload(title, content);
    if (rejection) {
      return fail(res, rejection.status, rejection.code, rejection.message);
    }

    const byteLength = Buffer.byteLength(content, 'utf8');

    try {
      const saved = await databaseService.privacyDocuments.upsertAsync(
        slug,
        title,
        content,
        req.user?.username ?? null,
      );
      logger.info(`[PrivacyRoutes] Privacy document "${slug}" saved (${byteLength} bytes)`);
      return ok(res, saved);
    } catch (error) {
      // Log the driver's message; do not return it. A uniqueness or constraint
      // error can echo fragments of the row being written back to the client.
      logger.error(`[PrivacyRoutes] Failed to save privacy document "${slug}":`, error);
      return fail(res, 500, 'PRIVACY_DOCUMENT_SAVE_FAILED', 'Failed to save document');
    }
  },
);

/**
 * DELETE /api/privacy/admin/documents/:slug
 * Unpublish a hosted document. The matching URL setting, if any, takes over.
 */
privacyAdminRouter.delete(
  '/documents/:slug',
  requirePermission('settings', 'write'),
  async (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!isPrivacyDocumentSlug(slug)) {
      return fail(res, 400, 'INVALID_PRIVACY_SLUG', `Unknown document: ${slug}`);
    }
    try {
      await databaseService.privacyDocuments.deleteAsync(slug);
      logger.info(`[PrivacyRoutes] Privacy document "${slug}" deleted`);
      return ok(res);
    } catch (error) {
      logger.error(`[PrivacyRoutes] Failed to delete privacy document "${slug}":`, error);
      return fail(res, 500, 'PRIVACY_DOCUMENT_DELETE_FAILED', 'Failed to delete document');
    }
  },
);
