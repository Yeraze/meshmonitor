import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from './database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('DatabaseService - Auto Welcome Migration', () => {
  let dbService: DatabaseService;
  let testDbPath: string;

  beforeEach(() => {
    // Create a temporary database for testing
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshmonitor-test-'));
    testDbPath = path.join(tmpDir, 'test.db');

    // Override the DATABASE_PATH for testing
    process.env.DATABASE_PATH = testDbPath;

    dbService = new DatabaseService();
  });

  afterEach(() => {
    // Clean up
    if (dbService && dbService.db) {
      dbService.db.close();
    }

    if (testDbPath && fs.existsSync(testDbPath)) {
      const dbDir = path.dirname(testDbPath);
      fs.rmSync(dbDir, { recursive: true, force: true });
    }

    delete process.env.DATABASE_PATH;
  });

  describe('runAutoWelcomeMigration', () => {
    it('should mark existing nodes as welcomed on first run', () => {
      // Insert some test nodes without welcomedAt
      const insertStmt = dbService.db.prepare(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      const threeDaysAgo = now - (3 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

      insertStmt.run(111111, '!0001b207', 'Node One', 'ONE', 0, threeDaysAgo, now);
      insertStmt.run(222222, '!000363de', 'Node Two', 'TWO', 0, sevenDaysAgo, now);
      insertStmt.run(333333, '!000516f5', 'Node Three', 'THR', 0, now, now);

      // Verify nodes don't have welcomedAt
      const beforeStmt = dbService.db.prepare('SELECT nodeNum, welcomedAt FROM nodes WHERE welcomedAt IS NOT NULL');
      const beforeNodes = beforeStmt.all();
      expect(beforeNodes.length).toBe(0);

      // Run the migration manually (it already ran in constructor, but we inserted after)
      // We need to reset the migration flag first
      dbService.setSetting('migration_016_auto_welcome_existing_nodes', 'not_completed');
      (dbService as any).runAutoWelcomeMigration();

      // Verify all nodes now have welcomedAt (excluding broadcast node)
      const afterStmt = dbService.db.prepare('SELECT nodeNum, nodeId, welcomedAt, createdAt FROM nodes WHERE nodeNum != 4294967295 ORDER BY nodeNum');
      const afterNodes = afterStmt.all() as Array<{ nodeNum: number; nodeId: string; welcomedAt: number; createdAt: number }>;

      expect(afterNodes.length).toBe(3);

      // All nodes should have welcomedAt set
      expect(afterNodes[0].welcomedAt).toBeDefined();
      expect(afterNodes[1].welcomedAt).toBeDefined();
      expect(afterNodes[2].welcomedAt).toBeDefined();

      // welcomedAt should match createdAt (or close to it)
      expect(afterNodes[0].welcomedAt).toBe(threeDaysAgo);
      expect(afterNodes[1].welcomedAt).toBe(sevenDaysAgo);
      expect(afterNodes[2].welcomedAt).toBe(now);
    });

    it('should handle nodes with recent createdAt correctly', () => {
      // Insert a node with very recent createdAt
      const now = Date.now();
      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (444444, '!0006c9c0', 'Node Four', 'FOR', 0, ${now}, ${now})
      `);

      // Reset and run migration
      dbService.setSetting('migration_016_auto_welcome_existing_nodes', 'not_completed');
      (dbService as any).runAutoWelcomeMigration();

      const stmt = dbService.db.prepare('SELECT welcomedAt, createdAt FROM nodes WHERE nodeNum = ?');
      const node = stmt.get(444444) as { welcomedAt: number; createdAt: number };

      expect(node.welcomedAt).toBeDefined();
      expect(node.welcomedAt).toBe(node.createdAt); // Should use createdAt timestamp
    });

    it('should not run migration twice', () => {
      // Insert test nodes
      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (555555, '!00087a63', 'Node Five', 'FIV', 0, ${Date.now()}, ${Date.now()})
      `);

      // Run migration first time
      dbService.setSetting('migration_016_auto_welcome_existing_nodes', 'not_completed');
      (dbService as any).runAutoWelcomeMigration();

      // Get the welcomedAt value
      const firstRunStmt = dbService.db.prepare('SELECT welcomedAt FROM nodes WHERE nodeNum = ?');
      const firstRun = firstRunStmt.get(555555) as { welcomedAt: number };
      const firstWelcomedAt = firstRun.welcomedAt;

      // Wait a bit
      const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      // Try to run migration again (should be skipped)
      (dbService as any).runAutoWelcomeMigration();

      // Get the welcomedAt value again
      const secondRun = firstRunStmt.get(555555) as { welcomedAt: number };

      // Should be the same (migration didn't run again)
      expect(secondRun.welcomedAt).toBe(firstWelcomedAt);
    });

    it('should not affect nodes that already have welcomedAt', () => {
      const customWelcomedAt = Date.now() - (10 * 24 * 60 * 60 * 1000); // 10 days ago

      // Insert a node that already has welcomedAt
      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, welcomedAt, createdAt, updatedAt)
        VALUES (666666, '!000a2d26', 'Node Six', 'SIX', 0, ${customWelcomedAt}, ${Date.now()}, ${Date.now()})
      `);

      // Run migration
      dbService.setSetting('migration_016_auto_welcome_existing_nodes', 'not_completed');
      (dbService as any).runAutoWelcomeMigration();

      // Check that welcomedAt wasn't changed
      const stmt = dbService.db.prepare('SELECT welcomedAt FROM nodes WHERE nodeNum = ?');
      const node = stmt.get(666666) as { welcomedAt: number };

      expect(node.welcomedAt).toBe(customWelcomedAt);
    });

    it('should handle empty database gracefully', () => {
      // Ensure no nodes exist (except broadcast node which is created by default)
      dbService.db.exec('DELETE FROM nodes WHERE nodeNum != 4294967295');

      // Run migration
      dbService.setSetting('migration_016_auto_welcome_existing_nodes', 'not_completed');

      // Should not throw
      expect(() => {
        (dbService as any).runAutoWelcomeMigration();
      }).not.toThrow();

      // Migration should be marked as completed
      const migrationStatus = dbService.getSetting('migration_016_auto_welcome_existing_nodes');
      expect(migrationStatus).toBe('completed');
    });

    it('should mark migration as completed', () => {
      // Reset migration
      dbService.setSetting('migration_016_auto_welcome_existing_nodes', 'not_completed');

      // Run migration
      (dbService as any).runAutoWelcomeMigration();

      // Check it's marked as completed
      const migrationStatus = dbService.getSetting('migration_016_auto_welcome_existing_nodes');
      expect(migrationStatus).toBe('completed');
    });

    it('should handle large number of nodes efficiently', () => {
      // Insert 100 test nodes
      const insertStmt = dbService.db.prepare(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `);

      const now = Date.now();
      for (let i = 1000000; i < 1000100; i++) {
        const nodeId = `!${i.toString(16).padStart(8, '0')}`;
        insertStmt.run(i, nodeId, `Node ${i}`, `N${i}`, now, now);
      }

      // Run migration
      const startTime = Date.now();
      dbService.setSetting('migration_016_auto_welcome_existing_nodes', 'not_completed');
      (dbService as any).runAutoWelcomeMigration();
      const duration = Date.now() - startTime;

      // Verify all nodes were marked (excluding broadcast node)
      const stmt = dbService.db.prepare('SELECT COUNT(*) as count FROM nodes WHERE welcomedAt IS NOT NULL AND nodeNum >= 1000000 AND nodeNum != 4294967295');
      const result = stmt.get() as { count: number };
      expect(result.count).toBe(100);

      // Should complete reasonably quickly (under 1 second for 100 nodes)
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('welcomedAt column migration', () => {
    it('should have welcomedAt column in nodes table', () => {
      const stmt = dbService.db.prepare("PRAGMA table_info(nodes)");
      const columns = stmt.all() as Array<{ name: string; type: string }>;

      const welcomedAtColumn = columns.find(col => col.name === 'welcomedAt');
      expect(welcomedAtColumn).toBeDefined();
      expect(welcomedAtColumn?.type).toBe('INTEGER');
    });

    it('should allow NULL values for welcomedAt', () => {
      // Insert a node without welcomedAt
      const insertStmt = dbService.db.prepare(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      insertStmt.run(777777, '!000bdc89', 'Test Node', 'TEST', 0, now, now);

      // Verify welcomedAt is NULL
      const selectStmt = dbService.db.prepare('SELECT welcomedAt FROM nodes WHERE nodeNum = ?');
      const node = selectStmt.get(777777) as { welcomedAt: number | null };

      expect(node.welcomedAt).toBeNull();
    });

    it('should allow updating welcomedAt', () => {
      const now = Date.now();

      // Insert a node
      dbService.upsertNode({
        nodeNum: 888888,
        nodeId: '!000d8f4c',
        longName: 'Update Test',
        shortName: 'UPD'
      });

      // Update welcomedAt
      dbService.upsertNode({
        nodeNum: 888888,
        nodeId: '!000d8f4c',
        welcomedAt: now
      });

      // Verify update
      const stmt = dbService.db.prepare('SELECT welcomedAt FROM nodes WHERE nodeNum = ?');
      const node = stmt.get(888888) as { welcomedAt: number };

      expect(node.welcomedAt).toBe(now);
    });
  });
});
