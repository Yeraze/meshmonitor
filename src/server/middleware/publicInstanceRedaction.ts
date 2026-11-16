/**
 * Public-instance redaction middleware (#5156, Phase 1).
 *
 * Wraps `res.json/send/write/end` at mount time and decides at the first send
 * or write, after per-route auth middleware has set `req.user`. With the mode
 * off, or for a signed-in viewer, the original methods run untouched.
 *
 * For an anonymous viewer on a 2xx response:
 *  - JSON bodies (and JSON strings sent via `send`) are parsed and redacted;
 *  - a content-type allow-list passes inert assets (images, fonts, tiles, css, js);
 *  - everything else (CSV, NDJSON, archives, HTML, unknown) is blocked, because
 *    it cannot be redacted reliably by field name.
 * A redaction failure answers 503 and never leaks the original body.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getPublicInstanceConfig } from '../services/publicInstanceConfig.js';
import { redactPublicPayload } from '../utils/publicInstanceRedactor.js';
import { isAnonymousViewer } from '../utils/mqttConsentVisibility.js';
import { fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';

const PUBLIC_INSTANCE_REDACTION = Symbol.for('meshmonitor.publicInstanceRedaction');

/** True when `handle` was built by `publicInstanceRedaction()`. */
export function isPublicInstanceRedaction(handle: unknown): boolean {
  return (handle as { [PUBLIC_INSTANCE_REDACTION]?: true } | null | undefined)?.[PUBLIC_INSTANCE_REDACTION] === true;
}

export interface PublicInstanceRedactionOptions {
  /** Treat every request as anonymous (the embed router). */
  forceAnonymous?: boolean;
}

/** Mark a response as operator-authored content that must not be snapped. */
export function markPublicInstanceExempt(res: Response): void {
  res.locals.publicInstanceExempt = true;
}

const PASS_EXACT = new Set([
  'application/x-protobuf',
  'application/vnd.mapbox-vector-tile',
  'text/css',
  'application/javascript',
  'text/javascript',
]);

type Verdict = 'json' | 'pass' | 'block';

function classify(contentType: string, exempt: boolean): Verdict {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime === 'application/json' || mime.endsWith('+json')) return exempt ? 'pass' : 'json';
  if (mime.startsWith('image/') || mime.startsWith('font/') || PASS_EXACT.has(mime)) return 'pass';
  if (mime === 'application/octet-stream') return exempt ? 'pass' : 'block';
  return 'block';
}

function hasData(chunk: unknown): boolean {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return false;
  if (typeof chunk === 'string') return chunk.length > 0;
  if (chunk instanceof Uint8Array) return chunk.length > 0;
  return true;
}

export function publicInstanceRedaction(opts: PublicInstanceRedactionOptions = {}): RequestHandler {
  const handler = (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/v1' || req.path.startsWith('/v1/')) return next();

    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
    const origEnd = res.end.bind(res) as (...a: unknown[]) => Response;

    let active: boolean | undefined;
    let passthrough = false;
    let blocked = false;
    let streamChecked = false;

    let configError = false;

    const isActive = (): boolean => {
      if (active !== undefined) return active;
      // Decide anonymity first: a signed-in viewer is never redacted, so a
      // config failure only matters (fail closed) for an anonymous one.
      // `isAnonymousViewer(req.user)` alone is not enough: req.user is only set by
      // per-route auth middleware, and a route with none leaves it empty even for a
      // signed-in session. `!req.session?.userId` catches that case. This decision
      // runs at send time, after route auth, which only works while this middleware
      // stays the FIRST apiRouter handler (it wraps res.* before any route runs).
      const anonymous = opts.forceAnonymous === true || (isAnonymousViewer(req.user) && !req.session?.userId);
      let enabled: boolean;
      try {
        enabled = getPublicInstanceConfig().enabled;
      } catch {
        logger.error(`[PublicInstance] config unavailable for ${req.method} ${req.baseUrl}${req.path}`);
        configError = anonymous;
        active = anonymous;
        return active;
      }
      if (!enabled) {
        active = false;
        return false;
      }
      if (!res.headersSent) {
        res.vary('Cookie');
        res.vary('Authorization');
      }
      active = anonymous;
      return active;
    };

    const guarded = <T>(fn: () => T): T => {
      const prev = passthrough;
      passthrough = true;
      try {
        return fn();
      } finally {
        passthrough = prev;
      }
    };

    const block = (): void => {
      blocked = true;
      if (res.headersSent) {
        guarded(() => origEnd());
        return;
      }
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Encoding');
      guarded(() => fail(res, 403, 'PUBLIC_INSTANCE_UNSUPPORTED_RESPONSE', 'Not available on this public instance.'));
    };

    const failRedaction = (): void => {
      logger.error(`[PublicInstance] redaction failed for ${req.method} ${req.baseUrl}${req.path}`);
      blocked = true;
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      guarded(() => fail(res, 503, 'PUBLIC_REDACTION_FAILED', 'This response could not be prepared for public viewing.'));
    };

    res.json = ((body?: unknown) => {
      if (passthrough || blocked || !isActive()) return passthrough || !blocked ? origJson(body) : res;
      if (configError) {
        failRedaction();
        return res;
      }
      let redacted: unknown;
      try {
        redacted = redactPublicPayload(body, getPublicInstanceConfig());
      } catch {
        failRedaction();
        return res;
      }
      return guarded(() => origJson(redacted));
    }) as Response['json'];

    res.send = ((body?: unknown) => {
      if (passthrough) return origSend(body);
      if (blocked) return res;
      if (!isActive()) return origSend(body);
      const stringy = typeof body === 'string' || Buffer.isBuffer(body);
      // Objects route through res.json (redacted there); nothing to inspect here.
      if (!stringy || res.statusCode >= 300 || !hasData(body)) return origSend(body);
      if (configError) {
        failRedaction();
        return res;
      }
      const exempt = res.locals.publicInstanceExempt === true;
      const verdict = classify(String(res.get('Content-Type') ?? ''), exempt);
      if (verdict === 'block') {
        block();
        return res;
      }
      if (verdict === 'pass') return guarded(() => origSend(body));
      let redacted: string;
      try {
        const parsed: unknown = JSON.parse(body.toString());
        redacted = JSON.stringify(redactPublicPayload(parsed, getPublicInstanceConfig()));
      } catch {
        failRedaction();
        return res;
      }
      return guarded(() => origSend(redacted));
    }) as Response['send'];

    /** First data-bearing write/end: true means "let it through". */
    const streamAllowed = (chunk: unknown): boolean => {
      if (passthrough) return true;
      if (blocked) return false;
      if (streamChecked || !isActive()) return true;
      if (!hasData(chunk) || res.statusCode >= 300) return true;
      streamChecked = true;
      if (configError) {
        failRedaction();
        return false;
      }
      const exempt = res.locals.publicInstanceExempt === true;
      // Streamed JSON cannot be redacted, so only an exempt one passes.
      if (classify(String(res.get('Content-Type') ?? ''), exempt) === 'pass') return true;
      block();
      return false;
    };

    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (!streamAllowed(chunk)) return true;
      return origWrite(chunk, ...rest);
    }) as Response['write'];

    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (blocked && !passthrough) return res;
      if (!streamAllowed(chunk)) return res;
      return origEnd(chunk, ...rest);
    }) as Response['end'];

    next();
  };
  (handler as unknown as { [PUBLIC_INSTANCE_REDACTION]: true })[PUBLIC_INSTANCE_REDACTION] = true;
  return handler;
}
