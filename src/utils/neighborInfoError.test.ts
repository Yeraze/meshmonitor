/**
 * Neighbor Info error → toast mapping (#4568).
 *
 * The reported symptom was a button that "just flashes": clicking Request
 * Neighbor Info on a multi-hop node cleared its spinner and said nothing,
 * because `App.tsx` toasted only for the TX-disabled case and returned
 * silently for the 403 (ineligible) and 429 (rate-limited) rejections the
 * server actually sends.
 *
 * The mapping lives in a pure helper precisely so it can be tested — `App.tsx`
 * is not renderable in a unit test, which is why the gap survived unnoticed.
 */
import { describe, it, expect } from 'vitest';
import { resolveNeighborInfoErrorToast } from './neighborInfoError';

const FALLBACK = 'Unknown error';

describe('resolveNeighborInfoErrorToast (#4568)', () => {
  it('explains a 403 as an eligibility problem, not a failure', () => {
    // The exact reported case: a multi-hop node. It is a warning rather than
    // an error — the request was well-formed, the node just isn't eligible.
    const toast = resolveNeighborInfoErrorToast(403, {
      error: 'Neighbor info requests are only allowed for the local node or directly-heard (0-hop) nodes',
      eligible: false,
    }, FALLBACK);

    expect(toast).toEqual({ key: 'toast.neighbor_info_not_eligible', variant: 'warning' });
  });

  it('surfaces the remaining wait on a 429', () => {
    const toast = resolveNeighborInfoErrorToast(429, { error: 'Rate limited', retryAfter: 142 }, FALLBACK);

    expect(toast.key).toBe('toast.neighbor_info_rate_limited_seconds');
    expect(toast.params).toEqual({ seconds: 142 });
    expect(toast.variant).toBe('warning');
  });

  it('rounds a fractional retryAfter up rather than rendering a decimal', () => {
    const toast = resolveNeighborInfoErrorToast(429, { retryAfter: 12.3 }, FALLBACK);
    expect(toast.params).toEqual({ seconds: 13 });
  });

  it('reads MeshCore\'s retryAfterSecs spelling too', () => {
    // The same handler serves both sources and they name the field
    // differently: Meshtastic sends `retryAfter`, MeshCore sends
    // `retryAfterSecs`. Reading only the former silently degraded every
    // MeshCore 429 to the generic wording.
    const toast = resolveNeighborInfoErrorToast(429, {
      error: 'Too soon since last mesh transmission; retry in 8s',
      retryAfterSecs: 8,
    }, FALLBACK);

    expect(toast.key).toBe('toast.neighbor_info_rate_limited_seconds');
    expect(toast.params).toEqual({ seconds: 8 });
  });

  it('prefers retryAfter when a body somehow carries both spellings', () => {
    const toast = resolveNeighborInfoErrorToast(429, { retryAfter: 30, retryAfterSecs: 8 }, FALLBACK);
    expect(toast.params).toEqual({ seconds: 30 });
  });

  it('falls back cleanly when retryAfter is unusable but retryAfterSecs is good', () => {
    const toast = resolveNeighborInfoErrorToast(429, { retryAfter: 'soon', retryAfterSecs: 45 }, FALLBACK);
    expect(toast.params).toEqual({ seconds: 45 });
  });

  it.each([
    ['missing', {}],
    ['a string', { retryAfter: 'soon' }],
    ['zero', { retryAfter: 0 }],
    ['negative', { retryAfter: -5 }],
    ['NaN', { retryAfter: Number.NaN }],
  ])('falls back to the 3-minute wording when retryAfter is %s', (_label, body) => {
    // Guards the "Try again in undefineds" class of bug.
    const toast = resolveNeighborInfoErrorToast(429, body, FALLBACK);
    expect(toast.key).toBe('toast.neighbor_info_rate_limited');
    expect(toast.params).toBeUndefined();
  });

  it('prefers the server message for an unrecognized status', () => {
    const toast = resolveNeighborInfoErrorToast(500, { error: 'Node manager unavailable' }, FALLBACK);

    expect(toast.key).toBe('toast.neighbor_info_failed');
    expect(toast.params).toEqual({ error: 'Node manager unavailable' });
    expect(toast.variant).toBe('error');
  });

  it.each([
    ['an empty body', {}],
    ['a whitespace-only message', { error: '   ' }],
    ['a non-string message', { error: 42 }],
    ['a null body', null],
    ['a non-object body', 'boom'],
  ])('uses the localized fallback for %s', (_label, body) => {
    const toast = resolveNeighborInfoErrorToast(500, body, FALLBACK);
    expect(toast.params).toEqual({ error: FALLBACK });
  });

  it('never returns a null/undefined toast for any status — nothing is silent', () => {
    // The regression this whole change exists to prevent: a status that falls
    // through every branch and produces no user-visible feedback.
    for (const status of [400, 401, 403, 404, 409, 429, 500, 502, 503, 418]) {
      const toast = resolveNeighborInfoErrorToast(status, {}, FALLBACK);
      expect(toast, `status ${status} produced no toast`).toBeTruthy();
      expect(toast.key.length, `status ${status} produced an empty key`).toBeGreaterThan(0);
    }
  });
});
