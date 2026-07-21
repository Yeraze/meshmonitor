/**
 * Static / SPA Serving
 *
 * Serves the built React app (JS/CSS/assets), the PWA service-worker
 * registration + manifest (BASE_URL-rewritten), robots.txt, the embed page,
 * and the SPA catch-all fallback — with rewritten-HTML + analytics-script
 * caching (`invalidateHtmlCache`) shared across the BASE_URL and root-deploy
 * branches.
 *
 * Extracted verbatim from server.ts (was the top-level "Serve static assets"
 * `if (BASE_URL) {...} else {...}` block, plus the `buildPath` const,
 * `getAnalyticsScript`, and `invalidateHtmlCache`) as part of #3502 PR3
 * composition-root teardown.
 *
 * Must be called AFTER the API router is mounted on `app` — static/SPA
 * serving is the fallback for everything the API router didn't handle.
 */
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import databaseService from '../services/database.js';
import { getEnvironmentConfig } from './config/environment.js';
import { robotsTxtHandler } from './middleware/robotsTag.js';
import { createEmbedCspMiddleware } from './middleware/embedMiddleware.js';
import { rewriteHtml } from './utils/htmlRewriter.js';
import { generateAnalyticsScript, AnalyticsProvider } from './utils/analyticsScriptGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StaticServingDeps {
  /** Override the build output directory (primarily for tests). Defaults to `<repo>/dist`. */
  buildPath?: string;
}

// Cache for rewritten HTML to avoid repeated file reads
let cachedHtml: string | null = null;
let cachedRewrittenHtml: string | null = null;
let cachedEmbedHtml: string | null = null;
let cachedRewrittenEmbedHtml: string | null = null;

export function invalidateHtmlCache(): void {
  cachedRewrittenHtml = null;
  cachedRewrittenEmbedHtml = null;
}

async function getAnalyticsScript(): Promise<string> {
  try {
    const provider = (await databaseService.settings.getSetting('analyticsProvider') || 'none') as AnalyticsProvider;
    if (provider === 'none') return '';
    const configStr = await databaseService.settings.getSetting('analyticsConfig') || '{}';
    const config = JSON.parse(configStr);
    return generateAnalyticsScript(provider, config);
  } catch {
    return '';
  }
}

