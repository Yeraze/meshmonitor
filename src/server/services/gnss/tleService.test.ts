/**
 * TLE service tests (#4729).
 *
 * The only mocked collaborator is `safeFetch` (ssrfGuard) — the sole outbound
 * network dependency. Covers: 3-line parsing, TTL cache-hit avoiding a refetch,
 * TTL expiry triggering a refetch, and — the load-bearing discipline — last-good
 * cache retention when a refetch fails (never caching a transient failure).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSafeFetch = vi.hoisted(() => vi.fn());
const MockSsrfBlockedError = vi.hoisted(
  () =>
    class SsrfBlockedError extends Error {
      reason: string;
      constructor(message: string, reason = 'blocked') {
        super(message);
        this.name = 'SsrfBlockedError';
        this.reason = reason;
      }
    }
);
vi.mock('../../utils/ssrfGuard.js', () => ({
  safeFetch: mockSafeFetch,
  SsrfBlockedError: MockSsrfBlockedError,
}));

import {
  tleService,
  parseTleText,
  celestrakUrl,
  CELESTRAK_GROUPS,
  TLE_CACHE_TTL_MS,
} from './tleService.js';

// A tiny but valid 3-line TLE body (2 GPS sats). Checksums are real.
const TLE_BODY_A = [
  'GPS BIIR-5  (PRN 22)',
  '1 26407U 00040A   26230.62233409  .00000059  00000+0  00000+0 0  9997',
  '2 26407  54.8442 212.6831 0119403 303.2745  60.7622  2.00558203191204',
  'GPS BIIR-8  (PRN 16)',
  '1 27663U 03005A   26229.94485694  .00000054  00000+0  00000+0 0  9999',
  '2 27663  54.8743 212.5159 0149230  53.3719 317.7217  2.00557285172551',
].join('\n');

const TLE_BODY_B = [
  'GPS BIIR-11 (PRN 19)',
  '1 28190U 04009A   26230.36894583 -.00000017  00000+0  00000+0 0  9999',
  '2 28190  54.7807 273.1702 0118117 175.7546 293.4353  2.00552583164199',
].join('\n');

function textResponse(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body };
}

describe('parseTleText', () => {
  it('parses well-formed 3-line records', () => {
    const tles = parseTleText(TLE_BODY_A);
    expect(tles).toHaveLength(2);
    expect(tles[0].name).toBe('GPS BIIR-5  (PRN 22)');
    expect(tles[0].line1.startsWith('1 26407U')).toBe(true);
    expect(tles[0].line2.startsWith('2 26407')).toBe(true);
    expect(tles[1].name).toBe('GPS BIIR-8  (PRN 16)');
  });

  it('tolerates blank lines and trailing whitespace', () => {
    const messy = `\n${TLE_BODY_B}   \n\n`;
    const tles = parseTleText(messy);
    expect(tles).toHaveLength(1);
    expect(tles[0].name).toBe('GPS BIIR-11 (PRN 19)');
  });

  it('drops a trailing partial record (missing line2)', () => {
    const partial = `${TLE_BODY_B}\nGPS DANGLING\n1 99999U 00000A   26230.0000  .0  0  0 0  0001`;
    const tles = parseTleText(partial);
    expect(tles).toHaveLength(1);
  });

  it('returns [] for garbage input', () => {
    expect(parseTleText('not a tle at all\njust some text')).toEqual([]);
  });

  it('resyncs past a stray header/comment line instead of dropping the rest (#4797)', () => {
    // A leading header line AND a stray line between two valid triples. The old
    // `break`-on-misalign parser stopped at the first offset misalignment and
    // returned []; the resync parser skips the stray lines and keeps both sats.
    const withStrays = [
      '# CelesTrak GPS elements (retrieved ...)',
      'GPS BIIR-5  (PRN 22)',
      '1 26407U 00040A   26230.62233409  .00000059  00000+0  00000+0 0  9997',
      '2 26407  54.8442 212.6831 0119403 303.2745  60.7622  2.00558203191204',
      '--- unexpected divider ---',
      'GPS BIIR-8  (PRN 16)',
      '1 27663U 03005A   26229.94485694  .00000054  00000+0  00000+0 0  9999',
      '2 27663  54.8743 212.5159 0149230  53.3719 317.7217  2.00557285172551',
    ].join('\n');
    const tles = parseTleText(withStrays);
    expect(tles.map((t) => t.name)).toEqual(['GPS BIIR-5  (PRN 22)', 'GPS BIIR-8  (PRN 16)']);
  });
});

describe('celestrakUrl', () => {
  it('builds the GP TLE URL for a constellation group', () => {
    const url = celestrakUrl('gps');
    expect(url).toContain('celestrak.org');
    expect(url).toContain(`GROUP=${CELESTRAK_GROUPS.gps}`);
    expect(url).toContain('FORMAT=tle');
  });
});

describe('tleService cache + last-good discipline', () => {
  beforeEach(() => {
    tleService.__resetForTests();
    mockSafeFetch.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches and parses on first request', async () => {
    mockSafeFetch.mockResolvedValueOnce(textResponse(TLE_BODY_A));
    const tles = await tleService.getTles('gps');
    expect(tles).toHaveLength(2);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('serves the cache without refetching within the TTL', async () => {
    mockSafeFetch.mockResolvedValueOnce(textResponse(TLE_BODY_A));
    await tleService.getTles('gps');

    // Advance time but stay within the TTL — must NOT refetch.
    vi.advanceTimersByTime(TLE_CACHE_TTL_MS - 1000);
    const again = await tleService.getTles('gps');
    expect(again).toHaveLength(2);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL has expired', async () => {
    mockSafeFetch.mockResolvedValueOnce(textResponse(TLE_BODY_A));
    await tleService.getTles('gps');

    vi.advanceTimersByTime(TLE_CACHE_TTL_MS + 1000);
    mockSafeFetch.mockResolvedValueOnce(textResponse(TLE_BODY_A + '\n' + TLE_BODY_B));
    const refetched = await tleService.getTles('gps');
    expect(refetched).toHaveLength(3);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('retains last-good cache when a refetch throws (never caches the failure)', async () => {
    mockSafeFetch.mockResolvedValueOnce(textResponse(TLE_BODY_A));
    const good = await tleService.getTles('gps');
    expect(good).toHaveLength(2);

    // Expire the TTL, then make the refetch throw.
    vi.advanceTimersByTime(TLE_CACHE_TTL_MS + 1000);
    mockSafeFetch.mockRejectedValueOnce(new Error('network down'));

    const stale = await tleService.getTles('gps');
    // Same last-good data — no throw, failure not cached.
    expect(stale).toHaveLength(2);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);

    // A subsequent successful fetch replaces the stale cache.
    mockSafeFetch.mockResolvedValueOnce(textResponse(TLE_BODY_B));
    const fresh = await tleService.getTles('gps');
    expect(fresh).toHaveLength(1);
    expect(mockSafeFetch).toHaveBeenCalledTimes(3);
  });

  it('retains last-good when a refetch returns a non-OK status', async () => {
    mockSafeFetch.mockResolvedValueOnce(textResponse(TLE_BODY_A));
    await tleService.getTles('gps');

    vi.advanceTimersByTime(TLE_CACHE_TTL_MS + 1000);
    mockSafeFetch.mockResolvedValueOnce(textResponse('', false, 503));
    const stale = await tleService.getTles('gps');
    expect(stale).toHaveLength(2);
  });

  it('retains last-good when a refetch returns an empty/garbled body', async () => {
    mockSafeFetch.mockResolvedValueOnce(textResponse(TLE_BODY_A));
    await tleService.getTles('gps');

    vi.advanceTimersByTime(TLE_CACHE_TTL_MS + 1000);
    mockSafeFetch.mockResolvedValueOnce(textResponse('garbage body with no tles'));
    const stale = await tleService.getTles('gps');
    expect(stale).toHaveLength(2);
  });

  it('throws when the first-ever fetch fails and there is no cache', async () => {
    mockSafeFetch.mockRejectedValueOnce(new Error('network down'));
    await expect(tleService.getTles('gps')).rejects.toThrow(/Unable to fetch TLEs/);
  });

  it('dedups concurrent requests into a single fetch', async () => {
    mockSafeFetch.mockResolvedValue(textResponse(TLE_BODY_A));
    const [a, b] = await Promise.all([tleService.getTles('gps'), tleService.getTles('gps')]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('getTlesForConstellations returns [] for a failing constellation with no cache (no throw)', async () => {
    mockSafeFetch.mockRejectedValue(new Error('network down'));
    const tles = await tleService.getTlesForConstellations(['gps']);
    expect(tles).toEqual([]);
  });

  it('getTlesForConstellations concatenates successful constellations', async () => {
    mockSafeFetch.mockResolvedValue(textResponse(TLE_BODY_A));
    const tles = await tleService.getTlesForConstellations(['gps', 'gps']);
    // Deduped to a single 'gps' fetch.
    expect(tles).toHaveLength(2);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });
});
