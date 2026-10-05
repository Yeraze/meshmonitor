/**
 * System backup → restore, end to end on SQLite, for EVERY table in the backup.
 *
 * Runs the real backup and restore services against the singleton's in-memory
 * SQLite and a real temp directory; nothing about the round trip is mocked.
 *
 * Before this suite the backup was a list of 28 tables out of 83. A restore of
 * a MeshCore-only install brought back no nodes, no messages and no
 * automations. Every table is now seeded from its live column list, so a table
 * added to BACKUP_TABLES is covered here without a new test.
 *
 * Also pinned here:
 *   - the wrong-SESSION_SECRET case for the encrypted tables,
 *   - an OLDER backup (28 tables, 1.0 file format),
 *   - a backup that lacks a column the schema has since gained,
 *   - a crafted metadata.json naming tables outside the allowlist,
 *   - all-or-nothing: a failure in the last table leaves the first untouched.
 *
 * The PostgreSQL and MySQL equivalents are in
 * systemBackupRestore.roundTrip.pgmysql.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const env = vi.hoisted(() => {
  // Read once at module load by both services, so it must be set before import.
  const dir = `${process.env.TMPDIR ?? '/tmp'}/mm-backup-roundtrip-${process.pid}-${Date.now()}`;
  process.env.SYSTEM_BACKUP_DIR = dir;
  return { dir };
});

// Restore writes a marker to /data/.restore-completed. Swallow that one write
// so the test never touches the host's /data; everything else is the real fs.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const writeFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (file === '/data/.restore-completed') return;
    return (actual.writeFileSync as (...a: unknown[]) => void)(file, ...rest);
  }) as typeof actual.writeFileSync;
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { systemBackupService, BACKUP_TABLES } from './systemBackupService.js';
import { systemRestoreService } from './systemRestoreService.js';
import { SourcePkiKeyStore, setSourcePkiKeyStoreForTesting } from './sourcePkiKeyStore.js';
import {
  MeshCoreObserverCredentialStore,
  setMeshCoreObserverCredentialStoreForTesting,
} from './meshcoreObserverCredentialStore.js';
import { buildSeedRow, seedTables, type SeedAdapter, type SeedRow } from './systemBackupRestore.testSeed.js';

/** The 28 tables a backup held before this change, in the order it listed them. */
const TABLES_BEFORE = [
  'sources', 'coverage_surveys', 'coverage_receptions', 'nodes', 'messages', 'channels', 'telemetry',
  'traceroutes', 'route_segments', 'neighbor_info', 'settings', 'users', 'permissions', 'audit_log',
  'read_messages', 'user_notification_preferences', 'auto_traceroute_nodes', 'packet_log', 'solar_estimates',
  'system_backup_history', 'auto_favorite_targets', 'auto_favorite_assignments', 'privacy_documents',
  'solar_node_overrides', 'asset_nodes', 'translation_cache', 'message_translations', 'meshcore_observer_keys',
];

const db = () => databaseService.db;

const shapes = new Map<string, unknown>();
function memo<T>(key: string, read: () => T): T {
  if (!shapes.has(key)) shapes.set(key, read());
  return shapes.get(key) as T;
}

const adapter: SeedAdapter = {
  dialect: 'sqlite',
  async columns(table) {
    return memo(`columns:${table}`, () => (db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>).map((c) => ({
      name: c.name,
      type: c.type.toLowerCase(),
    })));
  },
  async foreignKeys(table) {
    return memo(`fks:${table}`, () => (
      db().prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string; table: string; to: string | null }>
    ).map((fk) => ({ column: fk.from, parentTable: fk.table, parentColumn: fk.to ?? 'id' })));
  },
  async insert(table, row) {
    const columns = Object.keys(row);
    db()
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((c) => row[c]));
  },
};

