/**
 * Schema-drift tripwire (Task 1.6 / Phase 3.3 prerequisite).
 *
 * Compares the schema produced by two bootstrap paths:
 *
 *   Variant A ("bootstrap path") — the real production fresh-install path:
 *     DatabaseService constructor → createTables() + createIndexes() + migration loop.
 *     This is what every real deployment runs today.
 *
 *   Variant B ("replay path") — migration chain only:
 *     createTestDb() replays migration 001 baseline → 112 against :memory:.
 *     This is Phase 3.3's target (delete createTables/createIndexes).
 *
 * Phase 3.3 deletes createTables()/createIndexes() and makes the replay path the only
 * path.  Until then, this test proves A ≡ B modulo the documented allowlist and
 * enforces allowlist burn-down: new entries are rejected; stale entries are rejected.
 *
 * Raw sqlite_master reads live in a *.test.ts file and are therefore exempt from the
 * project's no-restricted-syntax (raw SQL) ESLint ban.
 */

import { afterAll, describe, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Variant A: must set DATABASE_PATH BEFORE importing the singleton ──────────
//
// vitest.config.ts sets env.DATABASE_PATH = ':memory:' which would be picked up
// by the singleton, but we need a temp file so we can open a second read-only
// connection to read sqlite_master after construction (a :memory: DB can't be
// re-opened by a second connection).  Override here at module top, before any
// dynamic import of the singleton.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshmonitor-schema-drift-'));
const tempDbFile = path.join(tempDir, 'bootstrap.db');
process.env.DATABASE_PATH = tempDbFile;

// ─── Variant B ────────────────────────────────────────────────────────────────
import { createTestDb, type TestDb } from '../server/test-helpers/testDb.js';
import { SCHEMA_DRIFT_ALLOWLIST, type DriftKind } from './schemaDrift.allowlist.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SchemaRow {
  type: string;
  name: string;
  sql: string | null;
}

interface OnlyInOne { key: string; sql: string; }
interface Mismatch  { key: string; sqlA: string; sqlB: string; }

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize a sqlite_master DDL string for comparison.
 *
 * Rules (per spec):
 *   1. Strip `IF NOT EXISTS` (case-insensitive).
 *   2. Collapse all whitespace runs to a single space.
 *   3. Remove spaces around `,`, `(`, `)`.
 *   4. Strip `"` and `` ` `` (SQLite quotes identifiers inconsistently).
 *   5. Lowercase.
 *   6. Trim.
 *
 * Column order is intentionally preserved — it is significant for catching
 * category-(3) drift (createTables column order vs ALTER TABLE ADD COLUMN order).
 */
function normalizeDdl(sql: string | null): string {
  if (!sql) return '';
  return sql
    .replace(/IF NOT EXISTS/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/["`]/g, '')
    .toLowerCase()
    .trim();
}

/** Collect all non-sqlite_% schema objects from a connection, keyed by `type:name`. */
function collectSchema(conn: Database.Database): Map<string, string> {
  const rows = conn.prepare(
    `SELECT type, name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`
  ).all() as SchemaRow[];
  return new Map(rows.map(r => [`${r.type}:${r.name}`, normalizeDdl(r.sql)]));
}

// ─── Test ─────────────────────────────────────────────────────────────────────

