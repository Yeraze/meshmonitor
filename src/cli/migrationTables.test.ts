/**
 * Regression tests for issue #3337: migrate-db.ts TABLE_ORDER drifted out of
 * sync with the schema — six 4.x tables were missing and a stale
 * `key_repair_state` entry remained.
 *
 * These tests enumerate every SQLite table defined in the Drizzle schema and
 * assert the migration CLI's table lists stay in sync with it. Adding a new
 * table to src/db/schema/ without registering it in TABLE_ORDER (or
 * deliberately excluding it via SKIP_TABLES) fails here.
 */
import { describe, it, expect } from 'vitest';
import { is, getTableName } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schemaIndex from '../db/schema/index.js';
import * as sourcesSchema from '../db/schema/sources.js';
import { TABLE_ORDER, SOURCE_SCOPED_TABLES, SKIP_TABLES } from './migrationTables.js';

// sources.ts is not re-exported from the schema index, so merge it in.
const schemaTableNames = new Set(
  Object.values({ ...schemaIndex, ...sourcesSchema })
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => getTableName(table))
);

// Tables in SKIP_TABLES that are not Drizzle schema tables by design.
const NON_SCHEMA_SKIPS = new Set(['sqlite_sequence']);

describe('migrate-db table lists stay in sync with the Drizzle schema', () => {
  it('covers every schema table in TABLE_ORDER or SKIP_TABLES (no reliance on the implicit fallback)', () => {
    const uncovered = [...schemaTableNames].filter(
      (table) => !TABLE_ORDER.includes(table) && !SKIP_TABLES.has(table)
    );
    expect(uncovered, 'add new schema tables to TABLE_ORDER (or SKIP_TABLES) in src/cli/migrationTables.ts').toEqual([]);
  });

  it('has no stale TABLE_ORDER entries that reference nonexistent tables', () => {
    const stale = TABLE_ORDER.filter((table) => !schemaTableNames.has(table));
    expect(stale, 'remove TABLE_ORDER entries for tables no longer in src/db/schema/').toEqual([]);
  });

  it('has no stale SOURCE_SCOPED_TABLES entries', () => {
    const stale = [...SOURCE_SCOPED_TABLES].filter((table) => !schemaTableNames.has(table));
    expect(stale).toEqual([]);
  });

  it('has no stale SKIP_TABLES entries (besides SQLite internals)', () => {
    const stale = [...SKIP_TABLES].filter(
      (table) => !schemaTableNames.has(table) && !NON_SCHEMA_SKIPS.has(table)
    );
    expect(stale).toEqual([]);
  });

  it('has no duplicate TABLE_ORDER entries', () => {
    expect(new Set(TABLE_ORDER).size).toBe(TABLE_ORDER.length);
  });

  it('migrates sources first so sourceId backfill targets exist', () => {
    expect(TABLE_ORDER[0]).toBe('sources');
  });

  it('migrates FK parents before their dependents', () => {
    const order = (table: string) => TABLE_ORDER.indexOf(table);
    // meshcore_nodes before its dependent tables
    expect(order('meshcore_nodes')).toBeLessThan(order('meshcore_messages'));
    expect(order('meshcore_nodes')).toBeLessThan(order('meshcore_neighbor_info'));
    expect(order('meshcore_nodes')).toBeLessThan(order('meshcore_packet_log'));
    // users before tables that FK to users
    expect(order('users')).toBeLessThan(order('channel_database'));
    expect(order('users')).toBeLessThan(order('user_news_status'));
  });
});
