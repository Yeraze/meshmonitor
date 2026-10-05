/**
 * The system-backup table lists cannot drift from the schema.
 *
 * THE RULE: every table in the database is either in BACKUP_TABLES or in
 * BACKUP_EXCLUDED_TABLES with a reason. Before this rule the backup was an
 * opt-in list of 28 tables, and by #5602's audit 52 tables had been added to
 * the schema without anyone adding them to it: a restore of a MeshCore-only
 * install brought back no nodes, no messages and no automations.
 *
 * A new table fails here until someone decides. The decision is:
 *
 *   - Back it up (the default). Put it in BACKUP_TABLES after any table it has
 *     a foreign key to. If it holds a key, credential or token, also list it
 *     in BACKUP_SECRET_TABLES with what protects the value.
 *   - Exclude it. That is a security decision, and it needs a security
 *     review: this file pins the exclusion list, so the change is visible.
 *
 * The exclusions exist because of MM-SEC-1 footnote 1: the realistic
 * exploitability of a leaked VAPID private key depends on the attacker also
 * getting each subscriber's `endpoint`/`p256dh`/`auth` from
 * `push_subscriptions`. Keeping that table (and live `sessions`) out of the
 * backup means a stolen backup cannot be used as a second-stage exploit.
 *
 * The table set and the foreign keys are read from the real schema: the Drizzle
 * definitions for all three backends, and a SQLite database built by replaying
 * every migration. The PostgreSQL and MySQL equivalents (built by the same
 * replay on real servers) are in systemBackupRestore.roundTrip.pgmysql.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { is, getTableName } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { PgTable } from 'drizzle-orm/pg-core';
import { MySqlTable } from 'drizzle-orm/mysql-core';
import * as schemaIndex from '../../db/schema/index.js';
import * as sourcesSchema from '../../db/schema/sources.js';
import { registry } from '../../db/migrations.js';
import {
  BACKUP_TABLES,
  BACKUP_EXCLUDED_TABLES,
  BACKUP_SECRET_TABLES,
  BACKUP_IDENTIFIER_PATTERN,
  planRestoreTables,
} from './systemBackupTables.js';
import { HOW_TO_FIX, classifyTables, misorderedForeignKeys } from './systemBackupTables.testHelpers.js';

// sources.ts is not re-exported from the schema index, so merge it in.
const schemaExports = Object.values({ ...schemaIndex, ...sourcesSchema });
const drizzleTables = {
  SQLite: schemaExports.filter((v): v is SQLiteTable => is(v, SQLiteTable)).map((t) => getTableName(t)),
  PostgreSQL: schemaExports.filter((v): v is PgTable => is(v, PgTable)).map((t) => getTableName(t)),
  MySQL: schemaExports.filter((v): v is MySqlTable => is(v, MySqlTable)).map((t) => getTableName(t)),
};

describe('every schema table is backed up or explicitly excluded', () => {
  for (const [backend, tables] of Object.entries(drizzleTables)) {
    it(`${backend} Drizzle schema: no unclassified table, no stale list entry`, () => {
      expect(tables.length).toBeGreaterThan(50);
      const result = classifyTables(tables);
      expect(result.unclassified, HOW_TO_FIX).toEqual([]);
      expect(result.staleBackup, 'BACKUP_TABLES names a table that is not in the schema').toEqual([]);
      expect(result.staleExcluded, 'BACKUP_EXCLUDED_TABLES names a table that is not in the schema').toEqual([]);
    });
  }

  it('the check itself catches a table nobody classified', () => {
    const result = classifyTables([...drizzleTables.SQLite, 'a_table_added_next_year']);
    expect(result.unclassified).toEqual(['a_table_added_next_year']);
  });

  it('no table is both backed up and excluded, and none is listed twice', () => {
    expect(new Set(BACKUP_TABLES).size).toBe(BACKUP_TABLES.length);
    expect(BACKUP_TABLES.filter((t) => t in BACKUP_EXCLUDED_TABLES)).toEqual([]);
  });

  it('every listed name is a plain SQL identifier (they are interpolated into SQL)', () => {
    for (const table of [...BACKUP_TABLES, ...Object.keys(BACKUP_EXCLUDED_TABLES)]) {
      expect(table).toMatch(BACKUP_IDENTIFIER_PATTERN);
    }
  });
});

describe('SQLite database built by replaying every migration', () => {
  let db: Database.Database;
  let tables: string[];

  beforeAll(() => {
    db = new Database(':memory:');
    const getSetting = (key: string): string | null => {
      try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value ?? null;
      } catch {
        return null;
      }
    };
    const setSetting = (key: string, value: string): void => {
      try {
        db.prepare('INSERT OR REPLACE INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)').run(
          key, value, Date.now(), Date.now(),
        );
      } catch {
        /* settings table not created yet */
      }
    };
    for (const migration of registry.getAll()) {
      if (!migration.sqlite) continue;
      migration.sqlite(db, getSetting, setSetting);
      if (migration.settingsKey) setSetting(migration.settingsKey, 'completed');
    }
    // `sqlite_sequence` and friends are SQLite's own bookkeeping, not data.
    tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
  });

  afterAll(() => db.close());

  it('has no table outside the two lists (catches a table created by a migration but missing from Drizzle)', () => {
    const result = classifyTables(tables);
    expect(result.unclassified, HOW_TO_FIX).toEqual([]);
    expect(result.staleBackup).toEqual([]);
    expect(result.staleExcluded).toEqual([]);
  });

  it('restores every foreign-key parent before its children', () => {
    const edges = tables.flatMap((child) =>
      (db.prepare(`PRAGMA foreign_key_list(${child})`).all() as Array<{ table: string }>).map((fk) => ({
        child,
        parent: fk.table,
      })),
    );
    // The schema has foreign keys; an empty list would mean the probe broke.
    expect(edges.length).toBeGreaterThan(10);
    expect(misorderedForeignKeys(edges), 'move the parent above the child in BACKUP_TABLES').toEqual([]);
  });

  it('the order check itself catches a child listed before its parent', () => {
    expect(misorderedForeignKeys([{ child: 'users', parent: 'permissions' }])).toEqual(['users -> permissions']);
    // A backed-up child whose parent is not backed up at all would restore
    // into a missing parent.
    expect(misorderedForeignKeys([{ child: 'permissions', parent: 'sessions' }])).toEqual(['permissions -> sessions']);
  });
  it('a column whose name says it holds a secret belongs to a table in BACKUP_SECRET_TABLES', () => {
    const secretish = /psk|password|secret|token|credential|private_?key/i;
    const undeclared = BACKUP_TABLES.filter((table) => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return columns.some((c) => secretish.test(c.name)) && !(table in BACKUP_SECRET_TABLES);
    });
    expect(
      undeclared,
      'a backed-up table has a secret-looking column: add it to BACKUP_SECRET_TABLES and say what protects it',
    ).toEqual([]);
  });
});

