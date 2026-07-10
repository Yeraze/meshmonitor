/**
 * Strict `sourceId` guard.
 *
 * Unlike `resolveRequestSourceId` (which falls back to the caller's first
 * permitted source), this middleware REQUIRES an explicit `sourceId` and
 * rejects its absence with a 400 `MISSING_SOURCE_ID`. Use it on endpoints that
 * interact with a single source's rows and must neither silently span all
 * sources nor throw inside `withSourceScope`.
 *
 * On success it stashes the validated value on `req.scopedSourceId` so the
 * handler can read it without re-parsing.
 *
 * `from` selects where to look:
 *   - `'query'`  → `req.query.sourceId`
 *   - `'body'`   → `req.body.sourceId`
 *   - `'either'` → query first, then body (for endpoints reachable via GET and
 *                  mutation verbs)
 */
import type { Request, Response, NextFunction } from 'express';
import { fail } from './apiResponse.js';

export function requireSourceId(from: 'query' | 'body' | 'either' = 'either') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fromQuery = req.query?.sourceId;
    const fromBody = req.body?.sourceId;
    const raw =
      from === 'query' ? fromQuery : from === 'body' ? fromBody : (fromQuery ?? fromBody);

    if (raw === undefined || raw === null || raw === '') {
      fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId is required');
      return;
    }
    if (typeof raw !== 'string') {
      fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId must be a string');
      return;
    }
    (req as unknown as { scopedSourceId?: string }).scopedSourceId = raw;
    next();
  };
}
