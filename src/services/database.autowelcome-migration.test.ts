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

  describe('welcomedAt column migration', () => {
    it('should have welcomedAt column in nodes table', () => {
      const stmt = dbService.db.prepare('PRAGMA table_info(nodes)');
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
        shortName: 'UPD',
      });

      // Update welcomedAt
      dbService.upsertNode({
        nodeNum: 888888,
        nodeId: '!000d8f4c',
        welcomedAt: now,
      });

      // Verify update
      const stmt = dbService.db.prepare('SELECT welcomedAt FROM nodes WHERE nodeNum = ?');
      const node = stmt.get(888888) as { welcomedAt: number };

      expect(node.welcomedAt).toBe(now);
    });
  });

  describe('markAllNodesAsWelcomed', () => {
    it('should mark all nodes without welcomedAt', () => {
      // Insert some test nodes without welcomedAt
      const insertStmt = dbService.db.prepare(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      insertStmt.run(111111, '!0001b207', 'Node One', 'ONE', 0, now, now);
      insertStmt.run(222222, '!000363de', 'Node Two', 'TWO', 0, now, now);
      insertStmt.run(333333, '!000516f5', 'Node Three', 'THR', 0, now, now);

      // Verify nodes don't have welcomedAt (excluding broadcast node)
      const beforeStmt = dbService.db.prepare(
        'SELECT COUNT(*) as count FROM nodes WHERE welcomedAt IS NULL AND nodeNum IN (111111, 222222, 333333)'
      );
      const before = beforeStmt.get() as { count: number };
      expect(before.count).toBe(3);

      // Mark all nodes as welcomed
      const markedCount = dbService.markAllNodesAsWelcomed();
      // Should mark our 3 test nodes (broadcast node may or may not have welcomedAt already)
      expect(markedCount).toBeGreaterThanOrEqual(3);

      // Verify all our test nodes now have welcomedAt
      const afterStmt = dbService.db.prepare(
        'SELECT COUNT(*) as count FROM nodes WHERE welcomedAt IS NOT NULL AND nodeNum IN (111111, 222222, 333333)'
      );
      const after = afterStmt.get() as { count: number };
      expect(after.count).toBe(3);
    });

    it('should not modify nodes that already have welcomedAt', () => {
      const originalWelcomedAt = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago

      // Insert a node with welcomedAt already set
      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, welcomedAt, createdAt, updatedAt)
        VALUES (444444, '!0006c9c0', 'Node Four', 'FOR', 0, ${originalWelcomedAt}, ${Date.now()}, ${Date.now()})
      `);

      // Mark all nodes
      dbService.markAllNodesAsWelcomed();

      // Verify the original welcomedAt wasn't changed
      const stmt = dbService.db.prepare('SELECT welcomedAt FROM nodes WHERE nodeNum = ?');
      const node = stmt.get(444444) as { welcomedAt: number };
      expect(node.welcomedAt).toBe(originalWelcomedAt);
    });

    it('should return 0 when no nodes need to be marked', () => {
      // Mark all existing nodes first
      dbService.markAllNodesAsWelcomed();

      // Now calling again should return 0
      const markedCount = dbService.markAllNodesAsWelcomed();
      expect(markedCount).toBe(0);
    });

    it('should handle mixed scenarios correctly', () => {
      const now = Date.now();
      const oldWelcomedAt = now - 5 * 24 * 60 * 60 * 1000; // 5 days ago

      // Insert mix of nodes - some with welcomedAt, some without
      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, welcomedAt, createdAt, updatedAt)
        VALUES (555555, '!00087a63', 'Node Five', 'FIV', 0, ${oldWelcomedAt}, ${now}, ${now})
      `);

      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (666666, '!000a2d26', 'Node Six', 'SIX', 0, ${now}, ${now})
      `);

      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (777777, '!000bdc89', 'Node Seven', 'SEV', 0, ${now}, ${now})
      `);

      // Should only mark the 2 nodes without welcomedAt (666666 and 777777)
      const markedCount = dbService.markAllNodesAsWelcomed();
      expect(markedCount).toBeGreaterThanOrEqual(2);

      // Verify node 555555 kept its original timestamp
      const stmt1 = dbService.db.prepare('SELECT welcomedAt FROM nodes WHERE nodeNum = ?');
      const node1 = stmt1.get(555555) as { welcomedAt: number };
      expect(node1.welcomedAt).toBe(oldWelcomedAt);

      // Verify nodes 666666 and 777777 now have welcomedAt
      const node2 = stmt1.get(666666) as { welcomedAt: number };
      const node3 = stmt1.get(777777) as { welcomedAt: number };
      expect(node2.welcomedAt).toBeDefined();
      expect(node3.welcomedAt).toBeDefined();
    });
  });

  describe('markNodeAsWelcomedIfNotAlready', () => {
    it('should mark node as welcomed when not already welcomed', () => {
      const now = Date.now();

      // Insert a node without welcomedAt
      dbService.upsertNode({
        nodeNum: 123456,
        nodeId: '!0001e240',
        longName: 'Test Node',
        shortName: 'TEST',
      });

      // Mark the node as welcomed
      const wasMarked = dbService.markNodeAsWelcomedIfNotAlready(123456, '!0001e240');

      expect(wasMarked).toBe(true);

      // Verify the node has welcomedAt set
      const node = dbService.getNode(123456);
      expect(node?.welcomedAt).toBeDefined();
      expect(node?.welcomedAt).toBeGreaterThan(now - 1000);
    });

    it('should not mark node when already welcomed (atomic protection)', () => {
      const now = Date.now();

      // Insert a node with welcomedAt already set
      dbService.upsertNode({
        nodeNum: 234567,
        nodeId: '!000393e7',
        longName: 'Already Welcomed',
        shortName: 'WLCM',
        welcomedAt: now - 10000, // Welcomed 10 seconds ago
      });

      // Try to mark the node as welcomed again
      const wasMarked = dbService.markNodeAsWelcomedIfNotAlready(234567, '!000393e7');

      expect(wasMarked).toBe(false);

      // Verify the welcomedAt timestamp didn't change
      const node = dbService.getNode(234567);
      expect(node?.welcomedAt).toBe(now - 10000);
    });

    it('should provide race condition protection for concurrent operations', () => {
      // Insert a node without welcomedAt
      dbService.upsertNode({
        nodeNum: 345678,
        nodeId: '!00054686',
        longName: 'Concurrent Test',
        shortName: 'CONC',
      });

      // Simulate two processes trying to mark the node simultaneously
      const result1 = dbService.markNodeAsWelcomedIfNotAlready(345678, '!00054686');
      const result2 = dbService.markNodeAsWelcomedIfNotAlready(345678, '!00054686');

      // Only the first one should succeed
      expect(result1).toBe(true);
      expect(result2).toBe(false);

      // Node should be marked exactly once
      const node = dbService.getNode(345678);
      expect(node?.welcomedAt).toBeDefined();
    });

    it('should not mark node if nodeId does not match', () => {
      // Insert a node
      dbService.upsertNode({
        nodeNum: 456789,
        nodeId: '!0006f855',
        longName: 'ID Test',
        shortName: 'IDT',
      });

      // Try to mark with wrong nodeId
      const wasMarked = dbService.markNodeAsWelcomedIfNotAlready(456789, '!wrongid');

      expect(wasMarked).toBe(false);

      // Node should not be marked
      const node = dbService.getNode(456789);
      expect(node?.welcomedAt).toBeNull();
    });

    it('should return false for non-existent node', () => {
      // Try to mark a node that doesn't exist
      const wasMarked = dbService.markNodeAsWelcomedIfNotAlready(999999, '!000f423f');

      expect(wasMarked).toBe(false);
    });
  });

  describe('handleAutoWelcomeEnabled', () => {
    it('should mark all existing nodes as welcomed on first enable', () => {
      // Insert some test nodes without welcomedAt
      const insertStmt = dbService.db.prepare(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      insertStmt.run(111111, '!0001b207', 'Node One', 'ONE', 0, now, now);
      insertStmt.run(222222, '!000363de', 'Node Two', 'TWO', 0, now, now);
      insertStmt.run(333333, '!000516f5', 'Node Three', 'THR', 0, now, now);

      // Verify nodes don't have welcomedAt
      const beforeStmt = dbService.db.prepare(
        'SELECT COUNT(*) as count FROM nodes WHERE welcomedAt IS NULL AND nodeNum IN (111111, 222222, 333333)'
      );
      const before = beforeStmt.get() as { count: number };
      expect(before.count).toBe(3);

      // Simulate enabling auto-welcome for the first time
      const markedCount = dbService.handleAutoWelcomeEnabled();

      // Should have marked our 3 test nodes
      expect(markedCount).toBeGreaterThanOrEqual(3);

      // Verify all our test nodes now have welcomedAt
      const afterStmt = dbService.db.prepare(
        'SELECT COUNT(*) as count FROM nodes WHERE welcomedAt IS NOT NULL AND nodeNum IN (111111, 222222, 333333)'
      );
      const after = afterStmt.get() as { count: number };
      expect(after.count).toBe(3);

      // Migration flag should be set
      const migrationStatus = dbService.getSetting('auto_welcome_first_enabled');
      expect(migrationStatus).toBe('completed');
    });

    it('should not run twice (idempotent)', () => {
      // Insert test node
      const now = Date.now();
      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (444444, '!0006c9c0', 'Node Four', 'FOR', 0, ${now}, ${now})
      `);

      // Run first time
      const firstCount = dbService.handleAutoWelcomeEnabled();
      expect(firstCount).toBeGreaterThanOrEqual(1);

      // Insert another node
      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (555555, '!00087a63', 'Node Five', 'FIV', 0, ${now}, ${now})
      `);

      // Run second time - should not mark any nodes (migration already completed)
      const secondCount = dbService.handleAutoWelcomeEnabled();
      expect(secondCount).toBe(0);

      // The new node should NOT be marked (migration already ran)
      const stmt = dbService.db.prepare('SELECT welcomedAt FROM nodes WHERE nodeNum = ?');
      const node = stmt.get(555555) as { welcomedAt: number | null };
      expect(node.welcomedAt).toBeNull();
    });

    it('should handle empty database gracefully', () => {
      // Ensure no nodes exist (except broadcast node)
      dbService.db.exec('DELETE FROM nodes WHERE nodeNum != 4294967295');

      // Should not throw
      expect(() => {
        dbService.handleAutoWelcomeEnabled();
      }).not.toThrow();

      // Migration should be marked as completed
      const migrationStatus = dbService.getSetting('auto_welcome_first_enabled');
      expect(migrationStatus).toBe('completed');
    });

    it('should only mark nodes without welcomedAt', () => {
      const now = Date.now();
      const oldWelcomedAt = now - 5 * 24 * 60 * 60 * 1000; // 5 days ago

      // Insert node that was already welcomed
      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, welcomedAt, createdAt, updatedAt)
        VALUES (666666, '!000a2d26', 'Node Six', 'SIX', 0, ${oldWelcomedAt}, ${now}, ${now})
      `);

      // Insert node without welcomedAt
      dbService.db.exec(`
        INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hwModel, createdAt, updatedAt)
        VALUES (777777, '!000bdc89', 'Node Seven', 'SEV', 0, ${now}, ${now})
      `);

      // Run the handler
      dbService.handleAutoWelcomeEnabled();

      // Node 666666 should keep its original timestamp
      const stmt1 = dbService.db.prepare('SELECT welcomedAt FROM nodes WHERE nodeNum = ?');
      const node1 = stmt1.get(666666) as { welcomedAt: number };
      expect(node1.welcomedAt).toBe(oldWelcomedAt);

      // Node 777777 should now have welcomedAt
      const node2 = stmt1.get(777777) as { welcomedAt: number };
      expect(node2.welcomedAt).toBeDefined();
      expect(node2.welcomedAt).toBeGreaterThan(now - 1000);
    });
  });
});