describe('the exclusion list is pinned (changing it needs a security review)', () => {
  it('excludes exactly sessions, push_subscriptions and backup_history', () => {
    expect(Object.keys(BACKUP_EXCLUDED_TABLES).sort()).toEqual(['backup_history', 'push_subscriptions', 'sessions']);
  });

  for (const table of ['push_subscriptions', 'sessions', 'backup_history']) {
    it(`MUST NOT back up "${table}" (see MM-SEC-1 footnote 1 / ARCHITECTURE_LESSONS.md)`, () => {
      expect(BACKUP_TABLES).not.toContain(table);
      expect(BACKUP_EXCLUDED_TABLES[table].length).toBeGreaterThan(20);
    });
  }
});

describe('tables that hold secrets are named, with what protects them', () => {
  it('every secret-bearing table is backed up and described', () => {
    for (const [table, info] of Object.entries(BACKUP_SECRET_TABLES)) {
      expect(BACKUP_TABLES, table).toContain(table);
      expect(info.protection.length, table).toBeGreaterThan(10);
    }
  });

  it('lists the tables whose secrets are sealed with SESSION_SECRET', () => {
    const sealed = Object.entries(BACKUP_SECRET_TABLES)
      .filter(([, info]) => info.sessionSecret)
      .map(([table]) => table)
      .sort();
    // Restore checks each of these for rows the current secret cannot open
    // (systemRestoreService.findUnreadableSecrets). Add a table here and there.
    expect(sealed).toEqual([
      'meshcore_nodes',
      'meshcore_observer_credentials',
      'meshcore_observer_keys',
      'source_pki_keys',
    ]);
  });
});