export function configureStaticServing(app: express.Express, deps: StaticServingDeps = {}): void {
  const env = getEnvironmentConfig();
  const BASE_URL = env.baseUrl;
  const buildPath = deps.buildPath ?? path.join(__dirname, '../../dist');

  // Serve static assets (JS, CSS, images)
  if (BASE_URL) {
    // Serve PWA files with BASE_URL rewriting (MUST be before static middleware)
    app.get(`${BASE_URL}/registerSW.js`, (_req: express.Request, res: express.Response) => {
      const swRegisterPath = path.join(buildPath, 'registerSW.js');
      let content = fs.readFileSync(swRegisterPath, 'utf-8');
      // Rewrite service worker registration to use BASE_URL
      // The generated file has: navigator.serviceWorker.register('/sw.js', { scope: '/' })
      content = content
        .replace("'/sw.js'", `'${BASE_URL}/sw.js'`)
        .replace('"/sw.js"', `"${BASE_URL}/sw.js"`)
        .replace("scope: '/'", `scope: '${BASE_URL}/'`)
        .replace('scope: "/"', `scope: "${BASE_URL}/"`);
      res.type('application/javascript').send(content);
    });

    app.get(`${BASE_URL}/manifest.webmanifest`, (_req: express.Request, res: express.Response) => {
      const manifestPath = path.join(buildPath, 'manifest.webmanifest');
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      // Update manifest paths
      manifest.scope = `${BASE_URL}/`;
      manifest.start_url = `${BASE_URL}/`;
      res.type('application/manifest+json').json(manifest);
    });

    // Serve assets folder specifically
    app.use(`${BASE_URL}/assets`, express.static(path.join(buildPath, 'assets')));

    // Create static middleware once and reuse it
    const staticMiddleware = express.static(buildPath, { index: false });

    // Serve other static files (like favicon, logo, etc.) - but exclude /api
    app.use(BASE_URL, (req, res, next) => {
      // Skip if this is an API route
      if (req.path.startsWith('/api')) {
        return next();
      }
      staticMiddleware(req, res, next);
    });

    // Serve robots.txt (before SPA fallback) — dynamic body gated on noIndexEnabled (#4202)
    app.get(`${BASE_URL}/robots.txt`, robotsTxtHandler);

    // Serve embed page (before SPA fallback)
    app.get(`${BASE_URL}/embed/:profileId`, createEmbedCspMiddleware(), async (_req: express.Request, res: express.Response) => {
      if (!cachedRewrittenEmbedHtml) {
        const embedHtmlPath = path.join(buildPath, 'embed.html');
        if (!fs.existsSync(embedHtmlPath)) {
          return res.status(404).send('Embed page not found');
        }
        cachedEmbedHtml = fs.readFileSync(embedHtmlPath, 'utf-8');
        const embedAnalyticsScript = await getAnalyticsScript();
        cachedRewrittenEmbedHtml = rewriteHtml(cachedEmbedHtml, BASE_URL, embedAnalyticsScript);
      }
      res.setHeader('Content-Type', 'text/html');
      res.send(cachedRewrittenEmbedHtml);
    });

    // Catch all handler for SPA routing - but exclude /api
    app.get(`${BASE_URL}`, async (_req: express.Request, res: express.Response) => {
      // Use cached HTML if available, otherwise read and cache
      if (!cachedRewrittenHtml) {
        const htmlPath = path.join(buildPath, 'index.html');
        cachedHtml = fs.readFileSync(htmlPath, 'utf-8');
        const analyticsScript = await getAnalyticsScript();
        cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL, analyticsScript);
      }
      res.type('html').send(cachedRewrittenHtml);
    });
    // Use a route pattern that Express 5 can handle
    app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      // Skip if this is not under our BASE_URL
      if (!req.path.startsWith(BASE_URL)) {
        return next();
      }
      // Skip if this is an API route
      if (req.path.startsWith(`${BASE_URL}/api`)) {
        return next();
      }
      // Skip if this is a static file (has an extension like .ico, .png, .svg, etc.)
      if (/\.[a-zA-Z0-9]+$/.test(req.path)) {
        return next();
      }
      // Serve cached rewritten HTML for all other routes under BASE_URL
      if (!cachedRewrittenHtml) {
        const htmlPath = path.join(buildPath, 'index.html');
        cachedHtml = fs.readFileSync(htmlPath, 'utf-8');
        const analyticsScript = await getAnalyticsScript();
        cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL, analyticsScript);
      }
      res.type('html').send(cachedRewrittenHtml);
    });
  } else {
    // Normal static file serving for root deployment.
    //
    // IMPORTANT: `index: false` disables express.static's automatic index.html
    // serving. We handle index.html ourselves (below) so we can inject the
    // configured analytics script into <head>. Without this flag, a request
    // for `/` would be served by static middleware with the raw index.html,
    // bypassing analytics injection entirely — which is the bug that caused
    // GA4 tags to silently not appear on root deployments.
    app.use(express.static(buildPath, { index: false }));

    // Serve robots.txt (before SPA fallback) — dynamic body gated on noIndexEnabled (#4202)
    app.get('/robots.txt', robotsTxtHandler);

    // Serve embed page (before SPA fallback)
    app.get('/embed/:profileId', createEmbedCspMiddleware(), async (_req: express.Request, res: express.Response) => {
      if (!cachedRewrittenEmbedHtml) {
        const embedHtmlPath = path.join(buildPath, 'embed.html');
        if (!fs.existsSync(embedHtmlPath)) {
          return res.status(404).send('Embed page not found');
        }
        cachedEmbedHtml = fs.readFileSync(embedHtmlPath, 'utf-8');
        const embedAnalyticsScript = await getAnalyticsScript();
        cachedRewrittenEmbedHtml = rewriteHtml(cachedEmbedHtml, BASE_URL, embedAnalyticsScript);
      }
      res.setHeader('Content-Type', 'text/html');
      res.send(cachedRewrittenEmbedHtml);
    });

    // Catch all handler for SPA routing - skip API routes
    app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      // Skip if this is an API route
      if (req.path.startsWith('/api')) {
        return next();
      }
      // Serve cached rewritten HTML (with analytics injected)
      if (!cachedRewrittenHtml) {
        const htmlPath = path.join(buildPath, 'index.html');
        cachedHtml = fs.readFileSync(htmlPath, 'utf-8');
        const analyticsScript = await getAnalyticsScript();
        cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL, analyticsScript);
      }
      res.type('html').send(cachedRewrittenHtml);
    });
  }
}
