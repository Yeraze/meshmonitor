/**
 * adsbFeedClient with the OpenSky feed (#5877): bbox request, Bearer auth
 * (never the shared X-API-Key), one 401 retry, Retry-After on 429.
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchAircraftNear, AdsbFeedError, ADSB_API_KEY_HEADER, type AdsbHttpFn, type AdsbOAuthHook } from './adsbFeedClient.js';
import { ADSB_FEEDS } from '../../utils/adsbFeeds.js';
import { OPENSKY_STATES_URL, OPENSKY_RETRY_AFTER_HEADER } from '../../utils/openSky.js';

const OPENSKY = ADSB_FEEDS.opensky;
const BODY = {
  time: 100,
  states: [['a3f1c2', 'AAL1498 ', 'US', 98, 99, -80.3, 25.81, 3000, false, 128.6, 92.5, 0, null, 3050, null, false, 0]],
};

function headersOf(map: Record<string, string>) {
  return { get: (n: string) => map[n] ?? null };
}

function respond(...responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { status: r.status, json: async () => r.body, headers: headersOf(r.headers ?? {}) };
  }) as ReturnType<typeof vi.fn> & AdsbHttpFn;
}

function oauth(tokens = ['tok-1', 'tok-2']): AdsbOAuthHook & { getToken: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> } {
  let i = 0;
  return { getToken: vi.fn(async () => tokens[Math.min(i++, tokens.length - 1)]), invalidate: vi.fn() };
}

describe('fetchAircraftNear — OpenSky (#5877)', () => {
  it('sends a bbox query with a Bearer token and never the shared API key', async () => {
    const http = respond({ status: 200, body: BODY });
    const ac = await fetchAircraftNear(OPENSKY, 25.8, -80.3, 3, { token: 'shared-key', oauth: oauth(), http });
    expect(ac).toHaveLength(1);
    expect(ac[0]).toMatchObject({ hex: 'a3f1c2', flight: 'AAL1498', seen_pos: 2 });
    const [url, init] = http.mock.calls[0];
    expect(url.startsWith(`${OPENSKY_STATES_URL}?lamin=`)).toBe(true);
    expect(url).toContain('&lomin=');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(init.headers).not.toHaveProperty(ADSB_API_KEY_HEADER);
    expect(Object.values(init.headers)).not.toContain('shared-key');
  });

  it('a readsb feed still gets the shared key and no Authorization', async () => {
    const http = respond({ status: 200, body: { ac: [] } });
    await fetchAircraftNear(ADSB_FEEDS['adsb.lol'], 25.8, -80.3, 3, { token: 'shared-key', oauth: oauth(), http });
    const [, init] = http.mock.calls[0];
    expect(init.headers[ADSB_API_KEY_HEADER]).toBe('shared-key');
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('refuses to call OpenSky without credentials (no anonymous mode)', async () => {
    const http = respond({ status: 200, body: BODY });
    await expect(fetchAircraftNear(OPENSKY, 25.8, -80.3, 3, { http })).rejects.toMatchObject({ kind: 'auth', backoff: false });
    expect(http).not.toHaveBeenCalled();
  });

  it('on a 401 drops the token and retries once with a fresh one', async () => {
    const http = respond({ status: 401 }, { status: 200, body: BODY });
    const hook = oauth();
    const ac = await fetchAircraftNear(OPENSKY, 25.8, -80.3, 3, { oauth: hook, http });
    expect(ac).toHaveLength(1);
    expect(hook.invalidate).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(2);
    expect(http.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-2');
  });

  it('a second 401 is a backoff error, not another retry', async () => {
    const http = respond({ status: 401 }, { status: 401 });
    const err = await fetchAircraftNear(OPENSKY, 25.8, -80.3, 3, { oauth: oauth(), http }).catch((e) => e);
    expect(err).toBeInstanceOf(AdsbFeedError);
    expect(err).toMatchObject({ status: 401, backoff: true });
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('reads the Retry-After seconds off a 429', async () => {
    const http = respond({ status: 429, headers: { [OPENSKY_RETRY_AFTER_HEADER]: '3600' } });
    const err = await fetchAircraftNear(OPENSKY, 25.8, -80.3, 3, { oauth: oauth(), http }).catch((e) => e);
    expect(err).toMatchObject({ status: 429, backoff: true, retryAfterMs: 3_600_000 });
  });

  it('a 429 without the header has no retryAfterMs (falls back to the fixed backoff)', async () => {
    const http = respond({ status: 429 });
    const err = await fetchAircraftNear(OPENSKY, 25.8, -80.3, 3, { oauth: oauth(), http }).catch((e) => e);
    expect(err).toMatchObject({ status: 429, backoff: true, retryAfterMs: null });
  });

  it('a readsb feed ignores the OpenSky Retry-After header', async () => {
    const http = respond({ status: 429, headers: { [OPENSKY_RETRY_AFTER_HEADER]: '3600' } });
    const err = await fetchAircraftNear(ADSB_FEEDS['adsb.lol'], 25.8, -80.3, 3, { http }).catch((e) => e);
    expect(err.retryAfterMs).toBeNull();
  });

  it('a malformed body is a parse error', async () => {
    const http = respond({ status: 200, body: { states: 'x' } });
    await expect(fetchAircraftNear(OPENSKY, 25.8, -80.3, 3, { oauth: oauth(), http })).rejects.toMatchObject({ kind: 'parse' });
  });
});
