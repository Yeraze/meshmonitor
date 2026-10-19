/**
 * AircraftFlightMatchesRepository — per-source isolation and episode/lookup
 * semantics on SQLite (#5374). The PG/MySQL twin is
 * `aircraftFlightMatches.multiBackend.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AircraftFlightMatchesRepository, type FlightMatchResultWrite } from './aircraftFlightMatches.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const NODE = 0xdeadbeef; // > 2^31, exercises unsigned handling

/** The table FKs to sources(id), and createTestDb enforces foreign keys. */
function seedSources(t: TestDb): void {
  const insert = t.sqlite.prepare(
    `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt) VALUES (?, ?, 'meshtastic_tcp', '{}', 1, 0, 0)`,
  );
  insert.run('src-a', 'A');
  insert.run('src-b', 'B');
}

function hit(over: Partial<FlightMatchResultWrite> = {}): FlightMatchResultWrite {
  return {
    status: 'possible',
    feed: 'adsb.lol',
    hex: 'a3f1c2',
    callsign: 'AAL1498',
    aircraftType: 'B38M',
    registration: 'N316RK',
    gsKt: 312.4,
    trackDeg: 271.3,
    altM: 3002,
    distanceKm: 1.1,
    matchedAt: 2000,
    ...over,
  };
}

describe('AircraftFlightMatchesRepository — per-source isolation', () => {
  let t: TestDb;
  let repo: AircraftFlightMatchesRepository;

  beforeEach(() => {
    t = createTestDb();
    seedSources(t);
    repo = new AircraftFlightMatchesRepository(t.db, 'sqlite');
  });

  afterEach(() => {
    t.close();
  });

  it('returns null when there is no row', async () => {
    expect(await repo.get('src-a', NODE)).toBeNull();
  });

  it('startEpisode creates a clean row', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    expect(await repo.get('src-a', NODE)).toMatchObject({
      sourceId: 'src-a',
      nodeNum: NODE,
      episodeStartedAt: 1000,
      lookups: 0,
      firstLookupAt: null,
      status: 'none',
      hex: null,
      matchedAt: null,
    });
  });

  it('keeps one row per source for the same node', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    await repo.startEpisode('src-b', NODE, 5000);
    await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0, firstLookupAt: 1500, result: hit() });

    expect((await repo.get('src-a', NODE))!.status).toBe('possible');
    const b = await repo.get('src-b', NODE);
    expect(b).toMatchObject({ status: 'none', lookups: 0, episodeStartedAt: 5000 });
  });

  it('deleteForNode only removes that source\'s row', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    await repo.startEpisode('src-b', NODE, 1000);
    expect(await repo.deleteForNode('src-a', NODE)).toBe(1);
    expect(await repo.get('src-a', NODE)).toBeNull();
    expect(await repo.get('src-b', NODE)).not.toBeNull();
  });

  it('refuses an empty sourceId', async () => {
    await expect(repo.get('', NODE)).rejects.toThrow(/sourceId is required/);
  });
});

