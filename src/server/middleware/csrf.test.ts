import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock the DB singleton so the Bearer-token branch is deterministic without a
// real database: the CSRF middleware now validates the token value (#6050).
vi.mock('../../services/database.js', () => ({
  default: { validateApiTokenAsync: vi.fn() },
}));

import { csrfProtection } from './csrf.js';
import databaseService from '../../services/database.js';

const validateApiTokenAsync = databaseService.validateApiTokenAsync as unknown as ReturnType<typeof vi.fn>;

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

  it('skips CSRF check for a VALID API token (Bearer)', async () => {
    validateApiTokenAsync.mockResolvedValueOnce({ id: 1, isActive: true });
    const req = makeReq({ headers: { authorization: 'Bearer mm_v1_valid' } });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await csrfProtection(req, res, next);

    expect(validateApiTokenAsync).toHaveBeenCalledWith('mm_v1_valid');
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it('ENFORCES CSRF when the Bearer token is bogus (#6050)', async () => {
    // Regression: a bogus Bearer value must not bypass CSRF. The request is
    // really authenticated by a (CSRF-able) session cookie, so CSRF still runs.
    validateApiTokenAsync.mockResolvedValueOnce(null);
    const req = makeReq({
      session: { csrfToken: 'server-token' } as any,
      headers: { authorization: 'Bearer bypass' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CSRF_TOKEN_REQUIRED');
  });

  it('ENFORCES CSRF when the Bearer token belongs to an inactive user', async () => {
    validateApiTokenAsync.mockResolvedValueOnce({ id: 1, isActive: false });
    const req = makeReq({
      session: { csrfToken: 'server-token' } as any,
      headers: { authorization: 'Bearer mm_v1_inactive' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('fails closed (enforces CSRF) when token validation throws', async () => {
    validateApiTokenAsync.mockRejectedValueOnce(new Error('db down'));
    const req = makeReq({
      session: { csrfToken: 'server-token' } as any,
      headers: { authorization: 'Bearer mm_v1_whatever' },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
