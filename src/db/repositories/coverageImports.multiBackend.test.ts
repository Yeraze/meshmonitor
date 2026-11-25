/**
 * CoverageImportsRepository + the imported-row paths of
 * CoverageReceptionsRepository, on SQLite, PostgreSQL and MySQL
 * (Walkabout Coverage epic #5891, Phase 3 WP2).
 *
 * PG/MySQL tables come from the real migration runners (172 + 249), each
 * backend in its OWN isolated database (`isolationKey: 'covimp'`).
 * Covers per-source isolation too (every method on A never touches B).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { CoverageImportsRepository, CoverageImportDuplicateError } from './coverageImports.js';
import { CoverageReceptionsRepository } from './coverageReceptions.js';
import { runMigration172Postgres, runMigration172Mysql } from '../../server/migrations/172_create_coverage_receptions.js';
import { runMigration249Postgres, runMigration249Mysql } from '../../server/migrations/249_create_coverage_imports.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import type { ParsedCoverageImportRow } from '../../types/coverageImport.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

function row(overrides: Partial<ParsedCoverageImportRow> = {}): ParsedCoverageImportRow {
  return {
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aabbccdd',
    receiverNodeNum: 0xaabbccdd,
    receiverLatitude: 40.0,
    receiverLongitude: -105.0,
    senderId: '!bbbbbbbb',
    senderNodeNum: 0xbbbbbbbb,
    packetKey: '100',
    packetId: 100,
    pathKey: 'r0:h0',
    latitude: 40.1,
    longitude: -105.1,
    altitude: null,
    precisionBits: null,
    snr: -7.25,
    rssi: 0,
    hopStart: 3,
    hopLimit: 3,
    hopsAway: 0,
    relayNode: 0,
    channel: 0,
    receivedAt: NOW,
    ...overrides,
  };
}

interface Ctx {
  imports: CoverageImportsRepository;
  rx: CoverageReceptionsRepository;
  clear: () => Promise<void>;
}

function importParams(id: string, sourceId: string, sha: string, importedAt = NOW) {
  return {
    id, sourceId, kind: 'coverage_report' as const, format: 'csv' as const,
    filename: `${id}.csv`, fileSha256: sha, importedBy: 7, importedAt, rowCount: 10,
  };
}

const live = (rx: CoverageReceptionsRepository, over: Record<string, unknown> = {}) =>
  rx.recordReception({
    sourceId: 'src-a', protocol: 'meshtastic', receiverKind: 'local', receiverId: '!aabbccdd', receiverNodeNum: 0xaabbccdd,
    senderId: '!bbbbbbbb', senderNodeNum: 0xbbbbbbbb, packetKey: '1', pathKey: 'live', latitude: 40, longitude: -105,
    receivedAt: NOW, ...over,
  });

function runSharedTests(getCtx: () => Ctx) {
  beforeEach(async () => { await getCtx().clear(); });

  it('creates, reads, completes and lists imports (newest first), coercing bigint and boolean', async () => {
    const { imports } = getCtx();
    const created = await imports.createImport(importParams('i1', 'src-a', 'h1', NOW - 2 * DAY));
    expect(created).toMatchObject({ id: 'i1', status: 'importing', insertedCount: 0, sourceTruncated: false, importedBy: 7 });
    await imports.createImport(importParams('i2', 'src-a', 'h2', NOW));
    await imports.completeImport('src-a', 'i1', {
      insertedCount: 8, duplicateCount: 1, skippedCount: 1,
      firstReceivedAt: NOW - 3 * DAY, lastReceivedAt: NOW - DAY, sourceTruncated: true,
    });
    const got = await imports.getImport('src-a', 'i1');
    expect(got).toMatchObject({
      status: 'complete', insertedCount: 8, duplicateCount: 1, skippedCount: 1,
      firstReceivedAt: NOW - 3 * DAY, lastReceivedAt: NOW - DAY, sourceTruncated: true, importedAt: NOW - 2 * DAY,
    });
    expect(typeof got!.importedAt).toBe('number');
    expect((await imports.listImports('src-a')).map((i) => i.id)).toEqual(['i2', 'i1']);
    expect((await imports.listImports('src-a', 1)).map((i) => i.id)).toEqual(['i2']);
    expect(await imports.countImports('src-a')).toBe(2);
    expect((await imports.findByHash('src-a', 'h2'))?.id).toBe('i2');
    expect(await imports.findByHash('src-a', 'nope')).toBeNull();
  });

  it('throws CoverageImportDuplicateError for the same hash on one source, allows it on another', async () => {
    const { imports } = getCtx();
    await imports.createImport(importParams('i1', 'src-a', 'same'));
    await expect(imports.createImport(importParams('i2', 'src-a', 'same'))).rejects.toBeInstanceOf(CoverageImportDuplicateError);
    await expect(imports.createImport(importParams('i3', 'src-b', 'same'))).resolves.toMatchObject({ id: 'i3' });
    expect(await imports.countImports('src-a')).toBe(1);
  });

  it('insertImportedRows: a duplicate mid-batch loses nothing else and the count is exact', async () => {
    const { imports, rx } = getCtx();
    await imports.createImport(importParams('i1', 'src-a', 'h1'));
    // A live row already holds the key of the middle row.
    await live(rx, { packetKey: '3', pathKey: 'p3' });
    const rows = [1, 2, 3, 4, 5].map((n) => row({ packetKey: String(n), pathKey: `p${n}` }));
    expect(await rx.insertImportedRows('src-a', 'i1', rows)).toBe(4);
    const page = await rx.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 100 });
    expect(page.items).toHaveLength(5);
    expect(page.items.filter((r) => r.importId === 'i1').map((r) => r.packetKey).sort()).toEqual(['1', '2', '4', '5']);
    expect(page.items.find((r) => r.packetKey === '3')!.importId).toBeNull();
    // Re-insert: everything is a duplicate now.
    expect(await rx.insertImportedRows('src-a', 'i1', rows)).toBe(0);
    expect(await rx.countImportedRows('src-a')).toBe(4);
  });

  it('insertImportedRows spans chunks and keeps field values', async () => {
    const { imports, rx } = getCtx();
    await imports.createImport(importParams('i1', 'src-a', 'h1'));
    const rows = Array.from({ length: 1203 }, (_, n) => row({ packetKey: String(n), pathKey: 'p', receivedAt: NOW - n }));
    expect(await rx.insertImportedRows('src-a', 'i1', rows)).toBe(1203);
    const [one] = (await rx.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 1 })).items;
    expect(one).toMatchObject({ rssi: 0, snr: -7.25, receiverNodeNum: 0xaabbccdd, senderNodeNum: 0xbbbbbbbb, importId: 'i1', rxTime: null });
  });

  it('imported modes and importId filter getReceptions / getReceivers / getSenderSummary', async () => {
    const { imports, rx } = getCtx();
    await imports.createImport(importParams('i1', 'src-a', 'h1'));
    await imports.createImport(importParams('i2', 'src-a', 'h2'));
    await live(rx);
    await rx.insertImportedRows('src-a', 'i1', [row({ packetKey: 'a', receiverId: '!imp1' }), row({ packetKey: 'b', receiverId: '!imp1' })]);
    await rx.insertImportedRows('src-a', 'i2', [row({ packetKey: 'c', senderId: '!other' })]);
    const base = { sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 100 };
    const keys = async (extra: Record<string, unknown>) =>
      (await rx.getReceptions({ ...base, ...extra })).items.map((r) => r.packetKey).sort();
    expect(await keys({})).toEqual(['1', 'a', 'b', 'c']);
    expect(await keys({ imported: 'include' })).toEqual(['1', 'a', 'b', 'c']);
    expect(await keys({ imported: 'exclude' })).toEqual(['1']);
    expect(await keys({ imported: 'only' })).toEqual(['a', 'b', 'c']);
    expect(await keys({ importId: 'i1' })).toEqual(['a', 'b']);
    expect(await keys({ importId: 'i2', imported: 'exclude' })).toEqual(['c']); // importId wins

    const rcv = await rx.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
    const imp1 = rcv.find((r) => r.receiverId === '!imp1')!;
    expect(imp1).toMatchObject({ importedRows: 2, liveRows: 0, receptionCount: 2 });
    expect(rcv.find((r) => r.receiverId === '!aabbccdd')).toMatchObject({ importedRows: 1, liveRows: 1 });
    expect((await rx.getReceivers({ sourceIds: ['src-a'], sinceMs: 0, imported: 'exclude' })).map((r) => r.receiverId)).toEqual(['!aabbccdd']);
    expect((await rx.getReceivers({ sourceIds: ['src-a'], sinceMs: 0, importId: 'i1' })).map((r) => r.receiverId)).toEqual(['!imp1']);

    const sum = await rx.getSenderSummary({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, limit: 10 });
    expect(sum.find((s) => s.senderId === '!other')).toMatchObject({ importedRows: 1, liveRows: 0, fixCount: 1 });
    expect(sum.find((s) => s.senderId === '!bbbbbbbb')).toMatchObject({ importedRows: 2, liveRows: 1 });
    expect((await rx.getSenderSummary({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, limit: 10, imported: 'only', importId: 'i2' })).map((s) => s.senderId)).toEqual(['!other']);
  });

  it('purgeOlderThan keeps imported rows even when they are old', async () => {
    const { imports, rx } = getCtx();
    await imports.createImport(importParams('i1', 'src-a', 'h1'));
    await live(rx, { receivedAt: NOW - 100 * DAY, pathKey: 'oldlive' });
    await rx.insertImportedRows('src-a', 'i1', [row({ receivedAt: NOW - 100 * DAY })]);
    expect(await rx.purgeOlderThan(NOW - 30 * DAY)).toBe(1);
    const page = await rx.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW, pageSize: 10 });
    expect(page.items.map((r) => r.importId)).toEqual(['i1']);
  });

  it('exportSurveyReceptions skips imported rows; exportImportedReceptionsPage pages them by id across sources', async () => {
    const { imports, rx } = getCtx();
    await imports.createImport(importParams('i1', 'src-a', 'h1'));
    await imports.createImport(importParams('i2', 'src-b', 'h1'));
    await live(rx, { senderId: '!survey01', pathKey: 'live' });
    await rx.insertImportedRows('src-a', 'i1', [1, 2, 3].map((n) => row({ senderId: '!survey01', packetKey: `a${n}`, pathKey: 'p' })));
    await rx.insertImportedRows('src-b', 'i2', [1, 2].map((n) => row({ packetKey: `b${n}`, pathKey: 'p' })));
    const survey = await rx.exportSurveyReceptions([{ senderId: '!survey01', startAt: 0, endAt: NOW + 1 }]);
    expect(survey.map((r) => r.pathKey)).toEqual(['live']);

    const seen: string[] = [];
    let afterId = 0;
    const sizes: number[] = [];
    for (;;) {
      const { rows, lastId } = await rx.exportImportedReceptionsPage(afterId, 2);
      if (lastId === null) { expect(rows).toEqual([]); break; }
      sizes.push(rows.length);
      for (const r of rows) {
        expect('id' in r).toBe(false);
        expect(r.importId).not.toBeNull();
        seen.push(`${r.sourceId}:${r.packetKey}`);
      }
      expect(lastId).toBeGreaterThan(afterId);
      afterId = lastId;
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen.sort()).toEqual(['src-a:a1', 'src-a:a2', 'src-a:a3', 'src-b:b1', 'src-b:b2']);
    expect(new Set(seen).size).toBe(5);
  });

  it('deleteForSource / deleteAll with keepImported spare imported rows', async () => {
    const { imports, rx } = getCtx();
    await imports.createImport(importParams('i1', 'src-a', 'h1'));
    await live(rx);
    await rx.insertImportedRows('src-a', 'i1', [row()]);
    expect(await rx.deleteForSource('src-a', { keepImported: true })).toBe(1);
    expect(await rx.countImportedRows('src-a')).toBe(1);
    await live(rx);
    expect(await rx.deleteAll({ keepImported: true })).toBe(1);
    expect(await rx.countImportedRows('src-a')).toBe(1);
    expect(await rx.deleteAll()).toBe(1);
    expect(await rx.countImportedRows('src-a')).toBe(0);
  });

  it('deleteImport removes only its own rows, scoped to the source', async () => {
    const { imports, rx } = getCtx();
    await imports.createImport(importParams('i1', 'src-a', 'h1'));
    await imports.createImport(importParams('i2', 'src-a', 'h2'));
    await imports.createImport(importParams('i3', 'src-b', 'h1'));
    await live(rx);
    await rx.insertImportedRows('src-a', 'i1', [row({ packetKey: 'x' })]);
    await rx.insertImportedRows('src-a', 'i2', [row({ packetKey: 'y' })]);
    await rx.insertImportedRows('src-b', 'i3', [row({ packetKey: 'x' })]);
    // Wrong source cannot delete A's import.
    expect(await imports.deleteImport('src-b', 'i1')).toBe(false);
    expect(await rx.countImportedRows('src-a')).toBe(2);
    expect(await imports.deleteImport('src-a', 'i1')).toBe(true);
    expect(await imports.getImport('src-a', 'i1')).toBeNull();
    expect(await imports.deleteImport('src-a', 'i1')).toBe(false);
    const all = await rx.getReceptions({ sourceIds: ['src-a', 'src-b'], sinceMs: 0, untilMs: NOW + 1, pageSize: 100 });
    expect(all.items.map((r) => `${r.sourceId}:${r.importId}`).sort()).toEqual(['src-a:i2', 'src-a:null', 'src-b:i3']);
  });

  it('imports.deleteForSource removes that source\'s imported rows and batches only (purge trap)', async () => {
    const { imports, rx } = getCtx();
    await imports.createImport(importParams('i1', 'src-a', 'h1'));
    await imports.createImport(importParams('i3', 'src-b', 'h1'));
    await live(rx);
    await rx.insertImportedRows('src-a', 'i1', [row()]);
    await rx.insertImportedRows('src-b', 'i3', [row()]);
    // A purge first keeps imported rows ...
    await rx.deleteForSource('src-a', { keepImported: true });
    expect(await rx.countImportedRows('src-a')).toBe(1);
    // ... source delete then removes them.
    await imports.deleteForSource('src-a');
    expect(await rx.countImportedRows('src-a')).toBe(0);
    expect(await imports.countImports('src-a')).toBe(0);
    expect(await rx.countImportedRows('src-b')).toBe(1);
    expect(await imports.countImports('src-b')).toBe(1);
    // Live rows of A were untouched by it.
    await live(rx);
    await imports.deleteForSource('src-a');
    expect((await rx.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 })).items).toHaveLength(1);
  });

  it('every read and write on source A leaves source B alone', async () => {
    const { imports, rx } = getCtx();
    await imports.createImport(importParams('b1', 'src-b', 'h1'));
    await rx.insertImportedRows('src-b', 'b1', [row()]);
    expect(await imports.countImports('src-a')).toBe(0);
    expect(await imports.listImports('src-a')).toEqual([]);
    expect(await imports.findByHash('src-a', 'h1')).toBeNull();
    expect(await imports.getImport('src-a', 'b1')).toBeNull();
    await imports.completeImport('src-a', 'b1', {
      insertedCount: 99, duplicateCount: 0, skippedCount: 0, firstReceivedAt: null, lastReceivedAt: null, sourceTruncated: false,
    });
    expect(await imports.getImport('src-b', 'b1')).toMatchObject({ status: 'importing', insertedCount: 0 });
    expect(await rx.countImportedRows('src-a')).toBe(0);
    expect(await rx.deleteImportRows('src-a', 'b1')).toBe(0);
    expect(await rx.deleteImportedForSource('src-a')).toBe(0);
    expect(await rx.countImportedRows('src-b')).toBe(1);
  });

  it('rejects empty ids (fail closed)', async () => {
    const { rx } = getCtx();
    await expect(rx.insertImportedRows('', 'i', [])).rejects.toThrow();
    await expect(rx.insertImportedRows('src-a', '', [])).rejects.toThrow();
    await expect(rx.deleteImportRows('src-a', '')).rejects.toThrow();
  });
}

describe('CoverageImports — SQLite', () => {
  let ctx: Ctx;
  let close: () => void;
  beforeEach(() => {
    const t = createTestDb();
    close = () => t.sqlite.close();
    ctx = {
      imports: new CoverageImportsRepository(t.db as any, 'sqlite'), // eslint-disable-line @typescript-eslint/no-explicit-any -- test db
      rx: new CoverageReceptionsRepository(t.db as any, 'sqlite'), // eslint-disable-line @typescript-eslint/no-explicit-any -- test db
      clear: async () => {},
    };
  });
  afterEach(() => close());
  runSharedTests(() => ctx);
});

describe.skipIf(!postgresAvailable)('CoverageImports — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let ctx: Ctx;
  beforeAll(async () => {
    const isolated = await createIsolatedPostgresDatabase('covimp');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    const client = await pool.connect();
    try {
      await runMigration172Postgres(client);
      await runMigration249Postgres(client);
    } finally {
      client.release();
    }
    const db = drizzlePostgres(pool, { schema });
    ctx = {
      imports: new CoverageImportsRepository(db, 'postgres'),
      rx: new CoverageReceptionsRepository(db, 'postgres'),
      clear: async () => {
        await pool.query('TRUNCATE TABLE coverage_receptions, coverage_imports RESTART IDENTITY CASCADE');
      },
    };
  });
  afterAll(async () => { await cleanupDb?.(); });
  runSharedTests(() => ctx);
});

describe.skipIf(!mysqlAvailable)('CoverageImports — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let ctx: Ctx;
  beforeAll(async () => {
    const isolated = await createIsolatedMysqlDatabase('covimp');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    await runMigration172Mysql(pool);
    await runMigration249Mysql(pool);
    const db = drizzleMysql(pool, { schema, mode: 'default' });
    ctx = {
      imports: new CoverageImportsRepository(db, 'mysql'),
      rx: new CoverageReceptionsRepository(db, 'mysql'),
      clear: async () => {
        await pool.query('TRUNCATE TABLE coverage_receptions');
        await pool.query('TRUNCATE TABLE coverage_imports');
      },
    };
  });
  afterAll(async () => { await cleanupDb?.(); });
  runSharedTests(() => ctx);
});
