/**
 * Migration 155 tests — clear stale keyMismatchDetected flags left by the
 * source-blind read bug in `meshtasticManager.ts`.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration155Postgres, runMigration155Mysql } from './155_clear_stale_key_mismatch.js';

function bootstrapNodesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      publicKey TEXT,
      lastMeshReceivedKey TEXT,
      keyIsLowEntropy INTEGER,
      duplicateKeyDetected INTEGER,
      keyMismatchDetected INTEGER,
      keySecurityIssueDetails TEXT,
      PRIMARY KEY (nodeNum, sourceId)
    )
  `);
}

function insertNode(
  db: Database.Database,
  row: {
    nodeNum: number;
    sourceId: string;
    publicKey?: string | null;
    lastMeshReceivedKey?: string | null;
    keyIsLowEntropy?: 0 | 1;
    duplicateKeyDetected?: 0 | 1;
    keyMismatchDetected?: 0 | 1;
    keySecurityIssueDetails?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO nodes
      (nodeNum, sourceId, publicKey, lastMeshReceivedKey,
       keyIsLowEntropy, duplicateKeyDetected, keyMismatchDetected,
       keySecurityIssueDetails)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.nodeNum,
    row.sourceId,
    row.publicKey ?? null,
    row.lastMeshReceivedKey ?? null,
    row.keyIsLowEntropy ?? 0,
    row.duplicateKeyDetected ?? 0,
    row.keyMismatchDetected ?? 0,
    row.keySecurityIssueDetails ?? null,
  );
}

describe('Migration 155 — clear stale keyMismatchDetected flags', () => {
  describe('SQLite', () => {
    it('clears the flag on PKI-error rows (lastMeshReceivedKey NULL) and their details string', () => {
      const db = new Database(':memory:');
      bootstrapNodesTable(db);
      insertNode(db, {
        nodeNum: 100,
        sourceId: 'tcp-source',
        publicKey: 'AAA',
        lastMeshReceivedKey: null,
        keyMismatchDetected: 1,
        keySecurityIssueDetails: 'PKI encryption failed — advisory',
      });

      migration.up(db);

      const row = db.prepare(`SELECT * FROM nodes WHERE nodeNum = 100`).get() as any;
      expect(row.keyMismatchDetected).toBe(0);
      expect(row.keySecurityIssueDetails).toBeNull();
      db.close();
    });

    it('leaves NodeInfo-mismatch rows alone (lastMeshReceivedKey non-null is real evidence)', () => {
      const db = new Database(':memory:');
      bootstrapNodesTable(db);
      insertNode(db, {
        nodeNum: 200,
        sourceId: 'tcp-source',
        publicKey: 'OLD',
        lastMeshReceivedKey: 'NEW',
        keyMismatchDetected: 1,
        keySecurityIssueDetails: 'Key mismatch: node broadcast key NEW... but device has OLD...',
      });

      migration.up(db);

      const row = db.prepare(`SELECT * FROM nodes WHERE nodeNum = 200`).get() as any;
      expect(row.keyMismatchDetected).toBe(1);
      expect(row.keySecurityIssueDetails).toContain('Key mismatch');
      db.close();
    });

    it('preserves details when the row also carries a low-entropy or duplicate flag', () => {
      const db = new Database(':memory:');
      bootstrapNodesTable(db);
      insertNode(db, {
        nodeNum: 300,
        sourceId: 'tcp-source',
        publicKey: 'LOWENT',
        lastMeshReceivedKey: null,
        keyMismatchDetected: 1,
        keyIsLowEntropy: 1,
        keySecurityIssueDetails: 'Known low-entropy key detected',
      });
      insertNode(db, {
        nodeNum: 301,
        sourceId: 'tcp-source',
        publicKey: 'DUPKEY',
        lastMeshReceivedKey: null,
        keyMismatchDetected: 1,
        duplicateKeyDetected: 1,
        keySecurityIssueDetails: 'Key shared with nodes: 999',
      });

      migration.up(db);

      const lowE = db.prepare(`SELECT * FROM nodes WHERE nodeNum = 300`).get() as any;
      expect(lowE.keyMismatchDetected).toBe(0);
      expect(lowE.keySecurityIssueDetails).toBe('Known low-entropy key detected');

      const dup = db.prepare(`SELECT * FROM nodes WHERE nodeNum = 301`).get() as any;
      expect(dup.keyMismatchDetected).toBe(0);
      expect(dup.keySecurityIssueDetails).toBe('Key shared with nodes: 999');
      db.close();
    });

    it('touches only rows with keyMismatchDetected = 1', () => {
      const db = new Database(':memory:');
      bootstrapNodesTable(db);
      insertNode(db, {
        nodeNum: 400,
        sourceId: 'tcp-source',
        publicKey: 'X',
        lastMeshReceivedKey: null,
        keyMismatchDetected: 0,
        keySecurityIssueDetails: 'unrelated',
      });

      migration.up(db);

      const row = db.prepare(`SELECT * FROM nodes WHERE nodeNum = 400`).get() as any;
      expect(row.keySecurityIssueDetails).toBe('unrelated');
      db.close();
    });

    it('is idempotent — a second run clears nothing new', () => {
      const db = new Database(':memory:');
      bootstrapNodesTable(db);
      insertNode(db, {
        nodeNum: 500,
        sourceId: 'tcp-source',
        publicKey: 'K',
        lastMeshReceivedKey: null,
        keyMismatchDetected: 1,
        keySecurityIssueDetails: 'advisory',
      });

      migration.up(db);
      const afterFirst = db.prepare(`SELECT keyMismatchDetected, keySecurityIssueDetails FROM nodes WHERE nodeNum = 500`).get();
      expect(() => migration.up(db)).not.toThrow();
      const afterSecond = db.prepare(`SELECT keyMismatchDetected, keySecurityIssueDetails FROM nodes WHERE nodeNum = 500`).get();
      expect(afterSecond).toEqual(afterFirst);
      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('runs an UPDATE scoped to PKI-error rows', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rowCount: 42 }) };
      await runMigration155Postgres(client as any);

      const sql = client.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/UPDATE nodes/);
      expect(sql).toMatch(/"keyMismatchDetected" = FALSE/);
      expect(sql).toMatch(/"lastMeshReceivedKey" IS NULL/);
      expect(sql).toMatch(/"keyIsLowEntropy" = TRUE OR "duplicateKeyDetected" = TRUE/);
    });
  });

  describe('MySQL', () => {
    it('runs an UPDATE scoped to PKI-error rows', async () => {
      const pool = { query: vi.fn().mockResolvedValue([{ affectedRows: 17 }, []]) };
      await runMigration155Mysql(pool as any);

      const sql = pool.query.mock.calls.map((c: any[]) => String(c[0])).join('\n');
      expect(sql).toMatch(/UPDATE nodes/);
      expect(sql).toMatch(/keyMismatchDetected = 0/);
      expect(sql).toMatch(/lastMeshReceivedKey IS NULL/);
      expect(sql).toMatch(/keyIsLowEntropy = 1 OR duplicateKeyDetected = 1/);
    });
  });
});
