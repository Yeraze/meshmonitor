/**
 * TX-disabled detection helpers (epic #4294, Phase 2).
 *
 * Phase 1 (backend) maps every transmit-primitive failure caused by a
 * source's TX being disabled to `fail(res, 409, 'TX_DISABLED', ...)`. These
 * pure predicates let both `authFetch`-based call sites (which read a raw
 * `Response` + parsed JSON body) and `apiService`-based call sites (which
 * catch a thrown `ApiError{ status, code }`) share one definition of "is
 * this a TX-disabled error" without duplicating the check or introducing a
 * shared class/hook dependency between them.
 *
 * Pure, no React, no I/O — safe to import from anywhere.
 */

export const TX_DISABLED_CODE = 'TX_DISABLED';

/** True when a parsed error body from a 409 signals TX disabled. */
export function isTxDisabledBody(status: number, body: unknown): boolean {
  return (
    status === 409 &&
    typeof body === 'object' && body !== null &&
    (body as { code?: unknown }).code === TX_DISABLED_CODE
  );
}

/** True when a thrown ApiError (or any `{ code }`-shaped value) is a TX-disabled error. */
export function isTxDisabledError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    (err as { code?: unknown }).code === TX_DISABLED_CODE
  );
}