describe('AircraftFlightMatchesRepository — episode and lookup rules', () => {
  let t: TestDb;
  let repo: AircraftFlightMatchesRepository;

  beforeEach(() => {
    t = createTestDb();
    seedSources(t);
    repo = new AircraftFlightMatchesRepository(t.db, 'sqlite');
  });

  afterEach(() => {
    t.close();
  });

  it('recordLookup spends a lookup and writes the match', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    const ok = await repo.recordLookup('src-a', NODE, {
      episodeStartedAt: 1000,
      lookupsBefore: 0,
      firstLookupAt: 1500,
      result: hit(),
    });
    expect(ok).toBe(true);
    expect(await repo.get('src-a', NODE)).toMatchObject({
      lookups: 1,
      firstLookupAt: 1500,
      status: 'possible',
      feed: 'adsb.lol',
      hex: 'a3f1c2',
      callsign: 'AAL1498',
      aircraftType: 'B38M',
      registration: 'N316RK',
      gsKt: 312.4,
      trackDeg: 271.3,
      altM: 3002,
      distanceKm: 1.1,
      matchedAt: 2000,
    });
  });

  it('a lookup without a result spends the lookup and keeps the previous fields', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0, firstLookupAt: 1500, result: hit() });
    await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 1 });
    expect(await repo.get('src-a', NODE)).toMatchObject({ lookups: 2, status: 'possible', hex: 'a3f1c2', firstLookupAt: 1500 });
  });

  it('drops a write whose lookup count is stale (no double spend)', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    expect(await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0 })).toBe(true);
    expect(await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0 })).toBe(false);
    expect((await repo.get('src-a', NODE))!.lookups).toBe(1);
  });

  it('drops a write that belongs to an older episode', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    await repo.startEpisode('src-a', NODE, 9000);
    expect(await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0, result: hit() })).toBe(false);
    expect(await repo.get('src-a', NODE)).toMatchObject({ lookups: 0, status: 'none', episodeStartedAt: 9000 });
  });

  it('startEpisode resets lookups, status and every match field', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0, firstLookupAt: 1500, result: hit() });
    await repo.recordLookup('src-a', NODE, {
      episodeStartedAt: 1000,
      lookupsBefore: 1,
      result: hit({ status: 'matched' }),
      point: { at: 2500, lat: 25.8, lon: -80.3 },
    });
    await repo.recordRecheck('src-a', NODE, {
      episodeStartedAt: 1000,
      rechecksBefore: 0,
      misses: 1,
      point: { at: 3500, lat: 26, lon: -80.3 },
    });

    await repo.startEpisode('src-a', NODE, 50_000);
    expect(await repo.get('src-a', NODE)).toEqual({
      sourceId: 'src-a',
      nodeNum: NODE,
      episodeStartedAt: 50_000,
      lookups: 0,
      firstLookupAt: null,
      status: 'none',
      feed: null,
      hex: null,
      callsign: null,
      aircraftType: null,
      registration: null,
      gsKt: null,
      trackDeg: null,
      altM: null,
      distanceKm: null,
      matchedAt: null,
      lastLookupAt: null,
      lastLookupLat: null,
      lastLookupLon: null,
      rechecks: 0,
      misses: 0,
    });
  });

  it('recordLookup stores the lookup point', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    await repo.recordLookup('src-a', NODE, {
      episodeStartedAt: 1000,
      lookupsBefore: 0,
      firstLookupAt: 1500,
      point: { at: 1500, lat: 25.8, lon: -80.3 },
    });
    expect(await repo.get('src-a', NODE)).toMatchObject({ lastLookupAt: 1500, lastLookupLat: 25.8, lastLookupLon: -80.3 });
  });

  it('recordRecheck spends a re-check, writes the point, misses and result (#5876)', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0, result: hit() });
    expect(await repo.recordRecheck('src-a', NODE, {
      episodeStartedAt: 1000,
      rechecksBefore: 0,
      misses: 0,
      point: { at: 9000, lat: 26, lon: -80.1 },
      result: hit({ status: 'matched', callsign: 'AAL2001', matchedAt: 9000 }),
    })).toBe(true);
    expect(await repo.get('src-a', NODE)).toMatchObject({
      lookups: 1,
      rechecks: 1,
      misses: 0,
      status: 'matched',
      callsign: 'AAL2001',
      lastLookupAt: 9000,
      lastLookupLat: 26,
      lastLookupLon: -80.1,
    });
    // Without a result: spend it, keep the fields.
    expect(await repo.recordRecheck('src-a', NODE, {
      episodeStartedAt: 1000, rechecksBefore: 1, misses: 1, point: { at: 10_000, lat: 26, lon: -80.1 },
    })).toBe(true);
    expect(await repo.get('src-a', NODE)).toMatchObject({ rechecks: 2, misses: 1, status: 'matched', callsign: 'AAL2001' });
  });

  it('recordRecheck refuses a stale re-check count or episode, and is source-scoped', async () => {
    await repo.startEpisode('src-a', NODE, 1000);
    await repo.startEpisode('src-b', NODE, 1000);
    const w = { episodeStartedAt: 1000, rechecksBefore: 0, misses: 0, point: { at: 2000, lat: 1, lon: 2 } };
    expect(await repo.recordRecheck('src-a', NODE, w)).toBe(true);
    expect(await repo.recordRecheck('src-a', NODE, w)).toBe(false);
    expect(await repo.recordRecheck('src-a', NODE, { ...w, episodeStartedAt: 999, rechecksBefore: 1 })).toBe(false);
    expect((await repo.get('src-a', NODE))!.rechecks).toBe(1);
    expect((await repo.get('src-b', NODE))!.rechecks).toBe(0);
  });
});
