/**
 * Dynamic CSP middleware for custom tile servers
 *
 * Extracts hostnames from custom tileset URLs stored in the database
 * and dynamically adds them to the Content-Security-Policy connect-src directive.
 */

import { Request, Response, NextFunction } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { AnalyticsProvider, getAnalyticsCspDomains } from '../utils/analyticsScriptGenerator.js';

// Cache for custom tileset hostnames
let cachedTileHostnames: string[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000; // 1 minute cache

/**
 * Extract hostname with protocol from a URL
 * Returns format like "http://example.com:8080" or "https://example.com"
 */
function extractHostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Include protocol, hostname, and port if non-standard
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${parsed.hostname}${port}`;
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
    // Built-in tile servers
    'https://*.tile.openstreetmap.org',
    'https://*.basemaps.cartocdn.com',
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
    if (provider === 'none' || provider === 'custom') {
      return { scriptSrc: [], connectSrc: [] };
    }
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
  iframeAllowedOrigins: string[] = []
): Promise<string> {
  const connectSrc = await buildConnectSrcDirective(isProduction, cookieSecure);
  const analyticsCsp = await getAnalyticsCspFromSettings();

  const scriptSrc = isProduction && cookieSecure
    ? ["'self'"]
    : ["'self'", "'unsafe-inline'", "'unsafe-eval'"];

  // Add analytics script domains and allow inline scripts for analytics snippets
  if (analyticsCsp.scriptSrc.length > 0) {
    if (!scriptSrc.includes("'unsafe-inline'")) {
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
    try {
      const cspHeader = await buildCspHeader(isProduction, cookieSecure, iframeAllowedOrigins);
      res.setHeader('Content-Security-Policy', cspHeader);
      next();
    } catch (error) {
      logger.error('[CSP] Failed to build CSP header:', error);
      next();
    }
  };
}