const allRows = (table: string) => db().prepare(`SELECT * FROM ${table}`).all() as SeedRow[];
const count = (table: string) => (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Empty every backed-up table, children first. */
function wipe(): void {
  for (const table of [...BACKUP_TABLES].reverse()) db().prepare(`DELETE FROM ${table}`).run();
}

const backupFile = (dirname: string, name: string) => path.join(env.dir, dirname, name);
const readTable = (dirname: string, table: string) =>
  JSON.parse(fs.readFileSync(backupFile(dirname, `${table}.json`), 'utf8')) as SeedRow[];
const readMetadata = (dirname: string) => JSON.parse(fs.readFileSync(backupFile(dirname, 'metadata.json'), 'utf8'));
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Copy a backup directory, so a test can tamper with the copy. */
function copyBackup(from: string, to: string): void {
  fs.cpSync(path.join(env.dir, from), path.join(env.dir, to), { recursive: true });
}

/** Replace one table file in a backup and keep its checksum honest. */
function writeTable(dirname: string, table: string, text: string): void {
  fs.writeFileSync(backupFile(dirname, `${table}.json`), text);
  const metadata = readMetadata(dirname);
  metadata.checksums[table] = sha256(text);
  if (!metadata.tables.includes(table)) metadata.tables.push(table);
  fs.writeFileSync(backupFile(dirname, 'metadata.json'), JSON.stringify(metadata));
}

async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warned: string }> {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    const result = await run();
    return { result, warned: warn.mock.calls.map((c) => String(c[0])).join('\n') };
  } finally {
    warn.mockRestore();
  }
}

/**
 * The database service seeds the anonymous user in the background after it
 * reports ready (a bcrypt hash, then the user row, then its permissions). These
 * tests compare whole tables, so let that land before the first one runs
 * instead of somewhere in the middle of a comparison.
 */
async function waitForStartupSeeding(): Promise<void> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (db().prepare("SELECT 1 FROM users WHERE username = 'anonymous'").get()) break;
    await sleep(25);
  }
  // Its permission rows follow the user row. Done when the count holds still.
  let seen = -1;
  while (Date.now() < deadline) {
    const now = count('permissions');
    if (now === seen) break;
    seen = now;
    await sleep(200);
  }
}

beforeAll(async () => {
  await databaseService.waitForReady();
  await waitForStartupSeeding();
}, 60_000);

afterAll(() => {
  setSourcePkiKeyStoreForTesting(null);
  setMeshCoreObserverCredentialStoreForTesting(null);
  fs.rmSync(env.dir, { recursive: true, force: true });
});

describe('backup → restore round trip, every table (SQLite)', () => {
  let dirname: string;

  beforeAll(async () => {
    wipe();
    await seedTables(adapter, BACKUP_TABLES, 3);
    dirname = await systemBackupService.createBackup('manual');
  });

  it('writes a file for every table in BACKUP_TABLES, each holding the seeded rows', () => {
    const metadata = readMetadata(dirname);
    expect(metadata.backupVersion).toBe('1.1');
    expect(metadata.tables).toEqual(BACKUP_TABLES);
    expect(metadata.tableCount).toBe(BACKUP_TABLES.length);

    for (const table of BACKUP_TABLES) {
      // coverage_receptions exports only rows inside a saved survey's window.
      if (table === 'coverage_receptions') continue;
      expect(readTable(dirname, table).length, table).toBeGreaterThanOrEqual(3);
    }
  });

  it('passes validation', async () => {
    expect(await systemBackupService.validateBackup(dirname)).toEqual({ valid: true, errors: [] });
  });

  it.skipIf(process.platform === 'win32')('keeps the backup private to the server user (0700 directory, 0600 files)', () => {
    expect(fs.statSync(path.join(env.dir, dirname)).mode & 0o777).toBe(0o700);
    for (const name of fs.readdirSync(path.join(env.dir, dirname))) {
      expect(fs.statSync(backupFile(dirname, name)).mode & 0o777, name).toBe(0o600);
    }
  });

  it('restores every table to exactly what was backed up', async () => {
    // What a restore has to undo: everything gone, and different rows in place.
    wipe();
    await seedTables(adapter, BACKUP_TABLES, 2, 70);

    const result = await systemRestoreService.restoreFromBackup(dirname);
    expect(result).toMatchObject({ success: true, tablesRestored: BACKUP_TABLES.length });

    // Back the restored database up again: every table file must come out
    // byte-identical to the one that went in.
    const again = await systemBackupService.createBackup('manual');
    for (const table of BACKUP_TABLES) {
      const before = fs.readFileSync(backupFile(dirname, `${table}.json`), 'utf8');
      const after = fs.readFileSync(backupFile(again, `${table}.json`), 'utf8');
      if (table === 'audit_log') {
        // Restore records itself in the audit log, after the table was restored.
        expect(readTable(again, table)).toEqual(expect.arrayContaining(readTable(dirname, table)));
        continue;
      }
      if (table === 'system_backup_history') {
        // The first backup recorded itself after its own export.
        continue;
      }
      expect(after, table).toBe(before);
    }
  });
});

