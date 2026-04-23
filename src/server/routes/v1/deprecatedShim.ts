/**
 * v1 API — deprecation shim for legacy (non-source-scoped) routes.
 *
 * Phase 1 of the v1-API breaking change keeps the old URL shape
 * (`/api/v1/nodes?sourceId=...`, etc.) alive for one release. Every
 * legacy response gains a `Warning: 299` header pointing callers at the
 * new `/api/v1/sources/:sourceId/...` shape, and we emit one info-level
 * log entry per request so operators can spot integrations still on the
 * old paths.
 *
 * The shim is mounted BEFORE the legacy handlers in `index.ts` — it only
 * tags the response; the underlying handler is unchanged.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../../../utils/logger.js';

const WARNING_HEADER_VALUE =
  '299 - "v1 root-path scoping is deprecated; use /api/v1/sources/:sourceId/... instead"';

export function deprecationShim(resource: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Warning', WARNING_HEADER_VALUE);
    const user = (req as any).user;
    logger.info(
      `[v1-deprecated] ${req.method} /api/v1/${resource}${req.url} user=${user?.id ?? 'anon'} sourceId=${
        (req.query?.sourceId as string | undefined) ?? '<none>'
      }`
    );
    next();
  };
}
