/**
 * Tests for the robots / search-indexing middleware (issue #4202).
 *
 * Covers both surfaces gated on the global `noIndexEnabled` flag:
 *   - robotsTagMiddleware: X-Robots-Tag header present/absent by flag.
 *   - robotsTxtHandler: disallow-all vs permissive body by flag.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { robotsTagMiddleware, robotsTxtHandler } from './robotsTag.js';
import { setNoIndexEnabled, __resetNoIndexEnabledForTest } from '../../utils/robotsConfig.js';

afterEach(() => {
  __resetNoIndexEnabledForTest();
});

function makeRes() {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  let contentType: string | undefined;
  const res = {
    setHeader: vi.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    type: vi.fn((t: string) => {
      contentType = t;
      return res;
    }),
    send: vi.fn((b: string) => {
      body = b;
      return res;
    }),
  } as unknown as Response;
  return {
    res,
    getHeader: (k: string) => headers[k],
    getBody: () => body,
    getContentType: () => contentType,
  };
}

describe('robotsTagMiddleware', () => {
  it('sets X-Robots-Tag: noindex, nofollow when enabled', () => {
    setNoIndexEnabled(true);
    const { res, getHeader } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    robotsTagMiddleware({} as Request, res, next);

    expect(getHeader('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(next).toHaveBeenCalledOnce();
  });

  it('does NOT set X-Robots-Tag when disabled (default)', () => {
    const { res, getHeader } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    robotsTagMiddleware({} as Request, res, next);

    expect(getHeader('X-Robots-Tag')).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('robotsTxtHandler', () => {
  it('serves a disallow-all body when enabled', () => {
    setNoIndexEnabled(true);
    const { res, getBody, getContentType } = makeRes();

    robotsTxtHandler({} as Request, res);

    expect(getContentType()).toBe('text/plain');
    expect(getBody()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('serves a permissive body when disabled (default)', () => {
    const { res, getBody, getContentType } = makeRes();

    robotsTxtHandler({} as Request, res);

    expect(getContentType()).toBe('text/plain');
    expect(getBody()).toBe('User-agent: *\nDisallow:\n');
  });
});
