/**
 * DistanceDeleteLogRepository Tests (SQLite)
 *
 * Basic coverage for addDistanceDeleteLogEntry and getDistanceDeleteLog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DistanceDeleteLogRepository } from './distanceDeleteLog.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('DistanceDeleteLogRepository - SQLite', () => {
  let repo: DistanceDeleteLogRepository;
  let close: () => void;

  beforeEach(() => {
    const t = createTestDb();
    repo = new DistanceDeleteLogRepository(t.db, 'sqlite');
    close = t.close;
  });

  afterEach(() => {
    close();
  });

  it('getDistanceDeleteLog - empty initially', async () => {
    const entries = await repo.getDistanceDeleteLog();
    expect(entries).toHaveLength(0);
  });

  it('addDistanceDeleteLogEntry - inserts an entry', async () => {
    await repo.addDistanceDeleteLogEntry({
      timestamp: Date.now(),
      nodesDeleted: 5,
      thresholdKm: 100,
      details: JSON.stringify([{ nodeNum: 123 }]),
    });
    const entries = await repo.getDistanceDeleteLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].nodesDeleted).toBe(5);
    expect(entries[0].thresholdKm).toBe(100);
  });

  it('getDistanceDeleteLog - details parsed as array', async () => {
    const details = [{ nodeNum: 456, longName: 'TestNode' }];
    await repo.addDistanceDeleteLogEntry({
      timestamp: Date.now(),
      nodesDeleted: 1,
      thresholdKm: 50,
      details: JSON.stringify(details),
    });
    const entries = await repo.getDistanceDeleteLog();
    expect(entries[0].details).toEqual(details);
  });

  it('getDistanceDeleteLog - respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.addDistanceDeleteLogEntry({
        timestamp: Date.now() + i,
        nodesDeleted: i,
        thresholdKm: 50,
        details: '[]',
      });
    }
    const entries = await repo.getDistanceDeleteLog(3);
    expect(entries).toHaveLength(3);
  });

  it('getDistanceDeleteLog - scoped by sourceId', async () => {
    await repo.addDistanceDeleteLogEntry({
      timestamp: 1, nodesDeleted: 1, thresholdKm: 50, details: '[]', sourceId: 'A',
    });
    await repo.addDistanceDeleteLogEntry({
      timestamp: 2, nodesDeleted: 2, thresholdKm: 75, details: '[]', sourceId: 'B',
    });
    const aRows = await repo.getDistanceDeleteLog(10, 'A');
    const bRows = await repo.getDistanceDeleteLog(10, 'B');
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].nodesDeleted).toBe(1);
    expect(bRows[0].nodesDeleted).toBe(2);
  });
});
