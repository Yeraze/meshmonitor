/**
 * Dynamic CSP middleware for custom tile servers
 *
 * Extracts hostnames from custom tileset URLs stored in the database
 * and dynamically adds them to the Content-Security-Policy connect-src directive.
 */

import { Request, Response, NextFunction } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

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
export function loadCustomTilesetHostnames(): string[] {
  try {
    const customTilesetsJson = databaseService.getSetting('customTilesets');
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
export function refreshTileHostnameCache(): void {
  cachedTileHostnames = loadCustomTilesetHostnames();
  cacheTimestamp = Date.now();
  logger.debug(`[CSP] Refreshed tile hostname cache: ${cachedTileHostnames.length} entries`);
}

/**
 * Get cached tile hostnames, refreshing if stale
 */
export function getCachedTileHostnames(): string[] {
  if (Date.now() - cacheTimestamp > CACHE_TTL_MS) {
    refreshTileHostnameCache();
  }
  return cachedTileHostnames;
}

/**
 * Build dynamic connect-src directive values
 */
export function buildConnectSrcDirective(isProduction: boolean, cookieSecure: boolean): string[] {
  const connectSrc: string[] = [
    "'self'",
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
  const customHosts = getCachedTileHostnames();
  for (const host of customHosts) {
    if (!connectSrc.includes(host)) {
      connectSrc.push(host);
    }
  }

  return connectSrc;
}

/**
 * Build the full CSP header value
 */
export function buildCspHeader(isProduction: boolean, cookieSecure: boolean): string {
  const connectSrc = buildConnectSrcDirective(isProduction, cookieSecure);

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': isProduction && cookieSecure
      ? ["'self'"]
      : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
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

  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}

/**
 * Middleware to set dynamic CSP header
 * This replaces helmet's static CSP with a dynamic one that includes custom tile servers
 */
export function dynamicCspMiddleware(isProduction: boolean, cookieSecure: boolean) {
  // Initialize cache on first call
  if (cacheTimestamp === 0) {
    refreshTileHostnameCache();
  }

  return (_req: Request, res: Response, next: NextFunction) => {
    const cspHeader = buildCspHeader(isProduction, cookieSecure);
    res.setHeader('Content-Security-Policy', cspHeader);
    next();
  };
}
