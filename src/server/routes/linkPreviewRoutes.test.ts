import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn()
  }
}));

const sampleHtml = `
<html>
<head>
  <title>Test Page</title>
  <meta property="og:title" content="OG Title" />
  <meta property="og:description" content="OG Description" />
  <meta property="og:image" content="https://example.com/image.png" />
  <meta property="og:site_name" content="Example Site" />
</head>
<body></body>
</html>
`;

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }
    })
  );
  // linkPreviewRoutes uses optionalAuth, so no session user needed
  return app;
};

// We need to isolate the module for each test so the cache is fresh
async function loadRoutes() {
  // Clear the module cache so each test gets a fresh in-memory cache
  const modulePath = './linkPreviewRoutes.js';
  vi.resetModules();
  const mod = await import(modulePath);
  return mod.default;
}

describe('Link Preview Routes', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy;
  });

  describe('GET /api/link-preview', () => {
    it('returns 400 when url parameter is missing', async () => {
      const routes = await loadRoutes();
      const app = createApp();
      app.use('/api', routes);

      const response = await request(app).get('/api/link-preview');
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('URL parameter is required');
    });

    it('returns 400 for invalid URL format', async () => {
      const routes = await loadRoutes();
      const app = createApp();
      app.use('/api', routes);

      const response = await request(app).get('/api/link-preview?url=not-a-url');
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid URL format');
    });

    it('returns 400 for non-HTTP protocols', async () => {
      const routes = await loadRoutes();
      const app = createApp();
      app.use('/api', routes);

      const response = await request(app).get('/api/link-preview?url=ftp://example.com');
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Only HTTP and HTTPS URLs are supported');
    });

    it('fetches and returns OpenGraph metadata', async () => {
      const routes = await loadRoutes();
      const app = createApp();
      app.use('/api', routes);

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(sampleHtml)
      });

      const response = await request(app).get('/api/link-preview?url=https://example.com/page');
      expect(response.status).toBe(200);
      expect(response.body.title).toBe('OG Title');
      expect(response.body.description).toBe('OG Description');
      expect(response.body.image).toBe('https://example.com/image.png');
      expect(response.body.siteName).toBe('Example Site');
      expect(response.headers['x-cache']).toBe('MISS');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('serves cached result on second request without re-fetching', async () => {
      const routes = await loadRoutes();
      const app = createApp();
      app.use('/api', routes);

      fetchSpy.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(sampleHtml)
      });

      // First request - cache miss
      const first = await request(app).get('/api/link-preview?url=https://example.com/page');
      expect(first.status).toBe(200);
      expect(first.headers['x-cache']).toBe('MISS');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second request - should be cache hit
      const second = await request(app).get('/api/link-preview?url=https://example.com/page');
      expect(second.status).toBe(200);
      expect(second.headers['x-cache']).toBe('HIT');
      expect(second.body.title).toBe('OG Title');
      // fetch should NOT have been called again
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('caches different URLs independently', async () => {
      const routes = await loadRoutes();
      const app = createApp();
      app.use('/api', routes);

      fetchSpy.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(sampleHtml)
      });

      await request(app).get('/api/link-preview?url=https://example.com/page1');
      await request(app).get('/api/link-preview?url=https://example.com/page2');

      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Both should now be cached
      const cached1 = await request(app).get('/api/link-preview?url=https://example.com/page1');
      const cached2 = await request(app).get('/api/link-preview?url=https://example.com/page2');
      expect(cached1.headers['x-cache']).toBe('HIT');
      expect(cached2.headers['x-cache']).toBe('HIT');
      // No additional fetches
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('sets Cache-Control header on responses', async () => {
      const routes = await loadRoutes();
      const app = createApp();
      app.use('/api', routes);

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(sampleHtml)
      });

      const response = await request(app).get('/api/link-preview?url=https://example.com/page');
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
    });

    it('caches non-HTML URLs with basic metadata', async () => {
      const routes = await loadRoutes();
      const app = createApp();
      app.use('/api', routes);

      fetchSpy.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        text: () => Promise.resolve('')
      });

      const first = await request(app).get('/api/link-preview?url=https://example.com/doc.pdf');
      expect(first.status).toBe(200);
      expect(first.body.title).toBe('example.com');
      expect(first.headers['x-cache']).toBe('MISS');

      const second = await request(app).get('/api/link-preview?url=https://example.com/doc.pdf');
      expect(second.headers['x-cache']).toBe('HIT');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does not cache failed fetches', async () => {
      const routes = await loadRoutes();
      const app = createApp();
      app.use('/api', routes);

      // First request fails
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers()
      });

      const first = await request(app).get('/api/link-preview?url=https://example.com/missing');
      expect(first.status).toBe(404);

      // Second request should still try to fetch (not cached)
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(sampleHtml)
      });

      const second = await request(app).get('/api/link-preview?url=https://example.com/missing');
      expect(second.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
