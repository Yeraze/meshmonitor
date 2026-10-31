/**
 * Dynamic CSP middleware for custom tile servers
 *
 * Extracts hostnames from custom tileset URLs stored in the database
 * and dynamically adds them to the Content-Security-Policy connect-src directive.
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { AnalyticsProvider, getAnalyticsCspDomains } from '../utils/analyticsScriptGenerator.js';

/**
 * Placeholder token baked into the cached HTML wherever a per-request CSP
 * nonce belongs (the analytics inline `<script>` snippets). The SPA HTML is
 * rendered and cached once, so the real nonce — which must differ on every
 * response — is substituted for this token at serve time (see
 * `staticServing.ts`). Keep it in sync with any consumer that does the
 * substitution.
 */
export const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__';

/**
 * Generate a fresh CSP nonce for one response. 128 bits of entropy, base64 —
 * well above the 128-bit floor the CSP spec recommends for unguessability.
 */
export function generateCspNonce(): string {
  return randomBytes(16).toString('base64');
}

// Cache for custom tileset hostnames
let cachedTileHostnames: string[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000; // 1 minute cache

/**
 * Extract hostname with protocol from a URL
 * Returns format like "http://example.com:8080" or "https://example.com"
 *
 * Tile URLs are templates, so the leading `{s}` subdomain placeholder is
 * rewritten to a `*` wildcard (#4371). Left as-is it yields a literal
 * `https://{s}.example.com` source, which matches nothing — the tiles are then
 * blocked in 3D, where MapLibre fetches them (governed by `connect-src`),
 * while 2D keeps working because Leaflet loads them as `<img>` under the
 * permissive `img-src`.
 */
export function extractHostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Include protocol, hostname, and port if non-standard
    const port = parsed.port ? `:${parsed.port}` : '';
    const hostname = parsed.hostname.startsWith('{s}.')
      ? `*.${parsed.hostname.slice('{s}.'.length)}`
      : parsed.hostname;
    return `${parsed.protocol}//${hostname}${port}`;
  } catch {
    return null;
  }
}

/**
 * Load custom tileset hostnames from database
 */
export async function loadCustomTilesetHostnames(): Promise<string[]> {
  try {
    await databaseService.waitForReady();
    const customTilesetsJson = await databaseService.settings.getSetting('customTilesets');
    if (!customTilesetsJson) {
      return [];
    }

    const tilesets = JSON.parse(customTilesetsJson);
    if (!Array.isArray(tilesets)) {
      return [];
    }

    const hostnames = new Set<string>();
    for (const tileset of tilesets) {
      if (tileset.url && typeof tileset.url === 'string') {
        const host = extractHostFromUrl(tileset.url);
        if (host) {
          hostnames.add(host);
        }
      }
    }

    const result = Array.from(hostnames);
    logger.debug(`[CSP] Loaded ${result.length} custom tile server hostnames`);
    return result;
  } catch (error) {
    logger.error('[CSP] Failed to load custom tileset hostnames:', error);
    return [];
  }
}

/**
 * Refresh the cached tile hostnames
 */
export async function refreshTileHostnameCache(): Promise<void> {
  cachedTileHostnames = await loadCustomTilesetHostnames();
  cacheTimestamp = Date.now();
  logger.debug(`[CSP] Refreshed tile hostname cache: ${cachedTileHostnames.length} entries`);
}

/**
 * Get cached tile hostnames, refreshing if stale
 */
export async function getCachedTileHostnames(): Promise<string[]> {
  if (Date.now() - cacheTimestamp > CACHE_TTL_MS) {
    await refreshTileHostnameCache();
  }
  return cachedTileHostnames;
}

/**
 * Build dynamic connect-src directive values
 */
export async function buildConnectSrcDirective(isProduction: boolean, cookieSecure: boolean): Promise<string[]> {
  const connectSrc: string[] = [
    "'self'",
    // WebSocket protocols for Socket.io real-time updates
    'ws:',
    'wss:',
    // Built-in tile servers. MUST stay in step with the TILESETS catalog in
    // src/config/tilesets.ts — a built-in tileset missing here renders a blank
    // basemap in the 3D map (MapLibre fetches tiles, so they fall under
    // connect-src) while looking fine in 2D (Leaflet uses <img>, and img-src is
    // permissive). `tile.openstreetmap.fr` was missing exactly that way (#4371).
    // dynamicCsp.test.ts imports the real catalog and fails if the two drift.
    'https://*.tile.openstreetmap.org',
    'https://*.tile.openstreetmap.fr',
    'https://*.basemaps.cartocdn.com',
    // CARTO GL styles (#5448) live on the BARE host
    // (basemaps.cartocdn.com/gl/…/style.json), which `*.` does not match. Their
    // vector tiles, TileJSON, sprites and glyphs are on tiles(-a..d).basemaps…,
    // which the wildcard above covers. MapLibre fetch()es all of them.
    'https://basemaps.cartocdn.com',
    'https://*.tile.opentopomap.org',
    'https://server.arcgisonline.com',
  ];

  // Add HTTP fallbacks for development
  if (!isProduction || !cookieSecure) {
    connectSrc.push('http://*.tile.openstreetmap.org');
  }

  // Add custom tile server hostnames
  const customHosts = await getCachedTileHostnames();
  for (const host of customHosts) {
    if (!connectSrc.includes(host)) {
      connectSrc.push(host);
    }
  }

  return connectSrc;
}

