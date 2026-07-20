/**
 * Migration 030 — PostgreSQL / MySQL rebuild behaviour (#4233)
 *
 * The PG/MySQL paths of this migration used to unconditionally
 * `DELETE FROM route_segments` and then re-INSERT every rebuilt segment one
 * round-trip at a time. Because PG/MySQL had no migration ledger, that ran on
 * *every* boot — on a production instance it cleared 865,865 rows and rebuilt
 * them one INSERT at a time on each restart, blocking startup for minutes and
 * locking autovacuum out of the table.
 *
 * These tests pin both halves of the fix:
 *   1. the migration skips the destructive rebuild when sourceId already exists
 *   2. the rebuild batches its inserts instead of one round-trip per row
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runMigration030Postgres,
  runMigration030Mysql,
} from './030_add_source_id_to_route_segments.js';

/**
 * Traceroutes that each rebuild into exactly 2 segments.
 *
 * `routePositions` is a map keyed by nodeNum with `lat`/`lng`, and the rebuilt
 * path is `[toNodeNum, ...route, fromNodeNum]` — so one intermediate hop with
 * positions for all three nodes yields 2 segments.
 */
function tracerouteRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    fromNodeNum: 100 + i,
    toNodeNum: 200 + i,
    route: JSON.stringify([150 + i]),
    routePositions: JSON.stringify({
      [100 + i]: { lat: 30.0, lng: -95.0 },
      [150 + i]: { lat: 30.5, lng: -95.5 },
      [200 + i]: { lat: 31.0, lng: -96.0 },
    }),
    timestamp: 1_700_000_000_000 + i,
    sourceId: 'src-1',
  }));
}

function fakePgClient(opts: { columnExists: boolean; traceroutes?: any[] }) {
  const queries: { sql: string; params?: any[] }[] = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ exists: opts.columnExists }] };
      }
      if (sql.includes('FROM traceroutes')) {
        return { rows: opts.traceroutes ?? [] };
      }
      if (sql.trimStart().startsWith('DELETE')) {
        return { rows: [], rowCount: 865 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

function fakeMysqlPool(opts: { columnExists: boolean; traceroutes?: any[] }) {
  const queries: { sql: string; params?: any[] }[] = [];
  const conn = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      if (sql.includes('information_schema.COLUMNS')) {
        return [opts.columnExists ? [{ COLUMN_NAME: 'sourceId' }] : []];
      }
      if (sql.includes('information_schema.STATISTICS')) {
        return [[{ cnt: 1 }]];
      }
      if (sql.includes('FROM traceroutes')) {
        return [opts.traceroutes ?? []];
      }
      if (sql.trimStart().startsWith('DELETE')) {
        return [{ affectedRows: 865 }];
      }
      return [{}];
    }),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  };
  return { queries, conn, getConnection: async () => conn };
}

const isDelete = (q: { sql: string }) => q.sql.trimStart().startsWith('DELETE');
const isInsert = (q: { sql: string }) => q.sql.trimStart().startsWith('INSERT');

// PostgreSQL binds isRecordHolder as a parameter; MySQL hardcodes it as `0`
// in the tuple, so its rows carry one fewer bind parameter.
const PG_PARAMS_PER_ROW = 13;
const MYSQL_PARAMS_PER_ROW = 12;

