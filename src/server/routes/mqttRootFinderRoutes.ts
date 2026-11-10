/**
 * MQTT root topic finder (#6287).
 *
 *   POST   /api/mqtt/root-finder/samples       start a ~60 s subscribe-only sample
 *   GET    /api/mqtt/root-finder/samples/:id   poll progress and results
 *   DELETE /api/mqtt/root-finder/samples/:id   stop; partial results stay readable
 *
 * Start-and-poll, not one long request: a 60 s request would hit the 30 s
 * socket timeout and common reverse-proxy idle timeouts.
 *
 * Mesh impact: none. The sampler subscribes and never publishes; nothing here
 * writes to the database, a radio, or the event bus. A sample belongs to the
 * user who started it; anyone else gets a 404.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireAuth } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { mqttRootFinderLimiter } from '../middleware/rateLimiters.js';
import { resolveSampleTarget } from '../utils/mqttRootFinderTarget.js';
import {
  rootFinderService as defaultService,
  RootFinderBusyError,
  type RootFinderService,
} from '../services/mqttRootFinder/rootFinderService.js';
import { logger } from '../../utils/logger.js';
import type { User } from '../../types/auth.js';

export interface RootFinderRouterOptions {
  service?: RootFinderService;
  /** Outer HTTP limiter for starts. Tests pass a no-op. */
  startLimiter?: RequestHandler;
}

export function createMqttRootFinderRouter(opts: RootFinderRouterOptions = {}): Router {
  const service = opts.service ?? defaultService;
  const startLimiter = opts.startLimiter ?? mqttRootFinderLimiter;
  const router = Router();

  router.post('/samples', requireAuth(), startLimiter, async (req: Request, res: Response) => {
    try {
      const user = req.user as User;
      const resolved = await resolveSampleTarget(user, req.body);
      if ('error' in resolved) {
        return fail(res, resolved.error.status, resolved.error.code, resolved.error.message);
      }
      const t = resolved.target;
      const started = service.start({
        userId: user.id,
        endpointKey: t.endpointKey,
        broker: t.broker,
        regionRoot: t.regionRoot,
        userPos: t.userPos,
      });
      res.status(202);
      return ok(res, started);
    } catch (e) {
      if (e instanceof RootFinderBusyError) {
        res.setHeader('Retry-After', String(e.retryAfterSeconds));
        return fail(res, 429, 'ROOT_FINDER_BUSY', e.message, { retryAfterSeconds: e.retryAfterSeconds });
      }
      // Never forward the error text: it can name the broker or carry a login.
      logger.error('MQTT root finder start failed');
      return fail(res, 500, 'INTERNAL_ERROR', 'Could not start the topic search.');
    }
  });

  router.get('/samples/:id', requireAuth(), (req: Request, res: Response) => {
    const user = req.user as User;
    const view = service.get(user.id, req.params.id);
    if (!view) return fail(res, 404, 'NOT_FOUND', 'No such topic search.');
    return ok(res, view);
  });

  router.delete('/samples/:id', requireAuth(), async (req: Request, res: Response) => {
    const user = req.user as User;
    const found = await service.cancel(user.id, req.params.id);
    if (!found) return fail(res, 404, 'NOT_FOUND', 'No such topic search.');
    return ok(res);
  });

  return router;
}

export default createMqttRootFinderRouter();
