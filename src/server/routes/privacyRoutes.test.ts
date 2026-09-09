/**
 * Privacy disclosure route tests (#5156).
 *
 * Uses the real route test harness (CLAUDE.md): real express-session, real
 * auth middleware, real permission rows against the singleton `:memory:` DB.
 * A hand-rolled `checkPermissionAsync` fake cannot catch a regression in the
 * permission logic these routes depend on.
 *
 * The behaviour that matters most here is the split between the two routers:
 * the public half must serve a logged-out visitor (that is the entire point of
 * publishing a privacy policy on a public instance), while the admin half must
 * not let one write.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import {
  privacyPublicRouter,
  privacyAdminRouter,
  isSafeExternalUrl,
  looksLikeHtmlDocument,
  validateDocumentPayload,
  MAX_DOCUMENT_BYTES,
  MAX_TITLE_LENGTH,
} from './privacyRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('isSafeExternalUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeExternalUrl('https://example.org/privacy')).toBe(true);
    expect(isSafeExternalUrl('http://example.org/privacy')).toBe(true);
    expect(isSafeExternalUrl('  https://example.org/privacy  ')).toBe(true);
  });

  it('rejects schemes that would execute when rendered as an href', () => {
    // The operator types this value and anonymous visitors click it, so a
    // javascript: URL here is a self-inflicted XSS.
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeExternalUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects blanks and non-URLs', () => {
    expect(isSafeExternalUrl('')).toBe(false);
    expect(isSafeExternalUrl(null)).toBe(false);
    expect(isSafeExternalUrl(undefined)).toBe(false);
    expect(isSafeExternalUrl('example.org/privacy')).toBe(false);
  });
});

describe('looksLikeHtmlDocument', () => {
  it('flags pasted HTML documents and script-bearing content', () => {
    expect(looksLikeHtmlDocument('<!DOCTYPE html><html><body>hi</body></html>')).toBe(true);
    expect(looksLikeHtmlDocument('# Policy\n\n<script>alert(1)</script>')).toBe(true);
    expect(looksLikeHtmlDocument('<iframe src="x"></iframe>')).toBe(true);
  });

  it('leaves ordinary Markdown alone', () => {
    expect(looksLikeHtmlDocument('# Privacy Policy\n\nWe store *packets*.')).toBe(false);
    expect(looksLikeHtmlDocument('Contact us at <hello@example.org>')).toBe(false);
    expect(looksLikeHtmlDocument('Use `a < b` in code.')).toBe(false);
  });
});

describe('validateDocumentPayload', () => {
  // The size cap is asserted here rather than over HTTP: the route harness
  // mounts a global express.json() at body-parser's 100 KB default while
  // production mounts 10 MB, so a 256 KB body never reaches the handler under
  // test. See the function's own comment.
  it('accepts an ordinary Markdown document', () => {
    expect(validateDocumentPayload('Privacy Policy', '# Hi\n\nWe store packets.')).toBeNull();
  });

  it('rejects a document past the byte cap', () => {
    const rejection = validateDocumentPayload('Policy', 'x'.repeat(MAX_DOCUMENT_BYTES + 1));
    expect(rejection?.status).toBe(413);
    expect(rejection?.code).toBe('PRIVACY_CONTENT_TOO_LARGE');
  });

  it('measures the cap in UTF-8 bytes, not characters', () => {
    // A multi-byte policy that fits by character count but not by bytes must
    // still be refused — the MySQL column is sized in bytes.
    const multibyte = '\u00e9'.repeat(MAX_DOCUMENT_BYTES - 10);
    expect(validateDocumentPayload('Policy', multibyte)?.code).toBe('PRIVACY_CONTENT_TOO_LARGE');
  });

  it('accepts a document exactly at the cap', () => {
    expect(validateDocumentPayload('Policy', 'x'.repeat(MAX_DOCUMENT_BYTES))).toBeNull();
  });

  it('rejects a missing title or body', () => {
    expect(validateDocumentPayload('  ', 'body')?.code).toBe('PRIVACY_TITLE_REQUIRED');
    expect(validateDocumentPayload('Policy', '   ')?.code).toBe('PRIVACY_CONTENT_REQUIRED');
  });

  it('rejects an over-long title', () => {
    const rejection = validateDocumentPayload('t'.repeat(MAX_TITLE_LENGTH + 1), 'body');
    expect(rejection?.code).toBe('PRIVACY_TITLE_TOO_LONG');
  });

  it('rejects HTML content', () => {
    expect(validateDocumentPayload('Policy', '<script>alert(1)</script>')?.code)
      .toBe('PRIVACY_CONTENT_NOT_MARKDOWN');
  });
});

describe('privacy routes', () => {
  let harness: RouteTestHarness;

  const mount = (app: Express) => {
    app.use('/api/privacy', privacyPublicRouter);
    app.use('/api/privacy/admin', privacyAdminRouter);
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount });
    await harness.db.settings.setSetting('privacyPolicyUrl', '');
    await harness.db.settings.setSetting('termsOfServiceUrl', '');
    await harness.db.settings.setSetting('contactUrl', '');
    for (const slug of ['privacy', 'terms', 'contact']) {
      await harness.db.privacyDocuments.deleteAsync(slug);
    }
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('GET /links (public)', () => {
    it('returns nothing when the operator has configured nothing', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/api/privacy/links');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('serves a URL link to an anonymous visitor', async () => {
      await harness.db.settings.setSetting('privacyPolicyUrl', 'https://example.org/privacy');

      const agent = await harness.loginAs(null);
      const res = await agent.get('/api/privacy/links');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { slug: 'privacy', kind: 'url', href: 'https://example.org/privacy' },
      ]);
    });

    it('drops a URL whose scheme would execute, rather than rendering it', async () => {
      // Defence in depth: the value may predate the write-side check or have
      // been written straight into the settings table.
      await harness.db.settings.setSetting('privacyPolicyUrl', 'javascript:alert(1)');

      const agent = await harness.loginAs(null);
      const res = await agent.get('/api/privacy/links');

      expect(res.body.data).toEqual([]);
    });

    it('prefers a hosted document over the URL for the same slug', async () => {
      await harness.db.settings.setSetting('privacyPolicyUrl', 'https://example.org/privacy');
      await harness.db.privacyDocuments.upsertAsync('privacy', 'Our Policy', '# Ours');

      const agent = await harness.loginAs(null);
      const res = await agent.get('/api/privacy/links');

      expect(res.body.data).toEqual([
        { slug: 'privacy', kind: 'hosted', title: 'Our Policy' },
      ]);
    });

    it('never ships document bodies to the links endpoint', async () => {
      await harness.db.privacyDocuments.upsertAsync('privacy', 'Our Policy', '# secret body');

      const agent = await harness.loginAs(null);
      const res = await agent.get('/api/privacy/links');

      expect(JSON.stringify(res.body)).not.toContain('secret body');
    });
  });

  describe('GET /documents/:slug (public)', () => {
    it('serves a hosted document to an anonymous visitor', async () => {
      await harness.db.privacyDocuments.upsertAsync('privacy', 'Our Policy', '# Ours');

      const agent = await harness.loginAs(null);
      const res = await agent.get('/api/privacy/documents/privacy');

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Our Policy');
      expect(res.body.data.content).toBe('# Ours');
    });

    it('404s an unpublished document', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/api/privacy/documents/terms');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PRIVACY_DOCUMENT_NOT_FOUND');
    });

    it('400s an unknown slug', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/api/privacy/documents/passwd');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PRIVACY_SLUG');
    });
  });

  describe('admin routes', () => {
    it('refuses an anonymous write', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent
        .put('/api/privacy/admin/documents/privacy')
        .send({ title: 'Injected', content: '# nope' });

      expect(res.status).toBe(403);
      expect(await harness.db.privacyDocuments.getBySlugAsync('privacy')).toBeNull();
    });

    it('refuses a logged-in user without settings:write', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .put('/api/privacy/admin/documents/privacy')
        .send({ title: 'Injected', content: '# nope' });

      expect(res.status).toBe(403);
    });

    it('lets an admin publish, then serves it publicly', async () => {
      const adminAgent = await harness.loginAs(harness.admin);
      const put = await adminAgent
        .put('/api/privacy/admin/documents/privacy')
        .send({ title: 'Our Policy', content: '# Ours' });

      expect(put.status).toBe(200);
      expect(put.body.data.slug).toBe('privacy');

      const anon = await harness.loginAs(null);
      const get = await anon.get('/api/privacy/documents/privacy');
      expect(get.body.data.content).toBe('# Ours');
    });

    it('records who last edited the document', async () => {
      const adminAgent = await harness.loginAs(harness.admin);
      await adminAgent
        .put('/api/privacy/admin/documents/privacy')
        .send({ title: 'Our Policy', content: '# Ours' });

      const stored = await harness.db.privacyDocuments.getBySlugAsync('privacy');
      expect(stored?.updatedBy).toBe(harness.admin.username);
    });

    it('rejects an HTML document rather than storing it', async () => {
      const adminAgent = await harness.loginAs(harness.admin);
      const res = await adminAgent
        .put('/api/privacy/admin/documents/privacy')
        .send({ title: 'Policy', content: '<script>alert(1)</script>' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PRIVACY_CONTENT_NOT_MARKDOWN');
      expect(await harness.db.privacyDocuments.getBySlugAsync('privacy')).toBeNull();
    });

    it('requires a title and a body', async () => {
      const adminAgent = await harness.loginAs(harness.admin);

      const noTitle = await adminAgent
        .put('/api/privacy/admin/documents/privacy')
        .send({ title: '  ', content: '# Ours' });
      expect(noTitle.body.code).toBe('PRIVACY_TITLE_REQUIRED');

      const noBody = await adminAgent
        .put('/api/privacy/admin/documents/privacy')
        .send({ title: 'Policy', content: '   ' });
      expect(noBody.body.code).toBe('PRIVACY_CONTENT_REQUIRED');
    });

    it('rejects an unknown slug', async () => {
      const adminAgent = await harness.loginAs(harness.admin);
      const res = await adminAgent
        .put('/api/privacy/admin/documents/passwd')
        .send({ title: 'Policy', content: '# Ours' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PRIVACY_SLUG');
    });

    it('unpublishes a document, falling back to the URL', async () => {
      await harness.db.settings.setSetting('privacyPolicyUrl', 'https://example.org/privacy');
      await harness.db.privacyDocuments.upsertAsync('privacy', 'Our Policy', '# Ours');

      const adminAgent = await harness.loginAs(harness.admin);
      const del = await adminAgent.delete('/api/privacy/admin/documents/privacy');
      expect(del.status).toBe(200);

      const anon = await harness.loginAs(null);
      const links = await anon.get('/api/privacy/links');
      expect(links.body.data).toEqual([
        { slug: 'privacy', kind: 'url', href: 'https://example.org/privacy' },
      ]);
    });

    it('refuses an anonymous delete', async () => {
      await harness.db.privacyDocuments.upsertAsync('privacy', 'Our Policy', '# Ours');

      const agent = await harness.loginAs(null);
      const res = await agent.delete('/api/privacy/admin/documents/privacy');

      expect(res.status).toBe(403);
      expect(await harness.db.privacyDocuments.getBySlugAsync('privacy')).not.toBeNull();
    });

    it('lists hosted documents for a reader', async () => {
      await harness.db.privacyDocuments.upsertAsync('privacy', 'Our Policy', '# Ours');

      await harness.grant(harness.limited.id, 'settings', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/privacy/admin/documents');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].content).toBe('# Ours');
    });
  });
});
