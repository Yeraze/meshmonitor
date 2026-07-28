/**
 * Tests for dynamic CSP header construction, focused on the
 * `frame-ancestors` directive driven by IFRAME_ALLOWED_ORIGINS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/database.js', () => ({
  default: {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { buildCspHeader, extractHostFromUrl } from './dynamicCsp.js';
import databaseService from '../../services/database.js';
import { TILESETS } from '../../config/tilesets.js';

const mockGetSetting = (databaseService as unknown as {
  settings: { getSetting: ReturnType<typeof vi.fn> };
}).settings.getSetting;

function directivesFromHeader(header: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      map[trimmed] = '';
    } else {
      map[trimmed.slice(0, spaceIdx)] = trimmed.slice(spaceIdx + 1);
    }
  }
  return map;
}

describe('buildCspHeader - frame-ancestors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits frame-ancestors when iframeAllowedOrigins is empty', async () => {
    const header = await buildCspHeader(true, true, []);
    const directives = directivesFromHeader(header);

    expect(directives['frame-ancestors']).toBeUndefined();
  });

  it('omits frame-ancestors when iframeAllowedOrigins is not provided', async () => {
    const header = await buildCspHeader(true, true);
    const directives = directivesFromHeader(header);

    expect(directives['frame-ancestors']).toBeUndefined();
  });

  it('sets frame-ancestors with self + origins when list is provided', async () => {
    const header = await buildCspHeader(true, true, [
      'http://192.168.1.50:1880',
      'https://nodered.example.com',
    ]);
    const directives = directivesFromHeader(header);

    expect(directives['frame-ancestors']).toBe(
      "'self' http://192.168.1.50:1880 https://nodered.example.com"
    );
  });

  it('collapses to wildcard when "*" is in the list', async () => {
    const header = await buildCspHeader(true, true, ['*']);
    const directives = directivesFromHeader(header);

    expect(directives['frame-ancestors']).toBe('*');
  });

  it('collapses to wildcard even when "*" is mixed with specific origins', async () => {
    const header = await buildCspHeader(true, true, ['http://a.example', '*']);
    const directives = directivesFromHeader(header);

    expect(directives['frame-ancestors']).toBe('*');
  });

  it('does not touch frame-src when iframeAllowedOrigins is set', async () => {
    // frame-src controls what WE embed, unrelated to who can embed us.
    const header = await buildCspHeader(true, true, ['http://a.example']);
    const directives = directivesFromHeader(header);

    expect(directives['frame-src']).toBe("'none'");
  });
});

describe('buildCspHeader - custom analytics CSP domains (#3409)', () => {
  beforeEach(() => {
    mockGetSetting.mockReset();
    mockGetSetting.mockResolvedValue(null);
  });

  function withSettings(settings: Record<string, string>) {
    mockGetSetting.mockImplementation(async (key: string) => settings[key] ?? null);
  }

  it('includes configured custom domains in script-src and connect-src', async () => {
    withSettings({
      analyticsProvider: 'custom',
      analyticsConfig: JSON.stringify({
        cspDomains: 'https://analytics.example.com https://cdn.example.com',
      }),
    });

    const header = await buildCspHeader(true, true, []);
    const directives = directivesFromHeader(header);

    // Regression: before #3409 the 'custom' provider was short-circuited and
    // these origins never reached the header.
    expect(directives['script-src']).toContain('https://analytics.example.com');
    expect(directives['script-src']).toContain('https://cdn.example.com');
    expect(directives['connect-src']).toContain('https://analytics.example.com');
    expect(directives['connect-src']).toContain('https://cdn.example.com');
    // Inline analytics snippets need 'unsafe-inline' on script-src.
    expect(directives['script-src']).toContain("'unsafe-inline'");
  });

  it('reduces bare hostnames / non-URL entries to nothing (requires a scheme)', async () => {
    withSettings({
      analyticsProvider: 'custom',
      analyticsConfig: JSON.stringify({ cspDomains: 'analytics.example.com' }),
    });

    const header = await buildCspHeader(true, true, []);
    const directives = directivesFromHeader(header);

    // No scheme → not added (the parser requires http(s)://).
    expect(directives['script-src']).not.toContain('analytics.example.com');
  });

  it('adds nothing for provider "none"', async () => {
    withSettings({ analyticsProvider: 'none' });

    const header = await buildCspHeader(true, true, []);
    const directives = directivesFromHeader(header);

    expect(directives['script-src']).toBe("'self'");
  });
});

/**
 * #4371: the 3D map (MapLibre) fetches raster tiles, so they are governed by
 * `connect-src`; the 2D map (Leaflet) loads them as `<img>` under the very
 * permissive `img-src`. A built-in tileset absent from `connect-src` therefore
 * looks fine in 2D and renders a blank basemap in 3D — which is how
 * `tile.openstreetmap.fr` (the "OSM Humanitarian" tileset) stayed broken.
 *
 * These tests import the REAL tileset catalog rather than restating hostnames,
 * so adding a tileset without its CSP entry fails here instead of in someone's
 * browser.
 */
describe('buildCspHeader - built-in tileset hosts are reachable in 3D (#4371)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** CSP source patterns match a host if equal, or via a leading `*.` wildcard. */
  function cspAllowsHost(sources: string[], origin: string): boolean {
    const { protocol, hostname } = new URL(origin);
    return sources.some((src) => {
      if (!src.includes('//')) return false; // 'self', ws:, wss:, …
      const [srcProto, srcHost] = src.split('//');
      if (srcProto !== protocol) return false;
      if (srcHost === hostname) return true;
      return srcHost.startsWith('*.') && hostname.endsWith(srcHost.slice(1));
    });
  }

  it.each(Object.values(TILESETS).map((t) => [t.id, t.url] as const))(
    'allows the %s tileset host in connect-src',
    async (_id, url) => {
      const header = await buildCspHeader(true, true, []);
      const sources = directivesFromHeader(header)['connect-src'].split(' ');
      // Resolve the {s} placeholder to a real subdomain, as the browser does.
      const concrete = url.replace('{s}', 'a');
      expect(cspAllowsHost(sources, concrete)).toBe(true);
    },
  );
});

describe('extractHostFromUrl (#4371)', () => {
  it('rewrites a leading {s} subdomain placeholder to a wildcard', () => {
    expect(extractHostFromUrl('https://{s}.tile.example.com/{z}/{x}/{y}.png')).toBe(
      'https://*.tile.example.com',
    );
  });

  it('leaves a host with no placeholder alone', () => {
    expect(extractHostFromUrl('https://tiles.example.com/{z}/{x}/{y}.png')).toBe(
      'https://tiles.example.com',
    );
  });

  it('keeps a non-standard port', () => {
    expect(extractHostFromUrl('http://tiles.example.com:8080/{z}/{x}/{y}.png')).toBe(
      'http://tiles.example.com:8080',
    );
  });

  it('returns null for a non-URL', () => {
    expect(extractHostFromUrl('not a url')).toBeNull();
  });

  it('a custom tileset using {s} lands in connect-src as a usable wildcard', async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === 'customTilesets'
        ? JSON.stringify([{ url: 'https://{s}.mytiles.example.org/{z}/{x}/{y}.png' }])
        : null,
    );
    // The module caches hostnames for 60s; force a refresh for this case.
    const { refreshTileHostnameCache } = await import('./dynamicCsp.js');
    await refreshTileHostnameCache();

    const header = await buildCspHeader(true, true, []);
    expect(directivesFromHeader(header)['connect-src']).toContain(
      'https://*.mytiles.example.org',
    );
  });
});
