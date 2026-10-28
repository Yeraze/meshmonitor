/**
 * Compresses HTTP responses: API JSON, HTML and static JS/CSS/JSON.
 * Browsers that offer brotli get brotli (quality 4, the library default);
 * the rest get gzip.
 *
 * Measured on a large multi-source install, the unified dashboard JSON fell
 * from 36 MB to ~2.3 MB on the wire and a cold load's JS from 5 MB to
 * ~1.35 MB.
 *
 * Choices:
 * - `threshold: 1024` — below ~1 KB the gzip header and the CPU cost outweigh
 *   the saving.
 * - `level: 6` (gzip) — zlib's default; it trades well between size and CPU.
 *   Higher levels cost far more CPU on the 30 MB+ dashboard payloads for a
 *   few percent less output. Brotli keeps the library's quality 4 for the
 *   same reason.
 *
 * Responses we never compress (see {@link shouldCompress}):
 * - file downloads (`Content-Disposition: attachment`). The exports stream
 *   rows with `res.write()` and wait on `drain`; `compression` moves `drain`
 *   onto its zlib stream but not `res.off('drain')`, so a long export would
 *   pile up listeners. Backups and zips are already compressed anyway.
 * - Server-Sent Events (`text/event-stream`), which need each write flushed.
 * - anything `compressible` does not list (images, gzip, zip, octet-stream).
 * - requests that send `x-no-compression`.
 *
 * socket.io is not affected: it attaches to the HTTP server itself and answers
 * its own path before Express sees the request.
 *
 * Behind a reverse proxy that compresses too, nothing changes: the proxy sees
 * `Content-Encoding: gzip` and passes the body through.
 */
import compression from 'compression';
import type { Request, RequestHandler, Response } from 'express';

export const COMPRESSION_THRESHOLD_BYTES = 1024;
export const COMPRESSION_LEVEL = 6;

export function shouldCompress(req: Request, res: Response): boolean {
  if (req.headers['x-no-compression']) return false;

  const disposition = res.getHeader('Content-Disposition');
  if (typeof disposition === 'string' && /^\s*attachment/i.test(disposition)) return false;

  const type = res.getHeader('Content-Type');
  if (typeof type === 'string' && type.toLowerCase().startsWith('text/event-stream')) return false;

  return compression.filter(req, res);
}

export function httpCompression(): RequestHandler {
  return compression({
    threshold: COMPRESSION_THRESHOLD_BYTES,
    level: COMPRESSION_LEVEL,
    filter: shouldCompress,
  });
}