describe('migration 030 — PostgreSQL', () => {
  it('skips the destructive rebuild when sourceId already exists', async () => {
    const client = fakePgClient({ columnExists: true, traceroutes: tracerouteRows(5) });

    await runMigration030Postgres(client);

    // The whole point: no DELETE, no rebuild, no transaction.
    expect(client.queries.filter(isDelete)).toHaveLength(0);
    expect(client.queries.filter(isInsert)).toHaveLength(0);
    expect(client.queries.some(q => q.sql.includes('BEGIN'))).toBe(false);
  });

  it('rebuilds when sourceId is missing', async () => {
    const client = fakePgClient({ columnExists: false, traceroutes: tracerouteRows(2) });

    await runMigration030Postgres(client);

    expect(client.queries.filter(isDelete)).toHaveLength(1);
    expect(client.queries.filter(isInsert).length).toBeGreaterThan(0);
    expect(client.queries.some(q => q.sql.includes('COMMIT'))).toBe(true);
  });

  it('batches inserts instead of one round-trip per segment', async () => {
    // 200 traceroutes × 2 segments each = 400 segments, one batch of 500.
    const client = fakePgClient({ columnExists: false, traceroutes: tracerouteRows(200) });

    await runMigration030Postgres(client);

    const inserts = client.queries.filter(isInsert);
    expect(inserts).toHaveLength(1);
    // A single multi-row INSERT carrying every segment's parameters.
    expect(inserts[0].params!.length).toBe(400 * PG_PARAMS_PER_ROW);
    expect(inserts[0].sql).toContain('$5200');
  });

  it('splits into multiple batches beyond the batch size', async () => {
    // 400 traceroutes × 2 segments = 800 segments → 2 batches (500 + 300).
    const client = fakePgClient({ columnExists: false, traceroutes: tracerouteRows(400) });

    await runMigration030Postgres(client);

    const inserts = client.queries.filter(isInsert);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params!.length).toBe(500 * PG_PARAMS_PER_ROW);
    expect(inserts[1].params!.length).toBe(300 * PG_PARAMS_PER_ROW);
  });

  it('falls back to per-row inserts when a batch fails, skipping only bad rows', async () => {
    const client = fakePgClient({ columnExists: false, traceroutes: tracerouteRows(3) });
    const realQuery = client.query;
    let seenBatch = false;

    client.query = vi.fn(async (sql: string, params?: any[]) => {
      if (sql.trimStart().startsWith('INSERT') && !seenBatch) {
        seenBatch = true;
        client.queries.push({ sql, params });
        throw new Error('duplicate key');
      }
      // One individual row also fails — it must be skipped, not fatal.
      if (sql.trimStart().startsWith('INSERT') && params?.[0] === 200) {
        client.queries.push({ sql, params });
        throw new Error('foreign key violation');
      }
      return realQuery(sql, params);
    }) as any;

    await expect(runMigration030Postgres(client)).resolves.toBeUndefined();

    // Recovered via savepoint and retried row-by-row.
    expect(client.queries.some(q => q.sql.includes('ROLLBACK TO SAVEPOINT batch_sp'))).toBe(true);
    expect(client.queries.some(q => q.sql.includes('SAVEPOINT row_sp'))).toBe(true);
    expect(client.queries.some(q => q.sql.includes('COMMIT'))).toBe(true);
  });
});

describe('migration 030 — MySQL', () => {
  it('skips the destructive rebuild when sourceId already exists', async () => {
    const pool = fakeMysqlPool({ columnExists: true, traceroutes: tracerouteRows(5) });

    await runMigration030Mysql(pool);

    expect(pool.queries.filter(isDelete)).toHaveLength(0);
    expect(pool.queries.filter(isInsert)).toHaveLength(0);
    expect(pool.conn.beginTransaction).not.toHaveBeenCalled();
    expect(pool.conn.release).toHaveBeenCalled();
  });

  it('still ensures the sourceId index on the skip path', async () => {
    const pool = fakeMysqlPool({ columnExists: true });

    await runMigration030Mysql(pool);

    expect(pool.queries.some(q => q.sql.includes('information_schema.STATISTICS'))).toBe(true);
  });

  it('rebuilds with batched inserts when sourceId is missing', async () => {
    const pool = fakeMysqlPool({ columnExists: false, traceroutes: tracerouteRows(200) });

    await runMigration030Mysql(pool);

    expect(pool.queries.filter(isDelete)).toHaveLength(1);
    const inserts = pool.queries.filter(isInsert);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params!.length).toBe(400 * MYSQL_PARAMS_PER_ROW);
    expect(pool.conn.commit).toHaveBeenCalled();
  });

  it('falls back to per-row inserts when a batch fails', async () => {
    const pool = fakeMysqlPool({ columnExists: false, traceroutes: tracerouteRows(3) });
    const realQuery = pool.conn.query;
    let seenBatch = false;

    pool.conn.query = vi.fn(async (sql: string, params?: any[]) => {
      if (sql.trimStart().startsWith('INSERT') && !seenBatch) {
        seenBatch = true;
        pool.queries.push({ sql, params });
        throw new Error('duplicate key');
      }
      return realQuery(sql, params);
    }) as any;

    await expect(runMigration030Mysql(pool)).resolves.toBeUndefined();

    // 6 segments retried individually after the batch failed.
    const rowInserts = pool.queries.filter(
      q => isInsert(q) && q.params?.length === MYSQL_PARAMS_PER_ROW,
    );
    expect(rowInserts).toHaveLength(6);
    expect(pool.conn.commit).toHaveBeenCalled();
  });
});
