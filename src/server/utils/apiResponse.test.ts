import { describe, it, expect, vi } from 'vitest';
import { ok, fail } from './apiResponse.js';
import type { Response } from 'express';

function makeMockRes(): Response {
  const res = {
    json: vi.fn(),
    status: vi.fn(),
  } as unknown as Response;
  // status() must return the same res for chaining
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  (res.json as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('ok()', () => {
  it('wraps a payload under data', () => {
    const res = makeMockRes();
    const result = ok(res, { a: 1 });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { a: 1 } });
    expect(result).toBe(res);
  });

  it('emits { success: true } with no data key when called without a second argument', () => {
    const res = makeMockRes();
    ok(res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toEqual({ success: true });
    expect('data' in body).toBe(false);
  });

  it('includes data: null when null is passed (null is a real payload, not absence)', () => {
    const res = makeMockRes();
    ok(res, null);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: null });
  });

  it('returns the res object for chaining', () => {
    const res = makeMockRes();
    expect(ok(res, 42)).toBe(res);
  });
});

describe('fail()', () => {
  it('sets the status and emits the error envelope', () => {
    const res = makeMockRes();
    const result = fail(res, 400, 'BAD', 'nope');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'nope', code: 'BAD' });
    expect(result).toBe(res);
  });

  it('spreads extra fields into the top-level body', () => {
    const res = makeMockRes();
    fail(res, 500, 'X', 'boom', { details: 'd', retryAfterSeconds: 3 });
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'boom',
      code: 'X',
      details: 'd',
      retryAfterSeconds: 3,
    });
  });

  it('returns the res object for chaining', () => {
    const res = makeMockRes();
    expect(fail(res, 500, 'E', 'err')).toBe(res);
  });
});