describe('a MeshCore-only install', () => {
  it('gets its source, nodes, messages and automations back', async () => {
    wipe();
    const seeded = new Map<string, SeedRow[]>();
    const add = async (table: string, n: number, overrides: SeedRow = {}) => {
      const row = await buildSeedRow(adapter, table, n, seeded, overrides);
      await adapter.insert(table, row);
      seeded.set(table, [...(seeded.get(table) ?? []), row]);
    };
    await add('sources', 1, { id: 'mc-only', name: 'Home repeater', type: 'meshcore' });
    await add('users', 1, { username: 'operator' });
    for (let n = 1; n <= 4; n++) await add('meshcore_nodes', n, { sourceId: 'mc-only' });
    for (let n = 1; n <= 6; n++) await add('meshcore_messages', n, { sourceId: 'mc-only' });
    for (let n = 1; n <= 2; n++) await add('automations', n);
    await add('meshcore_saved_regions', 1);

    // No Meshtastic data at all.
    expect(count('nodes')).toBe(0);
    expect(count('messages')).toBe(0);

    const before = Object.fromEntries(
      ['sources', 'meshcore_nodes', 'meshcore_messages', 'automations', 'meshcore_saved_regions'].map((t) => [
        t,
        allRows(t),
      ]),
    );
    const dirname = await systemBackupService.createBackup('manual');

    wipe();
    expect(count('meshcore_nodes')).toBe(0);

    const result = await systemRestoreService.restoreFromBackup(dirname);
    expect(result.success).toBe(true);

    expect(allRows('sources')).toEqual(before.sources);
    expect(allRows('meshcore_nodes')).toEqual(before.meshcore_nodes);
    expect(allRows('meshcore_messages')).toEqual(before.meshcore_messages);
    expect(allRows('automations')).toEqual(before.automations);
    expect(allRows('meshcore_saved_regions')).toEqual(before.meshcore_saved_regions);
    expect(count('meshcore_nodes')).toBe(4);
    expect(count('meshcore_messages')).toBe(6);
  });
});