describe('schema bootstrap drift', () => {
  let testDbB: TestDb;
  let connA: Database.Database;

  afterAll(() => {
    try { connA?.close(); } catch { /* ignore */ }
    try { testDbB?.close(); } catch { /* ignore */ }
    try { fs.rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
    // Restore env to avoid polluting subsequent test files in the same fork
    process.env.DATABASE_PATH = ':memory:';
  });

  it('createTables()/createIndexes() and migration replay agree modulo the allowlist', { timeout: 30000 }, async () => {
    // ── Variant A: import the DatabaseService singleton ────────────────────
    // The dynamic import must happen INSIDE the test (not at module top) so that
    // process.env.DATABASE_PATH is already overridden when the module is first
    // evaluated.  Vitest per-file module isolation makes this reliable.
    const { default: _dbService } = await import('../services/database.js');

    // Open a second read-only connection to the same file to read sqlite_master.
    // (We can't reuse the singleton's internal connection because it is private.)
    connA = new Database(tempDbFile, { readonly: true });
    const mapA = collectSchema(connA);

    // ── Variant B: migration-replay-only path ──────────────────────────────
    testDbB = createTestDb();
    const mapB = collectSchema(testDbB.sqlite);

    // ── Diff ───────────────────────────────────────────────────────────────
    const onlyInBootstrap: OnlyInOne[] = [];
    const onlyInReplay: OnlyInOne[]    = [];
    const sqlMismatch: Mismatch[]      = [];

    for (const [key, sqlA] of mapA) {
      if (!mapB.has(key)) {
        onlyInBootstrap.push({ key, sql: sqlA });
      } else if (mapB.get(key) !== sqlA) {
        sqlMismatch.push({ key, sqlA, sqlB: mapB.get(key)! });
      }
    }
    for (const [key, sqlB] of mapB) {
      if (!mapA.has(key)) {
        onlyInReplay.push({ key, sql: sqlB });
      }
    }

    // ── Allowlist check ────────────────────────────────────────────────────
    // Build a set of allowlisted (key, kind) pairs for fast lookup.
    type AllowKey = `${string}::${DriftKind}`;
    const allowSet = new Set<AllowKey>(
      SCHEMA_DRIFT_ALLOWLIST.map(e => `${e.key}::${e.kind}` as AllowKey)
    );

    // Track which allowlist entries were "consumed" (i.e. actually found in the diff).
    const consumed = new Set<AllowKey>();

    // Unexpected divergences (not in allowlist) → failure.
    const unexpected: string[] = [];

    // Helper to check one divergence against the allowlist.
    function check(key: string, kind: DriftKind, label: string): void {
      const ak: AllowKey = `${key}::${kind}`;
      if (allowSet.has(ak)) {
        consumed.add(ak);
      } else {
        unexpected.push(label);
      }
    }

    for (const { key, sql } of onlyInBootstrap) {
      check(key, 'onlyInBootstrap',
        `  + ${key}  (in fresh-install/createTables path, MISSING from migration replay)\n` +
        `      DDL: ${sql}\n` +
        `      hint: add a migration creating this, or add to allowlist if intentional pre-Phase-3.3`
      );
    }
    for (const { key, sql } of onlyInReplay) {
      check(key, 'onlyInReplay',
        `  - ${key}  (in migration replay, MISSING from createTables path)\n` +
        `      DDL: ${sql}`
      );
    }
    for (const { key, sqlA, sqlB } of sqlMismatch) {
      check(key, 'sqlMismatch',
        `  ~ ${key}  (DDL differs)\n` +
        `      bootstrap: ${sqlA}\n` +
        `      replay:    ${sqlB}`
      );
    }

    // Stale allowlist entries (allowlisted but no longer divergent) → failure.
    const stale: string[] = [];
    for (const e of SCHEMA_DRIFT_ALLOWLIST) {
      const ak: AllowKey = `${e.key}::${e.kind}`;
      if (!consumed.has(ak)) {
        stale.push(
          `  ! ${e.key} was allowlisted (kind: ${e.kind}) but is no longer divergent` +
          ` — remove it from schemaDrift.allowlist.ts`
        );
      }
    }

    if (unexpected.length > 0 || stale.length > 0) {
      const lines: string[] = [
        'Schema bootstrap drift changed. createTables()/createIndexes() (src/services/database.ts)' +
        ' and the migration chain (src/server/migrations/) disagree.' +
        ' Reconcile, or update schemaDrift.allowlist.ts. See Task 1.6 / Phase 3.3.',
        '',
      ];
      if (unexpected.length > 0) {
        lines.push(`UNEXPECTED DIVERGENCES (${unexpected.length}):`, ...unexpected, '');
      }
      if (stale.length > 0) {
        lines.push(`STALE ALLOWLIST ENTRIES (${stale.length}):`, ...stale, '');
      }
      throw new Error(lines.join('\n'));
    }
  });
});
