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

import { buildCspHeader } from './dynamicCsp.js';

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
