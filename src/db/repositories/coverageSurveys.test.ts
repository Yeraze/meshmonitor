/**
 * CoverageSurveysRepository — CRUD, live-survey lookup and retention
 * exemption windows (Coverage Report epic #5277, Phase 4b WP1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { CoverageSurveysRepository, type CreateCoverageSurveyParams } from './coverageSurveys.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { COVERAGE_SURVEY_LIVE_MAX_MS } from '../../utils/coverage.js';

const NOW = 1_760_000_000_000;

function makeSurvey(overrides: Partial<CreateCoverageSurveyParams> = {}): CreateCoverageSurveyParams {
  return {
    name: 'Downtown drive',
    senderId: '!aaaaaaaa',
    startAt: NOW - 60_000,
    endAt: NOW,
    receivers: null,
    intervalSec: 30,
    notes: null,
    createdBy: 7,
    ...overrides,
  };
}

describe('CoverageSurveysRepository', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: CoverageSurveysRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new CoverageSurveysRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  describe('createSurvey / getSurvey', () => {
    it('creates a survey with a UUID id and returns the full row', async () => {
      const created = await repo.createSurvey(makeSurvey({ name: 'My Survey' }));
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(created.name).toBe('My Survey');
      expect(created.senderId).toBe('!aaaaaaaa');
      expect(created.endAt).toBe(NOW);
      expect(created.createdAt).toBe(created.updatedAt);

      const fetched = await repo.getSurvey(created.id);
      expect(fetched).toEqual(created);
    });

    it('creates a live survey (endAt omitted) with endAt null', async () => {
      const created = await repo.createSurvey(makeSurvey({ endAt: null }));
      expect(created.endAt).toBeNull();
    });

    it('defaults optional fields to null when omitted', async () => {
      const created = await repo.createSurvey({
        name: 'Bare',
        senderId: '!bbbbbbbb',
        startAt: NOW,
      });
      expect(created.endAt).toBeNull();
      expect(created.receivers).toBeNull();
      expect(created.intervalSec).toBeNull();
      expect(created.notes).toBeNull();
      expect(created.createdBy).toBeNull();
    });

    it('getSurvey returns null for an unknown id', async () => {
      expect(await repo.getSurvey('does-not-exist')).toBeNull();
    });

    it('round-trips a 64-hex MeshCore senderId', async () => {
      const pubkey64 = 'a'.repeat(64);
      const created = await repo.createSurvey(makeSurvey({ senderId: pubkey64 }));
      const fetched = await repo.getSurvey(created.id);
      expect(fetched?.senderId).toBe(pubkey64);
    });
  });

  describe('listSurveys', () => {
    it('returns every survey, newest startAt first', async () => {
      const a = await repo.createSurvey(makeSurvey({ name: 'A', startAt: NOW - 30_000, endAt: NOW - 20_000 }));
      const b = await repo.createSurvey(makeSurvey({ name: 'B', startAt: NOW - 10_000, endAt: NOW }));
      const c = await repo.createSurvey(makeSurvey({ name: 'C', startAt: NOW - 50_000, endAt: NOW - 40_000 }));

      const list = await repo.listSurveys();
      expect(list.map((s) => s.id)).toEqual([b.id, a.id, c.id]);
    });

    it('returns an empty array when there are no surveys', async () => {
      expect(await repo.listSurveys()).toEqual([]);
    });
  });

  describe('updateSurvey', () => {
    it('patches only the provided fields and bumps updatedAt', async () => {
      const created = await repo.createSurvey(makeSurvey({ name: 'Original', notes: 'orig notes' }));
      const before = created.updatedAt;

      const ok = await repo.updateSurvey(created.id, { name: 'Renamed' });
      expect(ok).toBe(true);

      const fetched = await repo.getSurvey(created.id);
      expect(fetched?.name).toBe('Renamed');
      expect(fetched?.notes).toBe('orig notes'); // untouched
      expect(fetched?.senderId).toBe(created.senderId); // untouched
      expect(fetched?.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('can set endAt (the "stop" action)', async () => {
      const created = await repo.createSurvey(makeSurvey({ endAt: null }));
      expect(created.endAt).toBeNull();

      const ok = await repo.updateSurvey(created.id, { endAt: NOW + 1000 });
      expect(ok).toBe(true);

      const fetched = await repo.getSurvey(created.id);
      expect(fetched?.endAt).toBe(NOW + 1000);
    });

    it('can set notes/receivers back to null explicitly', async () => {
      const created = await repo.createSurvey(makeSurvey({ notes: 'has notes', receivers: 'enc:abc' }));
      const ok = await repo.updateSurvey(created.id, { notes: null, receivers: null });
      expect(ok).toBe(true);

      const fetched = await repo.getSurvey(created.id);
      expect(fetched?.notes).toBeNull();
      expect(fetched?.receivers).toBeNull();
    });

    it('returns false for an unknown id and touches nothing', async () => {
      const ok = await repo.updateSurvey('does-not-exist', { name: 'X' });
      expect(ok).toBe(false);
    });
  });

  describe('deleteSurvey', () => {
    it('deletes the row and returns true', async () => {
      const created = await repo.createSurvey(makeSurvey());
      expect(await repo.deleteSurvey(created.id)).toBe(true);
      expect(await repo.getSurvey(created.id)).toBeNull();
    });

    it('returns false for an unknown id', async () => {
      expect(await repo.deleteSurvey('does-not-exist')).toBe(false);
    });
  });

  describe('countSurveys / countSurveysByUser', () => {
    it('counts across all creators and per creator', async () => {
      await repo.createSurvey(makeSurvey({ createdBy: 1 }));
      await repo.createSurvey(makeSurvey({ createdBy: 1 }));
      await repo.createSurvey(makeSurvey({ createdBy: 2 }));

      expect(await repo.countSurveys()).toBe(3);
      expect(await repo.countSurveysByUser(1)).toBe(2);
      expect(await repo.countSurveysByUser(2)).toBe(1);
      expect(await repo.countSurveysByUser(999)).toBe(0);
    });

    it('countSurveys is 0 on an empty table', async () => {
      expect(await repo.countSurveys()).toBe(0);
    });
  });

  describe('getLiveSurveyForSender', () => {
    it('finds a survey with endAt null and startAt within the live cap', async () => {
      const live = await repo.createSurvey(makeSurvey({ senderId: '!live0001', startAt: NOW, endAt: null }));
      const found = await repo.getLiveSurveyForSender('!live0001', NOW + 1000);
      expect(found?.id).toBe(live.id);
    });

    it('does not match a stopped survey (endAt set)', async () => {
      await repo.createSurvey(makeSurvey({ senderId: '!stopped1', startAt: NOW, endAt: NOW + 500 }));
      expect(await repo.getLiveSurveyForSender('!stopped1', NOW + 1000)).toBeNull();
    });

    it('does not match once the live cap has passed, even though endAt is still null (A10 lazy end)', async () => {
      await repo.createSurvey(makeSurvey({ senderId: '!lapsed01', startAt: NOW, endAt: null }));
      const pastCap = NOW + COVERAGE_SURVEY_LIVE_MAX_MS + 1;
      expect(await repo.getLiveSurveyForSender('!lapsed01', pastCap)).toBeNull();
    });

    it('matches exactly at the live-cap boundary but not just past it', async () => {
      await repo.createSurvey(makeSurvey({ senderId: '!boundary', startAt: NOW, endAt: null }));
      // startAt + LIVE_MAX_MS - 1 < startAt + LIVE_MAX_MS ⇒ still live
      const justBefore = NOW + COVERAGE_SURVEY_LIVE_MAX_MS - 1;
      expect(await repo.getLiveSurveyForSender('!boundary', justBefore)).not.toBeNull();
    });

    it('returns null when no survey exists for the sender', async () => {
      expect(await repo.getLiveSurveyForSender('!nobody0', NOW)).toBeNull();
    });

    it('does not leak a live survey from a different sender', async () => {
      await repo.createSurvey(makeSurvey({ senderId: '!otherxxx', startAt: NOW, endAt: null }));
      expect(await repo.getLiveSurveyForSender('!targetid', NOW + 1000)).toBeNull();
    });
  });

  describe('getExemptionWindows', () => {
    it('resolves a stopped survey to its stored endAt', async () => {
      await repo.createSurvey(makeSurvey({ senderId: '!stopped2', startAt: NOW - 10_000, endAt: NOW - 5_000 }));
      const windows = await repo.getExemptionWindows(NOW);
      expect(windows).toEqual([{ senderId: '!stopped2', startAt: NOW - 10_000, endAt: NOW - 5_000 }]);
    });

    it('resolves a live survey to now (capped at startAt + LIVE_MAX)', async () => {
      await repo.createSurvey(makeSurvey({ senderId: '!live0002', startAt: NOW - 1_000, endAt: null }));
      const windows = await repo.getExemptionWindows(NOW);
      expect(windows).toEqual([{ senderId: '!live0002', startAt: NOW - 1_000, endAt: NOW }]);
    });

    it('caps a live survey past its window at startAt + COVERAGE_SURVEY_LIVE_MAX_MS', async () => {
      const startAt = NOW - COVERAGE_SURVEY_LIVE_MAX_MS - 100_000;
      await repo.createSurvey(makeSurvey({ senderId: '!longlive', startAt, endAt: null }));
      const windows = await repo.getExemptionWindows(NOW);
      expect(windows).toEqual([{ senderId: '!longlive', startAt, endAt: startAt + COVERAGE_SURVEY_LIVE_MAX_MS }]);
    });

    it('returns one window per survey, including old ones', async () => {
      await repo.createSurvey(makeSurvey({ senderId: '!s1', startAt: NOW - 1_000_000, endAt: NOW - 900_000 }));
      await repo.createSurvey(makeSurvey({ senderId: '!s2', startAt: NOW - 500, endAt: NOW }));
      const windows = await repo.getExemptionWindows(NOW);
      expect(windows).toHaveLength(2);
      expect(windows.map((w) => w.senderId).sort()).toEqual(['!s1', '!s2']);
    });

    it('returns an empty array when there are no surveys', async () => {
      expect(await repo.getExemptionWindows(NOW)).toEqual([]);
    });
  });
});
