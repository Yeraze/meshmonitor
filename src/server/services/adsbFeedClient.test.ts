import { describe, it, expect, vi } from 'vitest';
import {
  fetchAircraftNear,
  parseFeedResponse,
  AdsbFeedError,
  ADSB_API_KEY_HEADER,
  ADSB_USER_AGENT,
  type AdsbHttpFn,
} from './adsbFeedClient.js';
import { ADSB_FEEDS } from '../../utils/adsbFeeds.js';
import { matchAircraft } from '../../utils/adsbMatch.js';
import { ADSB_LOL_FIXTURE, ADSB_FI_FIXTURE, ADSB_EMPTY_FIXTURE } from '../test-helpers/adsbFeedFixtures.js';

function respond(status: number, body: unknown): AdsbHttpFn {
  return vi.fn(async () => ({ status, json: async () => body }));
}

describe('parseFeedResponse', () => {
  it('reads the adsb.lol shape', () => {
    const ac = parseFeedResponse(ADSB_LOL_FIXTURE);
    expect(ac).toHaveLength(3);
    expect(ac[0].hex).toBe('a3f1c2');
    expect(ac[1].alt_baro).toBe('ground');
  });

  it('reads the adsb.fi shape', () => {
    expect(parseFeedResponse(ADSB_FI_FIXTURE)).toHaveLength(1);
  });

  it('treats a missing or empty ac list as no aircraft', () => {
    expect(parseFeedResponse(ADSB_EMPTY_FIXTURE)).toEqual([]);
    expect(parseFeedResponse({ msg: 'No error', now: 1 })).toEqual([]);
  });

  it('rejects a body that is not the feed shape', () => {
    expect(() => parseFeedResponse('nope')).toThrow(AdsbFeedError);
    expect(() => parseFeedResponse({ ac: 'x' })).toThrow(AdsbFeedError);
  });

  it('feeds the matcher: the fixture over Miami matches AAL1498', () => {
    const m = matchAircraft(
      { latitude: 25.8, longitude: -80.3, altitudeM: 3000, positionTimestampMs: 0, nowMs: 0 },
      parseFeedResponse(ADSB_LOL_FIXTURE),
    );
    expect(m).toMatchObject({ hex: 'a3f1c2', callsign: 'AAL1498', type: 'B38M', registration: 'N316RK' });
  });
});

describe('fetchAircraftNear', () => {
  it('calls the feed point URL with a User-Agent and no key header by default', async () => {
    const http = respond(200, ADSB_LOL_FIXTURE);
    const ac = await fetchAircraftNear(ADSB_FEEDS['adsb.lol'], 25.8, -80.3, 3, { http });
    expect(ac).toHaveLength(3);
    const [url, init] = (http as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.adsb.lol/v2/point/25.8000/-80.3000/3');
    expect(init.headers['User-Agent']).toBe(ADSB_USER_AGENT);
    expect(ADSB_USER_AGENT).toMatch(/^MeshMonitor\/\S+ \(\+https:\/\/github\.com\/Yeraze\/meshmonitor\)$/);
    expect(init.headers[ADSB_API_KEY_HEADER]).toBeUndefined();
  });

  it('sends the API key header only when a key is set', async () => {
    const http = respond(200, ADSB_FI_FIXTURE);
    await fetchAircraftNear(ADSB_FEEDS['adsb.fi'], 25.8, -80.3, 3, { http, token: ' secret ' });
    const [url, init] = (http as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('opendata.adsb.fi');
    expect(init.headers[ADSB_API_KEY_HEADER]).toBe('secret');
  });

  it.each([429, 403, 500, 503])('HTTP %i is a backoff error', async (status) => {
    const err = await fetchAircraftNear(ADSB_FEEDS['adsb.lol'], 0, 0, 3, { http: respond(status, {}) }).catch((e) => e);
    expect(err).toBeInstanceOf(AdsbFeedError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(status);
    expect(err.backoff).toBe(true);
  });

  it('HTTP 404 fails without backoff', async () => {
    const err = await fetchAircraftNear(ADSB_FEEDS['adsb.lol'], 0, 0, 3, { http: respond(404, {}) }).catch((e) => e);
    expect(err.backoff).toBe(false);
  });

  it('a network error fails with backoff', async () => {
    const http: AdsbHttpFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const err = await fetchAircraftNear(ADSB_FEEDS['adsb.lol'], 0, 0, 3, { http }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.backoff).toBe(true);
  });

  it('times out and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const http: AdsbHttpFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal;
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const err = await fetchAircraftNear(ADSB_FEEDS['adsb.lol'], 0, 0, 3, { http, timeoutMs: 10 }).catch((e) => e);
    expect(err.kind).toBe('timeout');
    expect(err.backoff).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('invalid JSON is a parse error without backoff', async () => {
    const http: AdsbHttpFn = async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError('bad');
      },
    });
    const err = await fetchAircraftNear(ADSB_FEEDS['adsb.lol'], 0, 0, 3, { http }).catch((e) => e);
    expect(err.kind).toBe('parse');
    expect(err.backoff).toBe(false);
  });
});
