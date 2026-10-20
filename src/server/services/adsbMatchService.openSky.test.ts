/**
 * AdsbMatchService with the OpenSky feed (#5877): credentials required, the
 * shared API key withheld, and a 429 Retry-After pause that is persisted so
 * a restart keeps it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdsbMatchService, type AdsbMatchDeps, FEED_BACKOFF_MS, MAX_RETRY_AFTER_MS, ADSB_SETTINGS } from './adsbMatchService.js';
import { AdsbFeedError } from './adsbFeedClient.js';
import { AircraftFlightMatchesRepository } from '../../db/repositories/aircraftFlightMatches.js';
import { createTestDb, type TestDb } from '../test-helpers/testDb.js';
import { parseFeedResponse } from './adsbFeedClient.js';
import { ADSB_LOL_FIXTURE } from '../test-helpers/adsbFeedFixtures.js';
import type { AdsbAircraft } from '../../utils/adsbMatch.js';
import type { DbNode } from '../../db/types.js';

const T0 = 1_790_500_000_000;
const NODE = 0xa1b2c3d4;
const HIT = parseFeedResponse(ADSB_LOL_FIXTURE);

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
  db.sqlite
    .prepare(`INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt) VALUES (?, ?, ?, '{}', 1, 0, 0)`)
    .run('src-a', 'A', 'meshtastic_tcp');
});

afterEach(() => db.close());

type Settings = Record<string, string | null>;

function makeService(settings: Settings, clock: { now: number }, responses: Array<AdsbAircraft[] | Error>) {
  const repo = new AircraftFlightMatchesRepository(db.db, 'sqlite');
  const queue = [...responses];
  const fetch = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const node = {
    nodeNum: NODE,
    latitude: 25.8,
    longitude: -80.3,
    altitude: 3000,
    positionTimestamp: clock.now,
    likelyAircraft: true,
  } as unknown as DbNode;
  const deps: AdsbMatchDeps = {
    getGlobalSetting: async (k) => settings[k] ?? null,
    setGlobalSetting: async (k, v) => {
      settings[k] = v;
    },
    getSourceType: async () => 'meshtastic_tcp',
    getNode: async () => ({ ...node, positionTimestamp: clock.now }),
    getCachedNode: () => node,
    getMatch: (s, n) => repo.get(s, n),
    startEpisode: (s, n, at) => repo.startEpisode(s, n, at),
    recordLookup: (s, n, w) => repo.recordLookup(s, n, w),
    fetchAircraft: fetch as unknown as AdsbMatchDeps['fetchAircraft'],
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  };
  return { svc: new AdsbMatchService(deps), fetch, repo };
}

function openSkySettings(): Settings {
  return {
    adsbMatchEnabled: 'true',
    adsbFeed: 'opensky',
    adsb_api_token: 'shared-key',
    [ADSB_SETTINGS.openSkyClientId]: 'my-client',
    [ADSB_SETTINGS.openSkyClientSecret]: 's3cret',
  };
}

async function flag(svc: AdsbMatchService, at: number): Promise<void> {
  svc.onAircraftTransition('src-a', NODE, at);
  await svc.idleForTest();
}

function rateLimited(retryAfterMs: number | null): AdsbFeedError {
  return new AdsbFeedError('OpenSky Network returned HTTP 429', 'http', 429, true, retryAfterMs);
}

describe('AdsbMatchService — OpenSky (#5877)', () => {
  it('passes the OpenSky credentials and withholds the shared API key', async () => {
    const clock = { now: T0 };
    const { svc, fetch, repo } = makeService(openSkySettings(), clock, [HIT]);
    await flag(svc, clock.now);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [feed, , , , token, creds] = fetch.mock.calls[0] as unknown[];
    expect((feed as { id: string }).id).toBe('opensky');
    expect(token).toBeNull();
    expect(creds).toEqual({ clientId: 'my-client', clientSecret: 's3cret' });
    expect(await repo.get('src-a', NODE)).toMatchObject({ status: 'possible', feed: 'opensky' });
  });

  it.each([ADSB_SETTINGS.openSkyClientId, ADSB_SETTINGS.openSkyClientSecret])('never asks OpenSky without %s', async (missing) => {
    const settings = openSkySettings();
    settings[missing] = '  ';
    const clock = { now: T0 };
    const { svc, fetch } = makeService(settings, clock, [HIT]);
    await flag(svc, clock.now);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a 429 with Retry-After pauses OpenSky until then, and persists the time', async () => {
    const settings = openSkySettings();
    const clock = { now: T0 };
    const { svc, fetch } = makeService(settings, clock, [rateLimited(2 * 3600_000), HIT]);
    await flag(svc, clock.now);
    expect(fetch).toHaveBeenCalledTimes(1);
    const until = Number(settings[ADSB_SETTINGS.openSkyPausedUntil]);
    expect(until).toBeGreaterThanOrEqual(T0 + 2 * 3600_000);
    // Not the fixed 10-minute backoff:
    expect(svc.isBackingOffForTest()).toBe(false);

    clock.now += FEED_BACKOFF_MS + 60_000; // past the 10-min backoff, still inside Retry-After
    svc.onLivePosition('src-a', NODE);
    await svc.idleForTest();
    expect(fetch).toHaveBeenCalledTimes(1);

    clock.now = until + 1;
    await flag(svc, clock.now); // a new flagging after the pause
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('the pause survives a restart', async () => {
    const settings = openSkySettings();
    const clock = { now: T0 };
    const first = makeService(settings, clock, [rateLimited(3600_000)]);
    await flag(first.svc, clock.now);
    expect(settings[ADSB_SETTINGS.openSkyPausedUntil]).toBeTruthy();

    // A fresh service (the process restarted) reading the same settings.
    clock.now += 60_000;
    const second = makeService(settings, clock, [HIT]);
    await flag(second.svc, clock.now);
    expect(second.fetch).not.toHaveBeenCalled();

    clock.now = T0 + 3600_000 + 1;
    await flag(second.svc, clock.now);
    expect(second.fetch).toHaveBeenCalledTimes(1);
  });

  it('caps an absurd Retry-After at 24 h', async () => {
    const settings = openSkySettings();
    const clock = { now: T0 };
    const { svc } = makeService(settings, clock, [rateLimited(30 * 24 * 3600_000)]);
    await flag(svc, clock.now);
    expect(Number(settings[ADSB_SETTINGS.openSkyPausedUntil])).toBe(T0 + MAX_RETRY_AFTER_MS);
  });

  it('a 429 without Retry-After keeps the fixed 10-minute backoff', async () => {
    const settings = openSkySettings();
    const clock = { now: T0 };
    const { svc } = makeService(settings, clock, [rateLimited(null)]);
    await flag(svc, clock.now);
    expect(svc.isBackingOffForTest()).toBe(true);
    expect(settings[ADSB_SETTINGS.openSkyPausedUntil]).toBeUndefined();
  });

  it('an OpenSky pause does not block a readsb feed', async () => {
    const settings = openSkySettings();
    settings[ADSB_SETTINGS.openSkyPausedUntil] = String(T0 + 3600_000);
    settings.adsbFeed = 'adsb.lol';
    const clock = { now: T0 };
    const { svc, fetch } = makeService(settings, clock, [HIT]);
    await flag(svc, clock.now);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[4]).toBe('shared-key');
  });
});
