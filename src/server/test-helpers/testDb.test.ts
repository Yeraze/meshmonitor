import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, type TestDb } from './testDb.js';
import { TelemetryRepository } from '../../db/repositories/telemetry.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';

describe('createTestDb', () => {
  let t: TestDb | null = null;
  afterEach(() => { t?.close(); t = null; });

  it('builds the full schema from the migration registry (key tables present)', () => {
    t = createTestDb();
    const tables = (t.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]).map((r) => r.name);
    for (const expected of ['settings', 'nodes', 'telemetry', 'messages', 'user_map_preferences']) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }
  });

  it('includes columns added by recent migrations (e.g. telemetry.rxSnr — migration 089)', () => {
    t = createTestDb();
    const cols = (t.sqlite.prepare('PRAGMA table_info(telemetry)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('rxSnr');
    expect(cols).toContain('hopStart');
    expect(cols).toContain('hopLimit');
  });

  it('supports a repository insert/read round-trip against the generated schema', async () => {
    t = createTestDb();
    // nodes FK: telemetry.nodeNum references nodes.nodeNum — insert the node first.
    t.sqlite.prepare(
      "INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
    ).run(0xaabbccdd, '!aabbccdd', 'default', Date.now(), Date.now());

    const repo = new TelemetryRepository(t.db, 'sqlite');
    await repo.insertTelemetry({
      nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'battery',
      timestamp: Date.now(), value: 88, createdAt: Date.now(),
    });
    const rows = await repo.getTelemetryByNode('!aabbccdd', 10, undefined, undefined, 0, undefined, ALL_SOURCES);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(88);
  });
});
