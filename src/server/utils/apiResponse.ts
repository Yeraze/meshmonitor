import type { Response } from 'express';

/**
 * Standard MeshMonitor success envelope: `{ success: true, data? }`.
 *
 * IMPORTANT: the frontend `ApiService.request()` returns the raw JSON body and
 * does NOT unwrap `data`. Only use `ok()` on a handler that already emits
 * `{ success: true, data }` (or `{ success: true }`), or update the consumer in
 * the same change. Do NOT convert handlers that return a bare payload
 * (`res.json(array)`, `res.json({ deletedCount })`) — that changes the wire shape.
 *
 * @param res   Express response.
 * @param data  Optional payload placed under `data`. Omit for `{ success: true }`.
 */
export function ok<T>(res: Response, data?: T): Response {
  return res.json(data === undefined ? { success: true } : { success: true, data });
}

/**
 * Standard MeshMonitor error envelope: `{ success: false, error, code, ...extra }`.
 * Matches what `ApiService` parses: `error` (message), `code` (machine code),
 * plus optional fields it forwards such as `retryAfterSeconds`.
 *
 * @param res      Express response.
 * @param status   HTTP status (4xx/5xx).
 * @param code     SCREAMING_SNAKE machine code (e.g. 'MISSING_SOURCE_ID').
 * @param message  Human-readable message (becomes `ApiError.message` on the client).
 * @param extra    Optional additional top-level fields (e.g. `{ details }`,
 *                 `{ retryAfterSeconds }`). Kept minimal.
 */
export function fail(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return res.status(status).json({ success: false, error: message, code, ...extra });
}