describe('tables sealed with SESSION_SECRET, restored under a different one', () => {
  const SECRET_AT_BACKUP = 'session-secret-in-use-when-the-backup-was-made';
  const OTHER_SECRET = 'a-different-session-secret-on-the-restoring-install';
  const PKI_SOURCE = 'pki-source';
  const CRED_SOURCE = 'cred-source';
  const PRIVATE_KEY = Buffer.alloc(32, 0xa7);
  const BROKER_PASSWORD = 'broker-password-that-must-never-be-logged';

  let dirname: string;
  let pkiRow: unknown;
  let credRow: unknown;

  const useSecret = (secret: string) => {
    const pki = new SourcePkiKeyStore(secret, true);
    const cred = new MeshCoreObserverCredentialStore(secret, true);
    setSourcePkiKeyStoreForTesting(pki);
    setMeshCoreObserverCredentialStoreForTesting(cred);
    return { pki, cred };
  };

  const lastRestoreAudit = (): Record<string, unknown> => {
    const rows = allRows('audit_log').filter((r) => r.action === 'system_restore_completed');
    return JSON.parse(String(rows[rows.length - 1].details));
  };

  beforeAll(async () => {
    wipe();
    const { pki, cred } = useSecret(SECRET_AT_BACKUP);
    await pki.store(PKI_SOURCE, 0x1234abcd, PRIVATE_KEY, 'cHVibGlj');
    await cred.store(CRED_SOURCE, 'observer-user', BROKER_PASSWORD);
    pkiRow = await databaseService.sourcePkiKeys.getBySourceId(PKI_SOURCE);
    credRow = await databaseService.meshcoreObserverCredentials.getBySourceId(CRED_SOURCE);
    dirname = await systemBackupService.createBackup('manual');
  });

  it('the backup holds the two tables as ciphertext only', () => {
    const pkiFile = fs.readFileSync(backupFile(dirname, 'source_pki_keys.json'), 'utf8');
    const credFile = fs.readFileSync(backupFile(dirname, 'meshcore_observer_credentials.json'), 'utf8');
    expect(readTable(dirname, 'source_pki_keys').map((r) => r.sourceId)).toEqual([PKI_SOURCE]);
    expect(readTable(dirname, 'meshcore_observer_credentials').map((r) => r.sourceId)).toEqual([CRED_SOURCE]);
    expect(pkiFile).not.toContain(PRIVATE_KEY.toString('hex'));
    expect(pkiFile).not.toContain(PRIVATE_KEY.toString('base64'));
    expect(credFile).not.toContain(BROKER_PASSWORD);
  });

  it('restored under the same secret, both decrypt and nothing is reported', async () => {
    wipe();
    const { pki, cred } = useSecret(SECRET_AT_BACKUP);
    const { result, warned } = await captureWarnings(() => systemRestoreService.restoreFromBackup(dirname));

    expect(result.success).toBe(true);
    expect(await pki.load(PKI_SOURCE)).toEqual({ kind: 'ok', privateKey: PRIVATE_KEY });
    expect(await cred.load(CRED_SOURCE)).toMatchObject({ kind: 'ok', password: BROKER_PASSWORD });
    expect(warned).not.toMatch(/SESSION_SECRET cannot decrypt/);
    expect(lastRestoreAudit()).not.toHaveProperty('unreadablePkiKeys');
    expect(lastRestoreAudit()).not.toHaveProperty('unreadableObserverCredentials');
  });

  it('restored under a different secret: rows kept, a warning with ids only, and an audit entry', async () => {
    wipe();
    const { pki, cred } = useSecret(OTHER_SECRET);
    const { result, warned } = await captureWarnings(() => systemRestoreService.restoreFromBackup(dirname));

    // The restore still succeeds, and the rows are exactly what was backed up.
    expect(result.success).toBe(true);
    expect(await databaseService.sourcePkiKeys.getBySourceId(PKI_SOURCE)).toEqual(pkiRow);
    expect(await databaseService.meshcoreObserverCredentials.getBySourceId(CRED_SOURCE)).toEqual(credRow);

    // Each store reports the same thing it does for a rotated secret.
    expect(await pki.load(PKI_SOURCE)).toMatchObject({ kind: 'key_rotated' });
    expect(await pki.isKeyRotated(PKI_SOURCE)).toBe(true);
    expect(await cred.load(CRED_SOURCE)).toMatchObject({ kind: 'key_rotated' });
    expect((await cred.status(CRED_SOURCE)).keyRotated).toBe(true);

    expect(warned).toMatch(/1 PKI private key\(s\) that the current SESSION_SECRET cannot decrypt/);
    expect(warned).toContain(PKI_SOURCE);
    expect(warned).toMatch(/broker credentials for 1 source\(s\) that the current SESSION_SECRET cannot decrypt/);
    expect(warned).toContain(CRED_SOURCE);
    // Ids only: no key, no password, no secret, no ciphertext.
    for (const secret of [
      PRIVATE_KEY.toString('hex'),
      BROKER_PASSWORD,
      OTHER_SECRET,
      SECRET_AT_BACKUP,
      JSON.parse((pkiRow as { encryptedPrivateKey: string }).encryptedPrivateKey).ct,
    ]) {
      expect(warned).not.toContain(secret);
    }

    const audit = lastRestoreAudit();
    expect(audit.unreadablePkiKeys).toEqual([PKI_SOURCE]);
    expect(audit.unreadableObserverCredentials).toEqual([CRED_SOURCE]);
    expect(JSON.stringify(audit)).not.toContain(BROKER_PASSWORD);
  });

  it('putting the original secret back makes the kept rows usable again', async () => {
    wipe();
    useSecret(OTHER_SECRET);
    await systemRestoreService.restoreFromBackup(dirname);

    const { pki, cred } = useSecret(SECRET_AT_BACKUP);
    expect(await pki.load(PKI_SOURCE)).toEqual({ kind: 'ok', privateKey: PRIVATE_KEY });
    expect(await pki.isKeyRotated(PKI_SOURCE)).toBe(false);
    expect(await cred.load(CRED_SOURCE)).toMatchObject({ kind: 'ok', password: BROKER_PASSWORD });
  });
});

