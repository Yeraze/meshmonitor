/**
 * Request timeout handling that never makes a browser resend a request.
 *
 * `server.setTimeout(30000)` (server.ts) used to destroy the socket of any
 * request still running at 30 s, with no response. Browsers treat a connection
 * closed before any response as a network failure and silently resend the
 * request — POSTs included. Every resend re-runs the handler, so a slow radio
 * operation re-transmitted on RF every 30 s for as long as the page stayed
 * open (MeshCore Trace Path: 9 traces from one click).
 *
 * {@link respondOnSocketTimeout} registers a `timeout` listener on each
 * response. Node's HTTP server only destroys a timed-out socket when nobody
 * listens, so the listener takes over: it answers `504 REQUEST_TIMEOUT`, which
 * the browser accepts as a reply and does not retry. The handler keeps running
 * to completion; its late reply is dropped.
 *
 * {@link extendRequestTimeout} raises the socket timeout for one route whose
 * handler legitimately waits longer than 30 s (radio round trips), so the user
 * gets the real result instead of the 504.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Socket } from 'net';
import { logger } from '../../utils/logger.js';

/** The default socket timeout set on the HTTP server (server.ts). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function respondOnSocketTimeout(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.on('timeout', (socket: Socket) => {
      if (res.headersSent) {
        // Already streaming (e.g. a long download); nothing to answer with.
        // Same as Node's default for a timed-out socket.
        socket.destroy();
        return;
      }
      logger.warn(`[HTTP] ${req.method} ${req.originalUrl} still running after its socket timeout; answering 504 so the client does not resend it`);
      res.status(504).json({
        success: false,
        error: 'The request took too long. It may still complete in the background; check before retrying.',
        code: 'REQUEST_TIMEOUT',
      });
      // The handler is still running and will try to reply. Drop that reply
      // instead of throwing ERR_HTTP_HEADERS_SENT.
      const drop = () => res;
      res.json = drop as Response['json'];
      res.send = drop as Response['send'];
    });
    next();
  };
}

/** Raise this route's socket timeout to `ms` (use for radio waits over 30 s). */
export function extendRequestTimeout(ms: number): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.setTimeout(ms);
    next();
  };
}
