import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { csrfProtection } from './csrf.js';

function makeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: any } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as any;
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res as Response;
  }) as any;
  return res as Response & { statusCode?: number; body?: any };
}

function makeReq(overrides: Record<string, any> = {}): Request {
  return {
    method: 'POST',
    path: '/some-mutation',
    headers: {},
    body: {},
    session: {},
    ...overrides,
  } as unknown as Request;
}

describe('csrfProtection middleware error codes (#2783)', () => {
  it('returns code CSRF_SESSION_MISSING when session has no token', () => {
    const req = makeReq({ session: {} as any, headers: { 'x-csrf-token': 'abc' } });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CSRF_SESSION_MISSING');
  });

  it('returns code CSRF_TOKEN_REQUIRED when request has no token', () => {
    const req = makeReq({ session: { csrfToken: 'server-token' } as any });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CSRF_TOKEN_REQUIRED');
  });

  it('returns code CSRF_TOKEN_INVALID on length mismatch', () => {
    const req = makeReq({
      session: { csrfToken: 'a'.repeat(64) } as any,
      headers: { 'x-csrf-token': 'short' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('returns code CSRF_TOKEN_INVALID on same-length mismatch', () => {
    const req = makeReq({
      session: { csrfToken: 'a'.repeat(64) } as any,
      headers: { 'x-csrf-token': 'b'.repeat(64) },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('calls next() when tokens match', () => {
    const token = 'a'.repeat(64);
    const req = makeReq({
      session: { csrfToken: token } as any,
      headers: { 'x-csrf-token': token },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it('skips CSRF check for GET requests', () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it('skips CSRF check for Bearer-authenticated requests', () => {
    const req = makeReq({ headers: { authorization: 'Bearer token-xyz' } });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });
});
