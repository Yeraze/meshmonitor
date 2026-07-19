/**
 * Robots / search-indexing middleware (issue #4202).
 *
 * When the global `noIndexEnabled` setting is on, discourage search engines and
 * LLM crawlers from indexing the dashboard via two independent mechanisms:
 *
 *   - {@link robotsTagMiddleware}: adds an `X-Robots-Tag: noindex, nofollow`
 *     response header to every request.
 *   - {@link robotsTxtHandler}: serves a disallow-all `/robots.txt` body.
 *
 * Both read the cached flag from `robotsConfig` (zero DB reads on the hot path).
 * The `/robots.txt` body is offered in addition to the header because some
 * reverse proxies (e.g. Cloudflare tunnels) strip custom response headers at
 * the edge but never rewrite response bodies.
 */

import { Request, Response, NextFunction } from 'express';
import { getNoIndexEnabled } from '../../utils/robotsConfig.js';

/**
 * Set `X-Robots-Tag: noindex, nofollow` on every response when the global
 * no-index gate is enabled. A no-op (just calls `next()`) when disabled.
 */
export function robotsTagMiddleware(_req: Request, res: Response, next: NextFunction): void {
  if (getNoIndexEnabled()) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
}

/**
 * Serve `/robots.txt`. When the gate is enabled, disallow all crawlers;
 * otherwise return a permissive file that allows everything.
 */
export function robotsTxtHandler(_req: Request, res: Response): void {
  res.type('text/plain');
  if (getNoIndexEnabled()) {
    res.send('User-agent: *\nDisallow: /\n');
  } else {
    res.send('User-agent: *\nDisallow:\n');
  }
}
