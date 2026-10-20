/**
 * AdsbMatchService (#5374): episode + 2-lookup cap, status rules, backoff,
 * spacing, cross-source reuse, and a restart that must not reset the cap.
 *
 * The DB side is the real repository on an in-memory SQLite database, so the
 * cap is exercised exactly as production stores it. HTTP is a fake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AdsbMatchService,
  type AdsbMatchDeps,
  LOOKUP_SPACING_MS,
  FEED_BACKOFF_MS,
  RECHECK_INTERVAL_MS,
  MAX_RECHECKS,
} from './adsbMatchService.js';
import { AdsbFeedError } from './adsbFeedClient.js';
import { AircraftFlightMatchesRepository } from '../../db/repositories/aircraftFlightMatches.js';
import { createTestDb, type TestDb } from '../test-helpers/testDb.js';
import { parseFeedResponse } from './adsbFeedClient.js';
import { ADSB_LOL_FIXTURE, ADSB_EMPTY_FIXTURE } from '../test-helpers/adsbFeedFixtures.js';
import type { AdsbAircraft } from '../../utils/adsbMatch.js';
import type { DbNode } from '../../db/types.js';

const T0 = 1_790_500_000_000;
const NODE = 0xa1b2c3d4;
const HIT = parseFeedResponse(ADSB_LOL_FIXTURE); // AAL1498 (a3f1c2) at 25.81,-80.3 / ~3002 m
const MISS = parseFeedResponse(ADSB_EMPTY_FIXTURE);

interface Harness {
  svc: AdsbMatchService;
  repo: AircraftFlightMatchesRepository;
  clock: { now: number };
  fetch: ReturnType<typeof vi.fn>;
  settings: Record<string, string | null>;
  node: DbNode;
  deps: AdsbMatchDeps;
  sourceTypes: Record<string, string>;
}

let db: TestDb;

function seedSources(): void {
  const insert = db.sqlite.prepare(
    `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt) VALUES (?, ?, ?, '{}', 1, 0, 0)`,
  );
  insert.run('src-a', 'A', 'meshtastic_tcp');
  insert.run('src-b', 'B', 'mqtt');
  insert.run('src-mc', 'MC', 'meshcore');
}

function makeHarness(opts: { responses?: Array<AdsbAircraft[] | Error>; clock?: { now: number } } = {}): Harness {
  const clock = opts.clock ?? { now: T0 };
  const repo = new AircraftFlightMatchesRepository(db.db, 'sqlite');
  const responses = [...(opts.responses ?? [])];
  const fetch = vi.fn(async () => {
    const next = responses.length > 1 ? responses.shift()! : responses[0] ?? MISS;
    if (next instanceof Error) throw next;
    return next;
  });
  const settings: Record<string, string | null> = { adsbMatchEnabled: 'true', adsbFeed: 'adsb.lol', adsb_api_token: null };
  const node = {
    nodeNum: NODE,
    nodeId: '!a1b2c3d4',
    latitude: 25.8,
    longitude: -80.3,
    altitude: 3000,
    positionTimestamp: clock.now,
    likelyAircraft: true,
  } as unknown as DbNode;
  const sourceTypes: Record<string, string> = { 'src-a': 'meshtastic_tcp', 'src-b': 'mqtt', 'src-mc': 'meshcore' };
  const deps: AdsbMatchDeps = {
    getGlobalSetting: async (k) => settings[k] ?? null,
    getSourceType: async (id) => sourceTypes[id] ?? null,
    getNode: async () => ({ ...node, positionTimestamp: clock.now }),
    getCachedNode: () => node,
    getMatch: (s, n) => repo.get(s, n),
    startEpisode: (s, n, at) => repo.startEpisode(s, n, at),
    recordLookup: (s, n, w) => repo.recordLookup(s, n, w),
    recordRecheck: (s, n, w) => repo.recordRecheck(s, n, w),
    fetchAircraft: fetch as unknown as AdsbMatchDeps['fetchAircraft'],
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  };
  return { svc: new AdsbMatchService(deps), repo, clock, fetch, settings, node, deps, sourceTypes };
}

async function flag(h: Harness, sourceId = 'src-a', at = h.clock.now): Promise<void> {
  h.svc.onAircraftTransition(sourceId, NODE, at);
  await h.svc.idleForTest();
}

async function livePosition(h: Harness, sourceId = 'src-a'): Promise<void> {
  h.svc.onLivePosition(sourceId, NODE);
  await h.svc.idleForTest();
}

beforeEach(() => {
  db = createTestDb();
  seedSources();
});

afterEach(() => {
  db.close();
});

describe('AdsbMatchService — gating', () => {
  it('does nothing when matching is off (the default)', async () => {
    const h = makeHarness({ responses: [HIT] });
    h.settings.adsbMatchEnabled = null;
    await flag(h);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(await h.repo.get('src-a', NODE)).toBeNull();
  });

  it('skips excluded (MeshCore / Reticulum) sources', async () => {
    const h = makeHarness({ responses: [HIT] });
    await flag(h, 'src-mc');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('live positions of unflagged nodes never touch the DB', async () => {
    const h = makeHarness();
    (h.node as any).likelyAircraft = false;
    const getMatch = vi.spyOn(h.deps, 'getMatch');
    await livePosition(h);
    expect(getMatch).not.toHaveBeenCalled();
  });
});

describe('AdsbMatchService — lookups and status', () => {
  it('lookup 1 with a hit records a possible match', async () => {
    const h = makeHarness({ responses: [HIT] });
    await flag(h);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [feed, lat, lon, nm, token] = h.fetch.mock.calls[0];
    expect(feed.id).toBe('adsb.lol');
    expect([lat, lon, nm, token]).toEqual([25.8, -80.3, 3, null]);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({
      lookups: 1,
      status: 'possible',
      feed: 'adsb.lol',
      hex: 'a3f1c2',
      callsign: 'AAL1498',
      aircraftType: 'B38M',
      registration: 'N316RK',
      firstLookupAt: T0,
      episodeStartedAt: T0,
    });
  });

  it('lookup 1 with no hit records none', async () => {
    const h = makeHarness({ responses: [MISS] });
    await flag(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 1, status: 'none', hex: null });
  });

  it('lookup 2 on the same hex upgrades to matched, then nothing more is looked up', async () => {
    const h = makeHarness({ responses: [HIT] });
    await flag(h);
    h.clock.now += 90_000;
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 2, status: 'matched', hex: 'a3f1c2' });

    h.clock.now += 90_000;
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('lookup 2 on a different hex stays possible with the new aircraft', async () => {
    const other = [{ ...HIT[0], hex: 'ffff01', flight: 'JBU9 ' }];
    const h = makeHarness({ responses: [HIT, other] });
    await flag(h);
    h.clock.now += 90_000;
    await livePosition(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 2, status: 'possible', hex: 'ffff01', callsign: 'JBU9' });
  });

  it('lookup 2 with no hit keeps the previous status and fields', async () => {
    const h = makeHarness({ responses: [HIT, MISS] });
    await flag(h);
    h.clock.now += 90_000;
    await livePosition(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 2, status: 'possible', hex: 'a3f1c2' });
  });

  it('lookup 2 after a none can still find a possible match', async () => {
    const h = makeHarness({ responses: [MISS, HIT] });
    await flag(h);
    h.clock.now += 90_000;
    await livePosition(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 2, status: 'possible', hex: 'a3f1c2' });
  });

  it('lookup 2 waits 60 s and gives up after 30 min (later fixes go to the re-check lane, #5876)', async () => {
    const h = makeHarness({ responses: [HIT] });
    await flag(h);
    h.clock.now += 30_000;
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.clock.now += 31 * 60_000;
    await livePosition(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 1, rechecks: 1 });
  });

  it('a new flagging resets the allowance', async () => {
    const h = makeHarness({ responses: [HIT] });
    await flag(h);
    h.clock.now += 90_000;
    await livePosition(h);
    h.clock.now += 3_600_000;
    await flag(h);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 1, status: 'possible', episodeStartedAt: h.clock.now });
  });

  it('a repeat of the same transition does not spend another lookup', async () => {
    const h = makeHarness({ responses: [HIT] });
    await flag(h, 'src-a', T0);
    await flag(h, 'src-a', T0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('AdsbMatchService — cap persistence', () => {
  it('a restart (fresh service, same DB) does not reset the cap', async () => {
    const clock = { now: T0 };
    const h1 = makeHarness({ responses: [HIT], clock });
    await flag(h1);
    clock.now += 90_000;
    await livePosition(h1);
    expect(h1.fetch).toHaveBeenCalledTimes(2);

    // "Restart": new service instance, nothing in memory. No transition fires on boot.
    const h2 = makeHarness({ responses: [HIT], clock });
    clock.now += 90_000;
    await livePosition(h2);
    expect(h2.fetch).not.toHaveBeenCalled();
    expect((await h2.repo.get('src-a', NODE))!.lookups).toBe(2);
  });

  it('a restart between lookups still allows exactly one more', async () => {
    const clock = { now: T0 };
    const h1 = makeHarness({ responses: [HIT], clock });
    await flag(h1);
    const h2 = makeHarness({ responses: [HIT], clock });
    clock.now += 90_000;
    await livePosition(h2);
    clock.now += 90_000;
    await livePosition(h2);
    expect(h2.fetch).toHaveBeenCalledTimes(1);
    expect(await h2.repo.get('src-a', NODE)).toMatchObject({ lookups: 2, status: 'matched' });
  });
});

describe('AdsbMatchService — failures and backoff', () => {
  it('a failed lookup does not spend the allowance', async () => {
    const h = makeHarness({ responses: [HIT, new AdsbFeedError('HTTP 404', 'http', 404, false), HIT] });
    await flag(h);
    h.clock.now += 90_000;
    await livePosition(h); // fails
    expect((await h.repo.get('src-a', NODE))!.lookups).toBe(1);
    expect(h.svc.isBackingOffForTest()).toBe(false);
    h.clock.now += 61_000;
    await livePosition(h); // retried, succeeds
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 2, status: 'matched' });
  });

  it('a failed first lookup is retried on a later live fix, then confirms as usual', async () => {
    const h = makeHarness({ responses: [new AdsbFeedError('HTTP 404', 'http', 404, false), HIT, HIT] });
    await flag(h); // lookup 1 fails, not counted
    expect((await h.repo.get('src-a', NODE))!.lookups).toBe(0);
    h.clock.now += 30_000;
    await livePosition(h); // inside the 60 s retry floor: skipped
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.clock.now += 31_000;
    await livePosition(h); // lookup 1 retried
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 1, status: 'possible' });
    h.clock.now += 61_000;
    await livePosition(h); // lookup 2 confirms
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 2, status: 'matched' });
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it('a failed first lookup is not retried once the flagging is over 30 min old', async () => {
    const h = makeHarness({ responses: [new AdsbFeedError('HTTP 404', 'http', 404, false), HIT] });
    await flag(h);
    h.clock.now += 31 * 60_000;
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect((await h.repo.get('src-a', NODE))!.lookups).toBe(0);
  });

  it('a 429 starts a 10-minute global backoff that blocks every source', async () => {
    const h = makeHarness({ responses: [new AdsbFeedError('HTTP 429', 'http', 429, true), HIT] });
    await flag(h, 'src-a');
    expect(h.svc.isBackingOffForTest()).toBe(true);
    expect((await h.repo.get('src-a', NODE))!.lookups).toBe(0);

    h.clock.now += 1_000;
    await flag(h, 'src-b');
    expect(h.fetch).toHaveBeenCalledTimes(1);

    h.clock.now += FEED_BACKOFF_MS;
    await flag(h, 'src-b');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect((await h.repo.get('src-b', NODE))!.status).toBe('possible');
  });

  it('sends the configured feed and key', async () => {
    const h = makeHarness({ responses: [HIT] });
    h.settings.adsbFeed = 'adsb.fi';
    h.settings.adsb_api_token = 'k';
    await flag(h);
    const [feed, , , , token] = h.fetch.mock.calls[0];
    expect(feed.id).toBe('adsb.fi');
    expect(token).toBe('k');
    expect((await h.repo.get('src-a', NODE))!.feed).toBe('adsb.fi');
  });
});

describe('AdsbMatchService — spacing and cross-source reuse', () => {
  it('a node flagged on two sources at once makes one HTTP request, and each source records its own row', async () => {
    const h = makeHarness({ responses: [HIT] });
    h.svc.onAircraftTransition('src-a', NODE, T0);
    h.svc.onAircraftTransition('src-b', NODE, T0);
    await h.svc.idleForTest();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect((await h.repo.get('src-a', NODE))!.status).toBe('possible');
    expect((await h.repo.get('src-b', NODE))!.status).toBe('possible');
  });

  it('spaces requests at least 1.1 s apart', async () => {
    const h = makeHarness({ responses: [HIT] });
    const times: number[] = [];
    h.fetch.mockImplementation(async () => {
      times.push(h.clock.now);
      return HIT;
    });
    const OTHER = NODE + 1;
    h.svc.onAircraftTransition('src-a', NODE, T0);
    h.svc.onAircraftTransition('src-a', OTHER, T0);
    await h.svc.idleForTest();
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(LOOKUP_SPACING_MS);
  });
});

describe('AdsbMatchService — re-checks (#5876)', () => {
  /** ~22 km north of the node's starting spot. */
  const MOVED_LAT = 26.0;
  const at = (lat: number, over: Partial<AdsbAircraft> = {}): AdsbAircraft[] => [{ ...HIT[0], lat, ...over }];

  /** Flag, then confirm with lookup 2 90 s later: a matched row with no re-checks spent. */
  async function matched(h: Harness): Promise<void> {
    await flag(h);
    h.clock.now += 90_000;
    await livePosition(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 2, status: 'matched', rechecks: 0 });
  }

  it('lookups record where and when they ran', async () => {
    const h = makeHarness({ responses: [HIT] });
    await flag(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lastLookupAt: T0, lastLookupLat: 25.8, lastLookupLon: -80.3 });
  });

  it('below both thresholds (< 15 min, ≤ 10 km) nothing is looked up', async () => {
    const h = makeHarness({ responses: [HIT] });
    await matched(h);
    h.clock.now += RECHECK_INTERVAL_MS - 120_000;
    h.node.latitude = 25.84; // ~4.4 km
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect((await h.repo.get('src-a', NODE))!.rechecks).toBe(0);
  });

  it('a flight-number rollover on the same hex refreshes the fields and stays matched', async () => {
    const h = makeHarness({ responses: [HIT, HIT, at(25.81, { flight: 'AAL2001 ', gs: 401, track: 90 })] });
    await matched(h);
    h.clock.now += RECHECK_INTERVAL_MS;
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({
      status: 'matched',
      hex: 'a3f1c2',
      callsign: 'AAL2001',
      gsKt: 401,
      trackDeg: 90,
      rechecks: 1,
      misses: 0,
      lookups: 2,
      matchedAt: h.clock.now,
      lastLookupAt: h.clock.now,
    });
  });

  it('a node that moved > 10 km re-checks early; a different aircraft there reads possible', async () => {
    const h = makeHarness({ responses: [HIT, HIT, at(MOVED_LAT + 0.01, { hex: 'ffff01', flight: 'JBU9 ' })] });
    await matched(h);
    h.clock.now += 120_000;
    h.node.latitude = MOVED_LAT;
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    const [, lat] = h.fetch.mock.calls[2];
    expect(lat).toBe(MOVED_LAT);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({
      status: 'possible',
      hex: 'ffff01',
      callsign: 'JBU9',
      rechecks: 1,
      lastLookupLat: MOVED_LAT,
    });
  });

  it('one miss keeps the match; a second miss in a row clears it', async () => {
    const h = makeHarness({ responses: [HIT, HIT, MISS] });
    await matched(h);
    h.clock.now += RECHECK_INTERVAL_MS;
    await livePosition(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ status: 'matched', hex: 'a3f1c2', misses: 1, rechecks: 1 });
    h.clock.now += RECHECK_INTERVAL_MS;
    await livePosition(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ status: 'none', hex: null, callsign: null, misses: 2, rechecks: 2 });
  });

  it('a hit between misses resets the miss count', async () => {
    const h = makeHarness({ responses: [HIT, HIT, MISS, HIT, MISS] });
    await matched(h);
    for (let i = 0; i < 3; i++) {
      h.clock.now += RECHECK_INTERVAL_MS;
      await livePosition(h);
    }
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ status: 'matched', misses: 1, rechecks: 3 });
  });

  it('a possible match whose lookup-2 window passed is re-checked, and the same hex confirms it', async () => {
    const h = makeHarness({ responses: [HIT] });
    await flag(h);
    h.clock.now += 31 * 60_000;
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 1, rechecks: 1, status: 'matched' });
  });

  it('a none after one lookup is not re-checked once the lookup-2 window passed', async () => {
    const h = makeHarness({ responses: [MISS] });
    await flag(h);
    h.clock.now += 31 * 60_000;
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('stops at six re-checks, and a restart neither resets the cap nor triggers a lookup', async () => {
    const clock = { now: T0 };
    const h1 = makeHarness({ responses: [HIT], clock });
    await matched(h1);
    for (let i = 0; i < MAX_RECHECKS + 2; i++) {
      clock.now += RECHECK_INTERVAL_MS;
      await livePosition(h1);
    }
    expect(h1.fetch).toHaveBeenCalledTimes(2 + MAX_RECHECKS);
    expect((await h1.repo.get('src-a', NODE))!.rechecks).toBe(MAX_RECHECKS);

    const h2 = makeHarness({ responses: [HIT], clock });
    await h2.svc.idleForTest();
    expect(h2.fetch).not.toHaveBeenCalled();
    clock.now += RECHECK_INTERVAL_MS;
    h2.node.latitude = MOVED_LAT;
    await livePosition(h2);
    expect(h2.fetch).not.toHaveBeenCalled();
    expect((await h2.repo.get('src-a', NODE))!.rechecks).toBe(MAX_RECHECKS);
  });

  it('a restart mid-way keeps the re-checks already spent', async () => {
    const clock = { now: T0 };
    const h1 = makeHarness({ responses: [HIT], clock });
    await matched(h1);
    for (let i = 0; i < 4; i++) {
      clock.now += RECHECK_INTERVAL_MS;
      await livePosition(h1);
    }
    const h2 = makeHarness({ responses: [HIT], clock });
    for (let i = 0; i < 4; i++) {
      clock.now += RECHECK_INTERVAL_MS;
      await livePosition(h2);
    }
    expect(h2.fetch).toHaveBeenCalledTimes(MAX_RECHECKS - 4);
    expect((await h2.repo.get('src-a', NODE))!.rechecks).toBe(MAX_RECHECKS);
  });

  it('a new flagging resets the re-check allowance', async () => {
    const h = makeHarness({ responses: [HIT] });
    await matched(h);
    h.clock.now += RECHECK_INTERVAL_MS;
    await livePosition(h);
    expect((await h.repo.get('src-a', NODE))!.rechecks).toBe(1);
    h.clock.now += 3_600_000;
    await flag(h);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ lookups: 1, rechecks: 0, misses: 0 });
  });

  it('honours the global backoff and does not spend a re-check on a failure', async () => {
    const h = makeHarness({ responses: [HIT, HIT, new AdsbFeedError('HTTP 429', 'http', 429, true), HIT] });
    await matched(h);
    h.clock.now += RECHECK_INTERVAL_MS;
    await livePosition(h); // 429
    expect(h.svc.isBackingOffForTest()).toBe(true);
    expect((await h.repo.get('src-a', NODE))!.rechecks).toBe(0);

    h.clock.now += 2 * 60_000;
    await livePosition(h); // still backing off
    expect(h.fetch).toHaveBeenCalledTimes(3);

    h.clock.now += FEED_BACKOFF_MS;
    await livePosition(h);
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(await h.repo.get('src-a', NODE)).toMatchObject({ status: 'matched', rechecks: 1 });
  });
});
