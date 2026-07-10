import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireSourceId } from './requireSourceId.js';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

function run(mw: ReturnType<typeof requireSourceId>, req: Partial<Request>) {
  const res = mockRes();
  const next = vi.fn() as unknown as NextFunction;
  mw(req as Request, res, next);
  return { res, next: next as unknown as ReturnType<typeof vi.fn> };
}

describe('requireSourceId middleware', () => {
  it('400s with MISSING_SOURCE_ID when sourceId is absent (query)', () => {
    const { res, next } = run(requireSourceId('query'), { query: {}, body: {} });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'MISSING_SOURCE_ID' });
  });

  it('400s when sourceId is an empty string', () => {
    const { res, next } = run(requireSourceId('query'), { query: { sourceId: '' }, body: {} });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('400s when sourceId is not a string (array)', () => {
    const { res, next } = run(requireSourceId('query'), { query: { sourceId: ['a', 'b'] as any }, body: {} });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_SOURCE_ID' });
  });

  it('passes and stashes scopedSourceId when present in query', () => {
    const req: any = { query: { sourceId: 'src-A' }, body: {} };
    const { res, next } = run(requireSourceId('query'), req);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(req.scopedSourceId).toBe('src-A');
  });

  it("from:'query' ignores a body sourceId", () => {
    const { next } = run(requireSourceId('query'), { query: {}, body: { sourceId: 'src-B' } });
    expect(next).not.toHaveBeenCalled();
  });

  it("from:'body' reads the body", () => {
    const req: any = { query: {}, body: { sourceId: 'src-B' } };
    const { next } = run(requireSourceId('body'), req);
    expect(next).toHaveBeenCalledOnce();
    expect(req.scopedSourceId).toBe('src-B');
  });

  it("from:'either' prefers query then falls back to body", () => {
    const q: any = { query: { sourceId: 'q' }, body: { sourceId: 'b' } };
    run(requireSourceId('either'), q);
    expect(q.scopedSourceId).toBe('q');

    const b: any = { query: {}, body: { sourceId: 'b' } };
    run(requireSourceId('either'), b);
    expect(b.scopedSourceId).toBe('b');
  });
});
