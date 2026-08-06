/**
 * Neighbor Info request error → toast mapping (issue #4568).
 *
 * `POST /api/neighborinfo/request` rejects for two ordinary, expected reasons
 * beyond the TX-disabled case:
 *
 *   - **403** — the request targets neither the local node nor a directly-heard
 *     (0-hop) node. Deliberate eligibility scoping in `meshRequestRoutes.ts`.
 *   - **429** — one request per destination per 3 minutes, matching the
 *     firmware's own answer rate. The body carries `retryAfter` in seconds.
 *
 * `App.tsx` used to toast only for TX-disabled and fall through to a bare
 * `return` for both of these, so the button cleared its spinner and said
 * nothing. On a LAN the round trip is milliseconds, so the user saw a flash
 * and no explanation.
 *
 * This lives outside `App.tsx` because that component cannot be rendered in a
 * test, which is why the gap went uncaught in the first place. Pure, no React,
 * no I/O — the same rationale as `txDisabled.ts` next door.
 *
 * The TX-disabled case is deliberately NOT handled here: it needs the caller's
 * MeshCore-vs-Meshtastic context to pick its string, so it stays at the call
 * site and is checked first.
 */

/** A toast the caller should show: an i18n key, its params, and a severity. */
export interface NeighborInfoErrorToast {
  key: string;
  params?: Record<string, unknown>;
  variant: 'warning' | 'error';
}

/**
 * Shape of the parsed error body; every field optional since it may be `{}`.
 *
 * The two endpoints this helper serves spell the countdown differently:
 * Meshtastic's `/api/neighborinfo/request` sends `retryAfter`, MeshCore's
 * `/meshcore/neighbors/request` sends `retryAfterSecs`. Both are read, so a
 * MeshCore 429 reports a real number instead of silently degrading to the
 * generic wording.
 */
interface NeighborInfoErrorBody {
  error?: unknown;
  retryAfter?: unknown;
  retryAfterSecs?: unknown;
}

/**
 * Map a failed neighbor-info response to the toast to show.
 *
 * Never returns null — an unrecognized status still produces a toast, so no
 * rejection can be silent again. `fallbackError` supplies the localized
 * "Unknown error" text for the catch-all when the server sent no message.
 */
export function resolveNeighborInfoErrorToast(
  status: number,
  body: unknown,
  fallbackError: string,
): NeighborInfoErrorToast {
  const parsed: NeighborInfoErrorBody =
    typeof body === 'object' && body !== null ? (body as NeighborInfoErrorBody) : {};

  if (status === 403) {
    return { key: 'toast.neighbor_info_not_eligible', variant: 'warning' };
  }

  if (status === 429) {
    // Only interpolate a countdown when the server actually sent a usable one,
    // rather than rendering "Try again in undefineds".
    //
    // Both spellings are accepted — see NeighborInfoErrorBody. In practice one
    // of them is always present (each endpoint always sends its own), so the
    // generic branch below is defensive only. That is why its wording stays
    // source-neutral: it must not assert Meshtastic's 3-minute firmware rule,
    // which does not describe MeshCore's "too soon since last transmission"
    // throttle.
    const retryAfter = typeof parsed.retryAfter === 'number' ? parsed.retryAfter : parsed.retryAfterSecs;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
      return {
        key: 'toast.neighbor_info_rate_limited_seconds',
        params: { seconds: Math.ceil(retryAfter) },
        variant: 'warning',
      };
    }
    return { key: 'toast.neighbor_info_rate_limited', variant: 'warning' };
  }

  // Catch-all. Prefer the server's own message when present — it is the most
  // specific thing available — else the caller's localized fallback.
  const serverError = typeof parsed.error === 'string' && parsed.error.trim().length > 0
    ? parsed.error
    : fallbackError;
  return { key: 'toast.neighbor_info_failed', params: { error: serverError }, variant: 'error' };
}