describe('restoring a backup made before this change (28 tables, 1.0 format)', () => {
  const dirname = 'older-backup';
  let backedUpNodes: SeedRow[];

  beforeAll(async () => {
    wipe();
    await seedTables(adapter, BACKUP_TABLES, 2);
    backedUpNodes = allRows('nodes');

    // Written the way 4.15 wrote it: the old table list, each file the whole
    // array pretty-printed.
    fs.mkdirSync(path.join(env.dir, dirname), { recursive: true });
    const checksums: Record<string, string> = {};
    for (const table of TABLES_BEFORE) {
      const json = JSON.stringify(table === 'coverage_receptions' ? [] : allRows(table), null, 2);
      fs.writeFileSync(backupFile(dirname, `${table}.json`), json, 'utf8');
      checksums[table] = sha256(json);
    }
    fs.writeFileSync(
      backupFile(dirname, 'metadata.json'),
      JSON.stringify({
        backupVersion: '1.0',
        meshmonitorVersion: '4.15.0',
        timestamp: new Date().toISOString(),
        timestampUnix: Date.now(),
        schemaVersion: 21,
        tables: TABLES_BEFORE,
        tableCount: TABLES_BEFORE.length,
        checksums,
      }, null, 2),
    );

    // Life goes on after the backup.
    db().prepare('DELETE FROM nodes').run();
    await seedTables(adapter, ['meshcore_nodes', 'automations', 'mesh_issues'], 1, 60);
  });

  it('validates and restores', async () => {
    expect(await systemBackupService.validateBackup(dirname)).toEqual({ valid: true, errors: [] });
    const result = await systemRestoreService.restoreFromBackup(dirname);
    expect(result).toMatchObject({ success: true, tablesRestored: TABLES_BEFORE.length });
  });

  it('brings back the tables the backup has', () => {
    expect(allRows('nodes')).toEqual(backedUpNodes);
  });

  it('leaves a table the backup does not have exactly as it was', () => {
    // Not emptied, not merged: the two rows from before the backup and the one
    // added after it are all still there.
    expect(count('meshcore_nodes')).toBe(3);
    expect(count('automations')).toBe(3);
    expect(count('mesh_issues')).toBe(3);
  });

  it('except children of `sources` and `users`, which the database clears when their parents are replaced', () => {
    // Restore clears `sources` and `users` before refilling them. Tables with
    // an ON DELETE CASCADE foreign key to either lose their rows at that
    // moment, and an older backup has nothing to put back. This is what
    // restore has always done to these tables; a backup made now holds them.
    for (const table of ['waypoints', 'ignored_nodes', 'meshcore_ignored_nodes', 'meshcore_message_filters']) {
      expect(count(table), table).toBe(0);
    }
    for (const table of ['api_tokens', 'user_map_preferences', 'channel_database_permissions']) {
      expect(count(table), table).toBe(0);
    }
  });
});