describe('BACKUP_TABLES content', () => {
  it('backs up at least one table from each group the 28-table list was missing', () => {
    for (const table of [
      // configuration and user state
      'channel_database', 'automations', 'custom_themes', 'waypoints', 'meshcore_saved_regions',
      // MeshCore and Reticulum data
      'meshcore_nodes', 'meshcore_messages', 'reticulum_destinations', 'reticulum_messages',
      // secrets
      'api_tokens', 'source_pki_keys', 'meshcore_observer_credentials',
      // history, logs, derived
      'message_events', 'mqtt_packet_log', 'meshcore_packet_log', 'automation_runs', 'mesh_issues',
    ]) {
      expect(BACKUP_TABLES).toContain(table);
    }
  });

  it('backs up stored translations, cache entries before the links into them (#5520)', () => {
    const cache = BACKUP_TABLES.indexOf('translation_cache');
    const links = BACKUP_TABLES.indexOf('message_translations');
    expect(cache).toBeGreaterThanOrEqual(0);
    expect(links).toBeGreaterThan(cache);
    expect(links).toBeGreaterThan(BACKUP_TABLES.indexOf('messages'));
  });

  it('backs up the Analyzer Observer signing keys (#5596)', () => {
    // Left out until #5596, so a restore silently lost every key. The rows are
    // AES-256-GCM envelopes keyed from SESSION_SECRET, so unlike the excluded
    // tables above a stolen backup alone does not expose them.
    expect(BACKUP_TABLES).toContain('meshcore_observer_keys');
  });

  it('starts with sources, then users: every foreign key leads to one of them', () => {
    expect(BACKUP_TABLES.slice(0, 2)).toEqual(['sources', 'users']);
  });
});

describe('planRestoreTables — the restore allowlist', () => {
  it('keeps allowlisted names and returns them in BACKUP_TABLES order, whatever order the backup lists', () => {
    const plan = planRestoreTables(['permissions', 'nodes', 'users', 'sources']);
    expect(plan).toEqual({ tables: ['sources', 'users', 'nodes', 'permissions'], skipped: [] });
  });

  it('skips unknown, excluded and injection-shaped names', () => {
    const hostile = [
      'nodes',
      'sessions',
      'push_subscriptions',
      'sqlite_master',
      'pg_authid',
      'nodes; DROP TABLE users; --',
      'users" WHERE 1=1; --',
      'nodes` ; DELETE FROM users; -- ',
      '../../../etc/passwd',
      'NODES',
      '',
    ];
    const plan = planRestoreTables(hostile);
    expect(plan.tables).toEqual(['nodes']);
    expect(plan.skipped).toEqual(hostile.filter((n) => n !== 'nodes'));
  });

  it('does not restore a table twice when the backup names it twice', () => {
    expect(planRestoreTables(['nodes', 'nodes', 'sources']).tables).toEqual(['sources', 'nodes']);
  });

  it('treats metadata that is not a list of strings as naming nothing', () => {
    expect(planRestoreTables(undefined)).toEqual({ tables: [], skipped: [] });
    expect(planRestoreTables('nodes')).toEqual({ tables: [], skipped: [] });
    expect(planRestoreTables([{ toString: () => 'nodes' }, 7, null]).tables).toEqual([]);
  });
});