/**
 * Load analytics CSP domains from database settings
 */
async function getAnalyticsCspFromSettings(): Promise<{ scriptSrc: string[]; connectSrc: string[] }> {
  try {
    const provider = (await databaseService.settings.getSetting('analyticsProvider') || 'none') as AnalyticsProvider;
    if (provider === 'none') {
      return { scriptSrc: [], connectSrc: [] };
    }
    // 'custom' is handled by getAnalyticsCspDomains (reads config.cspDomains);
    // it must NOT be short-circuited here or the configured domains never reach
    // the CSP header (issue #3409).
    const configJson = await databaseService.settings.getSetting('analyticsConfig') || '{}';
    const config = JSON.parse(configJson);
    return getAnalyticsCspDomains(provider, config);
  } catch {
    return { scriptSrc: [], connectSrc: [] };
  }
}

/**
 * Build the full CSP header value
 */
export async function buildCspHeader(
  isProduction: boolean,
  cookieSecure: boolean,
  iframeAllowedOrigins: string[] = [],
  nonce?: string
): Promise<string> {
  const connectSrc = await buildConnectSrcDirective(isProduction, cookieSecure);
  const analyticsCsp = await getAnalyticsCspFromSettings();

  // Production (NODE_ENV=production) always gets a strict, nonce-based
  // `script-src` with NO `'unsafe-inline'` and NO `'unsafe-eval'` — this is the
  // XSS-mitigation hardening in MISC-09 (#6085).
  //
  // The strictness is keyed on `isProduction` ONLY, deliberately decoupled from
  // `cookieSecure`. The real-world hole was that the common HTTP deployment
  // (`COOKIE_SECURE` unset/false — the Quick-Start default, typical behind a
  // TLS-terminating reverse proxy) fell into the loose branch and shipped
  // `'unsafe-inline' 'unsafe-eval'` to every visitor. The app's own scripts are
  // all external `src=` files (covered by `'self'`); only the trusted inline
  // analytics snippets need inline execution, and they carry the per-request
  // nonce (see `generateAnalyticsScript`).
  //
  // Development keeps the loose policy: the Vite toolchain injects un-nonced
  // inline scripts and relies on `eval` for HMR, so a nonce cannot reach them.
  const scriptSrc = isProduction
    ? ["'self'", ...(nonce ? [`'nonce-${nonce}'`] : [])]
    : ["'self'", "'unsafe-inline'", "'unsafe-eval'"];

  // Add analytics script domains. In production the inline analytics snippet
  // runs under the nonce, so we do NOT widen `script-src` to `'unsafe-inline'`.
  // In development the loose policy already permits inline scripts.
  if (analyticsCsp.scriptSrc.length > 0) {
    if (!isProduction && !scriptSrc.includes("'unsafe-inline'")) {
      scriptSrc.push("'unsafe-inline'");
    }
    for (const domain of analyticsCsp.scriptSrc) {
      if (!scriptSrc.includes(domain)) {
        scriptSrc.push(domain);
      }
    }
  }

  // Add analytics connect domains
  for (const domain of analyticsCsp.connectSrc) {
    if (!connectSrc.includes(domain)) {
      connectSrc.push(domain);
    }
  }

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': scriptSrc,
    // style-src keeps 'unsafe-inline': Leaflet and MapLibre (and React inline
    // style props) set per-element `style="…"` attributes at runtime, which a
    // nonce cannot cover (nonces apply to <style>/<script> elements, not style
    // attributes). Removing it blanks the maps and breaks layout. This is the
    // standard, accepted trade-off; script-src (the XSS-execution vector) is
    // what is now locked down.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'http:', 'https:'],
    'connect-src': connectSrc,
    'worker-src': ["'self'", 'blob:'],
    'font-src': ["'self'"],
    'object-src': ["'none'"],
    'media-src': ["'self'"],
    'frame-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };

  if (iframeAllowedOrigins.length > 0) {
    const hasWildcard = iframeAllowedOrigins.includes('*');
    directives['frame-ancestors'] = hasWildcard
      ? ['*']
      : ["'self'", ...iframeAllowedOrigins];
  }

  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}

/**
 * Middleware to set dynamic CSP header
 * This replaces helmet's static CSP with a dynamic one that includes custom tile servers
 */
export function dynamicCspMiddleware(
  isProduction: boolean,
  cookieSecure: boolean,
  iframeAllowedOrigins: string[] = []
) {
  // Initialize cache on first call (fire-and-forget)
  if (cacheTimestamp === 0) {
    refreshTileHostnameCache().catch(err =>
      logger.error('[CSP] Failed to initialize tile hostname cache:', err)
    );
  }

  return async (_req: Request, res: Response, next: NextFunction) => {
    // Generate the per-response nonce first, outside the try, so it is always
    // available to the HTML serving layer even if header construction fails.
    const nonce = generateCspNonce();
    res.locals.cspNonce = nonce;
    try {
      const cspHeader = await buildCspHeader(isProduction, cookieSecure, iframeAllowedOrigins, nonce);
      res.setHeader('Content-Security-Policy', cspHeader);
      next();
    } catch (error) {
      logger.error('[CSP] Failed to build CSP header:', error);
      next();
    }
  };
}
