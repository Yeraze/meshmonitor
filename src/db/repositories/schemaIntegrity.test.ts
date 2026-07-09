/**
 * Schema Integrity Smoke Test
 *
 * Verifies that all critical columns and tables exist after PURE MIGRATION
 * REPLAY: every registered migration's .sqlite() function is run in order
 * against a fresh in-memory database (migration 001 is the v3.7 baseline that
 * creates all base tables). This is exactly the schema-bootstrap path that
 * Phase 3.3 (#3962) converges production fresh installs onto.
 *
 * This catches:
 * - Migration ordering bugs (PR #2301: migrations 083/084 skipped due to early return in 082)
 * - Missing columns from ALTER TABLE migrations
 * - Missing tables from CREATE TABLE migrations
 *
 * History: this file previously embedded its own replica of createTables()'
 * DDL and ran it before the migration loop. That third copy of the DDL went
 * stale (its route_segments block predated the distanceKm rework), which made
 * migration 001's correct CREATE TABLE IF NOT EXISTS a no-op and broke any
 * later migration referencing the newer columns (bit by migration 113). Pure
 * replay removes the divergent copy entirely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { registry } from '../migrations.js';

describe('Schema integrity after all migrations', () => {
  let db: Database.Database;

  // Helper: get column names for a table
  const getColumns = (table: string): string[] => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.map((c: any) => c.name);
  };

  // Helper: get all table names
  const getTableNames = (): string[] => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all();
    return tables.map((t: any) => t.name);
  };

  // Helper: getSetting / setSetting for migration idempotency tracking.
  // Defensive try/catch for the brief window before migration 001 creates
  // the settings table (same pattern as createTestDb / the production loop).
  const getSetting = (key: string): string | null => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  };

  const setSetting = (key: string, value: string): void => {
    try {
      const now = Date.now();
      db.prepare(
        'INSERT OR REPLACE INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)'
      ).run(key, value, now, now);
    } catch {
      /* settings table not created yet — ignore */
    }
  };

  beforeAll(() => {
    db = new Database(':memory:');

    // Pure migration replay: run every registered migration's .sqlite() in
    // order. Migration 001 (v3.7 baseline, selfIdempotent) creates all base
    // tables; subsequent migrations ALTER/CREATE from there. No embedded DDL —
    // this is the exact bootstrap path production fresh installs converge on
    // in Phase 3.3 (#3962), and the same loop createTestDb() uses.
    for (const migration of registry.getAll()) {
      if (!migration.sqlite) continue;
      migration.sqlite(db, getSetting, setSetting);
      if (migration.settingsKey) setSetting(migration.settingsKey, 'completed');
    }
  });

  afterAll(() => {
    db.close();
  });

  describe('columns that had BIGINT bugs (#1967, #1973)', () => {
    it('messages table has relayNode column', () => {
      expect(getColumns('messages')).toContain('relayNode');
    });

    it('messages table has ackFromNode column', () => {
      expect(getColumns('messages')).toContain('ackFromNode');
    });

    it('telemetry table has packetId column', () => {
      expect(getColumns('telemetry')).toContain('packetId');
    });
  });

  describe('columns from migrations 083/084 (skipped by PR #2301 bug)', () => {
    it('nodes table has lastMeshReceivedKey column', () => {
      expect(getColumns('nodes')).toContain('lastMeshReceivedKey');
    });

    it('nodes table has keyMismatchDetected column', () => {
      expect(getColumns('nodes')).toContain('keyMismatchDetected');
    });
  });

  describe('tables created by later migrations', () => {
    it('auto_key_repair_log table exists (migration 046)', () => {
      expect(getTableNames()).toContain('auto_key_repair_log');
    });

    it('auto_key_repair_state table exists (migration 046)', () => {
      expect(getTableNames()).toContain('auto_key_repair_state');
    });

    it('auto_distance_delete_log table exists (migration 086)', () => {
      expect(getTableNames()).toContain('auto_distance_delete_log');
    });

    it('ignored_nodes table exists (migration 066)', () => {
      expect(getTableNames()).toContain('ignored_nodes');
    });
  });

  describe('core tables exist', () => {
    it('all core tables are present', () => {
      const tables = getTableNames();
      const coreTables = [
        'nodes',
        'messages',
        'channels',
        'telemetry',
        'traceroutes',
        'settings',
        'neighbor_info',
      ];
      for (const table of coreTables) {
        expect(tables, `Missing core table: ${table}`).toContain(table);
      }
    });
  });

  describe('key node columns exist', () => {
    it('nodes table has all security-related columns', () => {
      const cols = getColumns('nodes');
      const securityColumns = [
        'publicKey',
        'lastMeshReceivedKey',
        'hasPKC',
        'lastPKIPacket',
        'keyIsLowEntropy',
        'duplicateKeyDetected',
        'keyMismatchDetected',
        'keySecurityIssueDetails',
      ];
      for (const col of securityColumns) {
        expect(cols, `Missing security column: ${col}`).toContain(col);
      }
    });

    it('nodes table has spam detection columns', () => {
      const cols = getColumns('nodes');
      expect(cols).toContain('isExcessivePackets');
      expect(cols).toContain('packetRatePerHour');
    });

    it('nodes table has favorite/ignored columns', () => {
      const cols = getColumns('nodes');
      expect(cols).toContain('isFavorite');
      expect(cols).toContain('favoriteLocked');
      expect(cols).toContain('isIgnored');
    });
  });

  describe('migration count sanity check', () => {
    it('registry has the expected number of migrations', () => {
      // After migration consolidation (v3.7 baseline), old 001-077 were replaced
      // by a single baseline migration. Update this number when adding new migrations.
      expect(registry.count()).toBeGreaterThanOrEqual(11);
    });
  });
});
