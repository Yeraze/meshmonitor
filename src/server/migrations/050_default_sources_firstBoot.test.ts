/**
 * Fresh-install default sources through the REAL migration registry
 * (#5874 follow-up: MESHCORE_* first-boot vars).
 *
 * Migration 050 is what creates the default sources on a fresh install. These
 * cases replay every migration on an empty database with different env and
 * check the resulting `sources` rows, then re-run the creation path with
 * changed env to show a later boot adds nothing.
 *
 * PostgreSQL / MySQL halves use their own isolated databases (CLAUDE.md
 * Multi-Database) and skip silently without the containers; confirm with
 * `numPendingTests`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../test-helpers/testDb.js';
import { registry } from '../../db/migrations.js';
import {
  readAppliedMigrationsPostgres,
  markMigrationAppliedPostgres,
  readAppliedMigrationsMysql,
  markMigrationAppliedMysql,
  runLedgeredMigrations,
} from '../../db/migrationLedger.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';
import {
  migration as migration050,
  runMigration050Postgres,
  runMigration050Mysql,
} from './050_promote_globals_to_default_source.js';

const ENV_KEYS = [
  'MESHTASTIC_NODE_IP',
  'MESHTASTIC_TCP_PORT',
  'MESHTASTIC_NODE_PORT',
  'ENABLE_VIRTUAL_NODE',
  'VIRTUAL_NODE_PORT',
  'MESHCORE_TCP_HOST',
  'MESHCORE_TCP_PORT',
  'MESHCORE_SERIAL_PORT',
  'MESHCORE_BAUD_RATE',
  'MESHCORE_DEVICE_TYPE',
  'MESHCORE_ENABLE_VIRTUAL_NODE',
  'MESHCORE_VIRTUAL_NODE_PORT',
] as const;

const saved: Record<string, string | undefined> = {};
function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

interface Row { name: string; type: string; config: Record<string, any>; enabled: boolean }

function sqliteRows(t: TestDb): Row[] {
  return (t.sqlite.prepare(`SELECT name, type, config, enabled FROM sources ORDER BY createdAt, rowid`).all() as any[])
    .map((r) => ({ name: r.name, type: r.type, config: JSON.parse(r.config), enabled: r.enabled === 1 }));
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('fresh install default sources — SQLite (full registry)', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.close());

  it('neither set: the disabled Meshtastic placeholder, as today', () => {
    setEnv({});
    t = createTestDb();
    const rows = sqliteRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Default', type: 'meshtastic_tcp', enabled: false });
    expect(rows[0].config.host).toBe('meshtastic.local');
  });

  it('Meshtastic only: one enabled Default, unchanged', () => {
    setEnv({ MESHTASTIC_NODE_IP: '192.0.2.1' });
    t = createTestDb();
    const rows = sqliteRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Default', type: 'meshtastic_tcp', enabled: true });
    expect(rows[0].config).toEqual({ host: '192.0.2.1', port: 4403 });
  });

  it('MeshCore only: exactly one MeshCore source with its Virtual Node, no placeholder', () => {
    setEnv({ MESHCORE_TCP_HOST: '192.0.2.10', MESHCORE_ENABLE_VIRTUAL_NODE: 'true' });
    t = createTestDb();
    const rows = sqliteRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Default MeshCore', type: 'meshcore', enabled: true });
    expect(rows[0].config).toEqual({
      transport: 'tcp',
      tcpHost: '192.0.2.10',
      tcpPort: 5000,
      deviceType: 'companion',
      autoConnect: true,
      heartbeatIntervalSeconds: 30,
      virtualNode: { enabled: true, port: 5000, allowAdminCommands: false, allowPkiExport: false, allowPkiImport: false },
    });
  });

  it('MeshCore serial only: transport usb, port field', () => {
    setEnv({ MESHCORE_SERIAL_PORT: '/dev/ttyUSB0' });
    t = createTestDb();
    const rows = sqliteRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].config).toMatchObject({ transport: 'usb', port: '/dev/ttyUSB0' });
  });

  it('both: two sources, Meshtastic first', () => {
    setEnv({ MESHTASTIC_NODE_IP: '192.0.2.1', MESHCORE_TCP_HOST: '192.0.2.10' });
    t = createTestDb();
    const rows = sqliteRows(t);
    expect(rows.map((r) => [r.name, r.type, r.enabled])).toEqual([
      ['Default', 'meshtastic_tcp', true],
      ['Default MeshCore', 'meshcore', true],
    ]);
  });

  it('a second run with changed env adds nothing', () => {
    setEnv({ MESHCORE_TCP_HOST: '192.0.2.10' });
    t = createTestDb();
    const before = sqliteRows(t);
    setEnv({ MESHTASTIC_NODE_IP: '192.0.2.1', MESHCORE_SERIAL_PORT: '/dev/ttyUSB0', MESHCORE_TCP_HOST: '198.51.100.7' });
    migration050.up(t.sqlite as any);
    expect(sqliteRows(t)).toEqual(before);
  });

  it('an existing install that adds the MeshCore vars later grows no source', () => {
    setEnv({ MESHTASTIC_NODE_IP: '192.0.2.1' });
    t = createTestDb();
    setEnv({ MESHTASTIC_NODE_IP: '192.0.2.1', MESHCORE_TCP_HOST: '192.0.2.10' });
    migration050.up(t.sqlite as any);
    const rows = sqliteRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('meshtastic_tcp');
  });
});

async function pgRows(pool: any): Promise<Row[]> {
  const r = await pool.query(`SELECT name, type, config, enabled FROM sources ORDER BY "createdAt", id`);
  return r.rows.map((x: any) => ({
    name: x.name, type: x.type, config: typeof x.config === 'string' ? JSON.parse(x.config) : x.config, enabled: x.enabled === true,
  }));
}

describe.skipIf(!postgresAvailable)('fresh install default sources — PostgreSQL (container)', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresDatabase>> | undefined;
  afterAll(async () => { await isolated?.cleanup(); });

  it('MeshCore only, then a later boot with changed env adds nothing', async () => {
    setEnv({ MESHCORE_TCP_HOST: '192.0.2.10', MESHCORE_ENABLE_VIRTUAL_NODE: 'true' });
    isolated = await createIsolatedPostgresDatabase('fb5874');
    const client = await isolated.pool.connect();
    try {
      await runLedgeredMigrations({
        backend: 'PostgreSQL', handle: client, migrations: registry.getAll(), pick: (m) => m.postgres,
        readApplied: readAppliedMigrationsPostgres, markApplied: markMigrationAppliedPostgres,
      });
      const rows = await pgRows(isolated.pool);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'Default MeshCore', type: 'meshcore', enabled: true });
      expect(rows[0].config.virtualNode).toMatchObject({ enabled: true, port: 5000, allowAdminCommands: false });

      setEnv({ MESHTASTIC_NODE_IP: '192.0.2.1', MESHCORE_SERIAL_PORT: '/dev/ttyUSB0' });
      await runMigration050Postgres(client);
      expect(await pgRows(isolated.pool)).toEqual(rows);
    } finally {
      client.release();
    }
  }, 180_000);

  it('both set: two rows, Meshtastic first', async () => {
    setEnv({ MESHTASTIC_NODE_IP: '192.0.2.1', MESHCORE_TCP_HOST: '192.0.2.10' });
    const iso = await createIsolatedPostgresDatabase('fb5874b');
    const client = await iso.pool.connect();
    try {
      await runLedgeredMigrations({
        backend: 'PostgreSQL', handle: client, migrations: registry.getAll(), pick: (m) => m.postgres,
        readApplied: readAppliedMigrationsPostgres, markApplied: markMigrationAppliedPostgres,
      });
      const rows = await pgRows(iso.pool);
      expect(rows.map((r) => [r.type, r.enabled])).toEqual([['meshtastic_tcp', true], ['meshcore', true]]);
    } finally {
      client.release();
      await iso.cleanup();
    }
  }, 180_000);
});

async function mysqlRows(pool: any): Promise<Row[]> {
  const [r] = await pool.query(`SELECT name, type, config, enabled FROM sources ORDER BY createdAt, id`);
  return (r as any[]).map((x) => ({
    name: x.name, type: x.type, config: typeof x.config === 'string' ? JSON.parse(x.config) : x.config, enabled: Number(x.enabled) === 1,
  }));
}

describe.skipIf(!mysqlAvailable)('fresh install default sources — MySQL (container)', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedMysqlDatabase>> | undefined;
  afterAll(async () => { await isolated?.cleanup(); });

  it('MeshCore only, then a later boot with changed env adds nothing', async () => {
    setEnv({ MESHCORE_SERIAL_PORT: '/dev/ttyUSB0', MESHCORE_DEVICE_TYPE: 'repeater' });
    isolated = await createIsolatedMysqlDatabase('fb5874');
    await runLedgeredMigrations({
      backend: 'MySQL', handle: isolated.pool, migrations: registry.getAll(), pick: (m) => m.mysql,
      readApplied: readAppliedMigrationsMysql, markApplied: markMigrationAppliedMysql,
    });
    const rows = await mysqlRows(isolated.pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Default MeshCore', type: 'meshcore', enabled: true });
    expect(rows[0].config).toEqual({ transport: 'usb', port: '/dev/ttyUSB0', deviceType: 'repeater', autoConnect: true });

    setEnv({ MESHTASTIC_NODE_IP: '192.0.2.1', MESHCORE_TCP_HOST: '192.0.2.10' });
    await runMigration050Mysql(isolated.pool);
    expect(await mysqlRows(isolated.pool)).toEqual(rows);
  }, 240_000);

  it('neither set: the disabled placeholder, as today', async () => {
    setEnv({});
    const iso = await createIsolatedMysqlDatabase('fb5874b');
    try {
      await runLedgeredMigrations({
        backend: 'MySQL', handle: iso.pool, migrations: registry.getAll(), pick: (m) => m.mysql,
        readApplied: readAppliedMigrationsMysql, markApplied: markMigrationAppliedMysql,
      });
      const rows = await mysqlRows(iso.pool);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'Default', type: 'meshtastic_tcp', enabled: false });
    } finally {
      await iso.cleanup();
    }
  }, 240_000);
});
