/**
 * Migration 154 tests — mesh_issues table creation (Mesh Issues Analysis
 * epic #4964, Phase 1 WP1).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration154Postgres, runMigration154Mysql } from './154_create_mesh_issues.js';

const COLUMNS = [
  'id', 'issueType', 'subjectKey', 'nodeNum', 'severity', 'confidence',
  'evidence', 'sourceIds', 'firstDetected', 'lastDetected', 'cleanRuns',
  'status', 'closedAt', 'dismissed', 'dismissedAt', 'dismissedBy',
  'createdAt', 'updatedAt',
];

describe('Migration 154 — mesh_issues', () => {
  describe('SQLite', () => {
    it('creates the table with all 18 columns and indexes, and is idempotent', () => {
      const db = new Database(':memory:');
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'mesh_issues'`
      ).get();
      expect(table).toBeTruthy();

      const columnRows = db.prepare(`PRAGMA table_info(mesh_issues)`).all() as { name: string }[];
      const columnNames = columnRows.map((c) => c.name);
      expect(columnNames.sort()).toEqual([...COLUMNS].sort());
      expect(columnNames).toHaveLength(18);

      const uniqueIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'mesh_issues_type_subject_uniq'`
      ).get();
      expect(uniqueIdx).toBeTruthy();

      const statusIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'mesh_issues_status_idx'`
      ).get();
      expect(statusIdx).toBeTruthy();

      const nodeIdx = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'mesh_issues_node_idx'`
      ).get();
      expect(nodeIdx).toBeTruthy();
      db.close();
    });

    it('round-trips a row with defaults applied', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const now = Date.now();
      const insert = db.prepare(`
        INSERT INTO mesh_issues
          (issueType, subjectKey, nodeNum, severity, confidence, evidence, sourceIds,
           firstDetected, lastDetected, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('A1_deprecated_role', 'node:123', 123, 'warning', 'high', '{}', '[]', now, now, now, now);

      const row = db.prepare(`SELECT * FROM mesh_issues WHERE subjectKey = ?`).get('node:123') as any;
      expect(row.status).toBe('open');
      expect(row.cleanRuns).toBe(0);
      expect(row.dismissed).toBe(0);
      expect(row.closedAt).toBeNull();
      expect(row.dismissedAt).toBeNull();
      expect(row.dismissedBy).toBeNull();
      db.close();
    });

    it('allows a null nodeNum for an area finding', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const now = Date.now();
      db.prepare(`
        INSERT INTO mesh_issues
          (issueType, subjectKey, nodeNum, severity, confidence, evidence, sourceIds,
           firstDetected, lastDetected, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('A2b_congested_area', 'area:700:-1220', null, 'warning', 'medium', '{}', '[]', now, now, now, now);

      const row = db.prepare(`SELECT * FROM mesh_issues WHERE subjectKey = ?`).get('area:700:-1220') as any;
      expect(row.nodeNum).toBeNull();
      db.close();
    });

    it('enforces the unique constraint on (issueType, subjectKey)', () => {
      const db = new Database(':memory:');
      migration.up(db);
      const now = Date.now();
      const insert = db.prepare(`
        INSERT INTO mesh_issues
          (issueType, subjectKey, nodeNum, severity, confidence, evidence, sourceIds,
           firstDetected, lastDetected, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('A1_deprecated_role', 'node:123', 123, 'warning', 'high', '{}', '[]', now, now, now, now);
      expect(() =>
        insert.run('A1_deprecated_role', 'node:123', 123, 'warning', 'high', '{}', '[]', now, now, now, now),
      ).toThrow();
    });

    it('down drops the table', () => {
      const db = new Database(':memory:');
      migration.up(db);
      migration.down(db);
      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'mesh_issues'`
      ).get();
      expect(table).toBeFalsy();
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table with expected columns and indexes', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined) };
      await runMigration154Postgres(client as any);
      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/mesh_issues/);
      expect(sql).toMatch(/mesh_issues_type_subject_uniq/);
      expect(sql).toMatch(/mesh_issues_status_idx/);
      expect(sql).toMatch(/mesh_issues_node_idx/);
      expect(sql).toMatch(/"issueType" TEXT NOT NULL/);
      expect(sql).toMatch(/"subjectKey" TEXT NOT NULL/);
      expect(sql).toMatch(/"nodeNum" BIGINT/);
      expect(sql).toMatch(/"firstDetected" BIGINT NOT NULL/);
      expect(sql).toMatch(/"lastDetected" BIGINT NOT NULL/);
      expect(sql).toMatch(/dismissed BOOLEAN NOT NULL DEFAULT FALSE/);
    });
  });

  describe('MySQL', () => {
    function makeConn(existRows: any[]) {
      return {
        query: vi.fn().mockResolvedValue([existRows, []]),
        release: vi.fn(),
      };
    }

    it('creates the table when missing', async () => {
      const absentConn = makeConn([]);
      const absentPool = { getConnection: vi.fn().mockResolvedValue(absentConn) };

      await runMigration154Mysql(absentPool as any);

      expect(absentConn.query).toHaveBeenCalled();
      const ddl = absentConn.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(ddl).toMatch(/CREATE TABLE mesh_issues/);
      expect(ddl).toMatch(/UNIQUE KEY mesh_issues_type_subject_uniq/);
      expect(ddl).toMatch(/INDEX mesh_issues_status_idx/);
      expect(ddl).toMatch(/INDEX mesh_issues_node_idx/);
      expect(ddl).toMatch(/issueType VARCHAR\(64\) NOT NULL/);
      expect(ddl).toMatch(/subjectKey VARCHAR\(128\) NOT NULL/);
      expect(absentConn.release).toHaveBeenCalled();
    });

    it('skips create when the table already exists', async () => {
      const presentConn = makeConn([{ TABLE_NAME: 'mesh_issues' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration154Mysql(presentPool as any);

      expect(presentConn.release).toHaveBeenCalled();
    });
  });
});