describe('restoring a backup that lacks a column the schema now has', () => {
  it('fills the missing column with its default', async () => {
    wipe();
    await seedTables(adapter, ['sources', 'meshcore_nodes'], 3);
    const dirname = await systemBackupService.createBackup('manual');

    // An older install's meshcore_nodes had no room-sync columns.
    const olderRows = readTable(dirname, 'meshcore_nodes').map((row) => {
      const { roomSyncIntervalMinutes: _a, roomSyncEnabled: _b, ...rest } = row;
      return rest;
    });
    expect(olderRows[0]).not.toHaveProperty('roomSyncIntervalMinutes');
    writeTable(dirname, 'meshcore_nodes', JSON.stringify(olderRows));

    wipe();
    const result = await systemRestoreService.restoreFromBackup(dirname);
    expect(result.success).toBe(true);

    const restored = allRows('meshcore_nodes');
    expect(restored).toHaveLength(3);
    for (const row of restored) {
      expect(row.roomSyncIntervalMinutes).toBe(60);
      expect(row.roomSyncEnabled).toBe(0);
      expect(row.publicKey).toMatch(/^t\d$/);
    }
  });
});

describe('a crafted metadata.json naming tables outside the allowlist (SQLite)', () => {
  const INJECTION = 'nodes; DROP TABLE users; --';
  let dirname: string;

  beforeAll(async () => {
    wipe();
    await seedTables(adapter, ['sources', 'users', 'nodes'], 2);
    const made = await systemBackupService.createBackup('manual');
    dirname = 'crafted-backup';
    copyBackup(made, dirname);

    const metadata = readMetadata(dirname);
    metadata.tables = ['nodes', 'sessions', 'sqlite_master', INJECTION, 'push_subscriptions', '../outside'];
    fs.writeFileSync(backupFile(dirname, 'metadata.json'), JSON.stringify(metadata));
    // Give every hostile name a table file with a valid checksum, so nothing
    // but the allowlist stands between it and the database.
    writeTable(dirname, 'sessions', JSON.stringify([{ sid: 'stolen', sess: '{}', expire: 9_999_999_999_999 }]));
    writeTable(dirname, 'push_subscriptions', JSON.stringify([{ id: 1 }]));
    writeTable(dirname, INJECTION, '[]');
    writeTable(dirname, 'sqlite_master', '[]');
  });

  it('restores the allowlisted table and skips the rest with a warning', async () => {
    db().prepare("INSERT INTO sessions (sid, sess, expire) VALUES ('live-session', '{}', 9999999999999)").run();
    db().prepare('DELETE FROM nodes').run();

    const { result, warned } = await captureWarnings(() => systemRestoreService.restoreFromBackup(dirname));

    expect(result).toMatchObject({ success: true, tablesRestored: 1, rowsRestored: 2 });
    expect(count('nodes')).toBe(2);
    for (const name of ['sessions', 'sqlite_master', INJECTION, 'push_subscriptions', '../outside']) {
      expect(warned).toContain(`Skipping table not in backup allowlist: ${name}`);
    }
  });

  it('never touched the excluded table or ran the injected statement', () => {
    expect((allRows('sessions') as Array<{ sid: string }>).map((r) => r.sid)).toEqual(['live-session']);
    // `users` still exists, with its rows.
    expect(count('users')).toBe(2);
    db().prepare("DELETE FROM sessions WHERE sid = 'live-session'").run();
  });

  it('rejects a column name that is not a plain identifier, and rolls back', async () => {
    const bad = 'crafted-column';
    copyBackup(dirname, bad);
    const metadata = readMetadata(bad);
    metadata.tables = ['nodes'];
    fs.writeFileSync(backupFile(bad, 'metadata.json'), JSON.stringify(metadata));
    const rows = readTable(bad, 'nodes');
    writeTable(bad, 'nodes', JSON.stringify(rows.map((r) => ({ ...r, 'nodeId) VALUES (1); DROP TABLE users; --': 1 }))));

    const before = allRows('nodes');
    const result = await systemRestoreService.restoreFromBackup(bad);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Invalid column name in backup for table nodes/);
    expect(allRows('nodes')).toEqual(before);
    expect(count('users')).toBe(2);
  });
});

describe('restore is all-or-nothing', () => {
  it('a failure in the last table leaves every earlier table as it was', async () => {
    wipe();
    await seedTables(adapter, BACKUP_TABLES, 2);
    const made = await systemBackupService.createBackup('manual');
    const dirname = 'broken-last-table';
    copyBackup(made, dirname);

    // The last table restored gets a row the schema cannot take.
    const last = BACKUP_TABLES[BACKUP_TABLES.length - 1];
    writeTable(dirname, last, JSON.stringify([{ no_such_column_in_this_table: 1 }]));
    expect((await systemBackupService.validateBackup(dirname)).valid).toBe(true);

    // The live database has moved on since the backup.
    wipe();
    await seedTables(adapter, BACKUP_TABLES, 1, 80);
    const before = Object.fromEntries(BACKUP_TABLES.filter((t) => t !== 'audit_log').map((t) => [t, allRows(t)]));

    const result = await systemRestoreService.restoreFromBackup(dirname);
    expect(result.success).toBe(false);

    for (const table of Object.keys(before)) {
      expect(allRows(table), table).toEqual(before[table]);
    }
  });
});

describe('export is batched, not loaded whole', () => {
  it('backs up and restores a table several batches long', async () => {
    wipe();
    const ROWS = 5200; // BACKUP_BATCH_ROWS is 2000
    await seedTables(adapter, ['sources'], 1);
    db().exec('BEGIN');
    await seedTables(adapter, ['meshcore_packet_log'], ROWS);
    db().exec('COMMIT');
    const before = allRows('meshcore_packet_log');
    expect(before).toHaveLength(ROWS);

    const dirname = await systemBackupService.createBackup('manual');
    // One row per line, plus the brackets.
    const lines = fs.readFileSync(backupFile(dirname, 'meshcore_packet_log.json'), 'utf8').split('\n');
    expect(lines).toHaveLength(ROWS + 2);

    wipe();
    const result = await systemRestoreService.restoreFromBackup(dirname);
    expect(result.success).toBe(true);
    expect(allRows('meshcore_packet_log')).toEqual(before);
  });
});

describe('backup history', () => {
  it('lists the backups made and adds up their sizes', async () => {
    wipe();
    await systemBackupService.createBackup('manual');
    await new Promise((resolve) => setTimeout(resolve, 1100)); // directory names are per-second
    await systemBackupService.createBackup('automatic');

    const backups = await systemBackupService.listBackups();
    expect(backups.map((b) => b.type).sort()).toEqual(['automatic', 'manual']);
    expect(backups[0]).toMatchObject({ tableCount: BACKUP_TABLES.length });

    const stats = await systemBackupService.getBackupStats();
    expect(stats.count).toBe(backups.length);
    expect(stats.totalSize).toBe(backups.reduce((sum, b) => sum + b.size, 0));
    expect(stats.totalSize).toBeGreaterThan(0);
  });
});

describe('one backup at a time, and no half-written backup left behind', () => {
  it('refuses a second backup while one is running', async () => {
    wipe();
    const first = systemBackupService.createBackup('manual');
    await expect(systemBackupService.createBackup('automatic')).rejects.toThrow('A system backup is already running');
    await first;
    // The guard is released: the next one runs.
    await new Promise((resolve) => setTimeout(resolve, 1100)); // directory names are per-second
    await expect(systemBackupService.createBackup('manual')).resolves.toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}$/);
  });

  it('removes the directory of a backup that failed part-way', async () => {
    const before = new Set(fs.readdirSync(env.dir));
    // Hide a table that is exported late, so earlier files are already on disk.
    db().exec('ALTER TABLE news_cache RENAME TO news_cache_hidden');
    try {
      await expect(systemBackupService.createBackup('manual')).rejects.toThrow('Failed to create system backup');
    } finally {
      db().exec('ALTER TABLE news_cache_hidden RENAME TO news_cache');
    }
    expect(fs.readdirSync(env.dir).filter((name) => !before.has(name))).toEqual([]);
    // And the failure released the guard.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(systemBackupService.createBackup('manual')).resolves.toBeTruthy();
  });
});
