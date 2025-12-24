import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Create a test database service with unread message methods
const createTestDatabase = () => {
  class TestDatabaseService {
    public db: Database.Database;

    constructor() {
      this.db = new Database(':memory:');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.createTables();
    }

    private createTables(): void {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          nodeNum INTEGER PRIMARY KEY,
          nodeId TEXT UNIQUE NOT NULL,
          longName TEXT,
          shortName TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          text TEXT NOT NULL,
          channel INTEGER NOT NULL DEFAULT 0,
          portnum INTEGER,
          timestamp INTEGER NOT NULL,
          createdAt INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS read_messages (
          message_id TEXT NOT NULL,
          user_id INTEGER,
          read_at INTEGER NOT NULL,
          PRIMARY KEY (message_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_fromNodeId ON messages(fromNodeId);
        CREATE INDEX IF NOT EXISTS idx_messages_toNodeId ON messages(toNodeId);
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
      `);
    }

    insertNode(nodeNum: number, nodeId: string, longName: string): void {
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO nodes (nodeNum, nodeId, longName, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
      `).run(nodeNum, nodeId, longName, now, now);
    }

    insertMessage(id: string, fromNodeId: string, toNodeId: string, text: string, channel: number, portnum: number = 1): void {
      const now = Date.now();
      // Extract node nums from node IDs (simple parsing for test)
      const fromNodeNum = parseInt(fromNodeId.replace('!', ''), 16);
      const toNodeNum = parseInt(toNodeId.replace('!', ''), 16);
      this.db.prepare(`
        INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, portnum, timestamp, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, portnum, now, now);
    }

    markAsRead(messageId: string, userId: number | null): void {
      const now = Date.now();
      this.db.prepare(`
        INSERT OR IGNORE INTO read_messages (message_id, user_id, read_at)
        VALUES (?, ?, ?)
      `).run(messageId, userId, now);
    }

    getUnreadCountsByChannel(userId: number | null, localNodeId?: string): {[channelId: number]: number} {
      // Only count incoming messages (exclude messages sent by our node)
      const excludeOutgoing = localNodeId ? 'AND m.fromNodeId != ?' : '';
      const stmt = this.db.prepare(`
        SELECT m.channel, COUNT(*) as count
        FROM messages m
        LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
        WHERE rm.message_id IS NULL
          AND m.channel != -1
          AND m.portnum = 1
          ${excludeOutgoing}
        GROUP BY m.channel
      `);

      let rows: Array<{ channel: number; count: number }>;
      if (userId === null) {
        rows = localNodeId
          ? stmt.all(localNodeId) as Array<{ channel: number; count: number }>
          : stmt.all() as Array<{ channel: number; count: number }>;
      } else {
        rows = localNodeId
          ? stmt.all(userId, localNodeId) as Array<{ channel: number; count: number }>
          : stmt.all(userId) as Array<{ channel: number; count: number }>;
      }

      const counts: {[channelId: number]: number} = {};
      rows.forEach(row => {
        counts[row.channel] = Number(row.count);
      });
      return counts;
    }

    getUnreadDMCount(localNodeId: string, remoteNodeId: string, userId: number | null): number {
      // Only count incoming DMs (messages FROM remote node TO local node)
      // Exclude outgoing messages (messages FROM local node TO remote node)
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM messages m
        LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
        WHERE rm.message_id IS NULL
          AND m.portnum = 1
          AND m.channel = -1
          AND m.fromNodeId = ?
          AND m.toNodeId = ?
      `);

      const params = userId === null
        ? [remoteNodeId, localNodeId]
        : [userId, remoteNodeId, localNodeId];

      const result = stmt.get(...params) as { count: number };
      return Number(result.count);
    }

    close(): void {
      this.db.close();
    }
  }

  return new TestDatabaseService();
};

describe('Unread Message Counts - Incoming Only Filter', () => {
  let db: ReturnType<typeof createTestDatabase>;

  const LOCAL_NODE_ID = '!aabbccdd';
  const REMOTE_NODE_1 = '!11223344';
  const REMOTE_NODE_2 = '!55667788';

  beforeEach(() => {
    db = createTestDatabase();
    // Setup nodes
    db.insertNode(0xaabbccdd, LOCAL_NODE_ID, 'Local Node');
    db.insertNode(0x11223344, REMOTE_NODE_1, 'Remote Node 1');
    db.insertNode(0x55667788, REMOTE_NODE_2, 'Remote Node 2');
  });

  describe('getUnreadCountsByChannel', () => {
    it('should count all unread messages when localNodeId is not provided', () => {
      // Insert incoming and outgoing messages on channel 0
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming 1', 0);
      db.insertMessage('msg2', LOCAL_NODE_ID, REMOTE_NODE_1, 'outgoing 1', 0);
      db.insertMessage('msg3', REMOTE_NODE_2, LOCAL_NODE_ID, 'incoming 2', 0);

      // Without localNodeId, should count all messages
      const counts = db.getUnreadCountsByChannel(null);
      expect(counts[0]).toBe(3);
    });

    it('should only count incoming messages when localNodeId is provided', () => {
      // Insert incoming and outgoing messages on channel 0
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming 1', 0);
      db.insertMessage('msg2', LOCAL_NODE_ID, REMOTE_NODE_1, 'outgoing 1', 0);
      db.insertMessage('msg3', REMOTE_NODE_2, LOCAL_NODE_ID, 'incoming 2', 0);
      db.insertMessage('msg4', LOCAL_NODE_ID, REMOTE_NODE_2, 'outgoing 2', 0);

      // With localNodeId, should only count incoming messages (2)
      const counts = db.getUnreadCountsByChannel(null, LOCAL_NODE_ID);
      expect(counts[0]).toBe(2);
    });

    it('should correctly count across multiple channels', () => {
      // Channel 0: 2 incoming, 1 outgoing
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming ch0', 0);
      db.insertMessage('msg2', LOCAL_NODE_ID, REMOTE_NODE_1, 'outgoing ch0', 0);
      db.insertMessage('msg3', REMOTE_NODE_2, LOCAL_NODE_ID, 'incoming ch0', 0);

      // Channel 1: 1 incoming, 2 outgoing
      db.insertMessage('msg4', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming ch1', 1);
      db.insertMessage('msg5', LOCAL_NODE_ID, REMOTE_NODE_1, 'outgoing ch1', 1);
      db.insertMessage('msg6', LOCAL_NODE_ID, REMOTE_NODE_2, 'outgoing ch1', 1);

      const counts = db.getUnreadCountsByChannel(null, LOCAL_NODE_ID);
      expect(counts[0]).toBe(2);
      expect(counts[1]).toBe(1);
    });

    it('should not count DMs (channel -1)', () => {
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming dm', -1);
      db.insertMessage('msg2', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming ch0', 0);

      const counts = db.getUnreadCountsByChannel(null, LOCAL_NODE_ID);
      expect(counts[-1]).toBeUndefined();
      expect(counts[0]).toBe(1);
    });

    it('should not count non-text messages (portnum != 1)', () => {
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'text msg', 0, 1);
      db.insertMessage('msg2', REMOTE_NODE_1, LOCAL_NODE_ID, 'position', 0, 3);
      db.insertMessage('msg3', REMOTE_NODE_1, LOCAL_NODE_ID, 'telemetry', 0, 67);

      const counts = db.getUnreadCountsByChannel(null, LOCAL_NODE_ID);
      expect(counts[0]).toBe(1);
    });

    it('should exclude read messages', () => {
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming 1', 0);
      db.insertMessage('msg2', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming 2', 0);
      db.insertMessage('msg3', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming 3', 0);

      // Mark one as read
      db.markAsRead('msg2', null);

      const counts = db.getUnreadCountsByChannel(null, LOCAL_NODE_ID);
      expect(counts[0]).toBe(2);
    });

    it('should handle user-specific read status', () => {
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming 1', 0);
      db.insertMessage('msg2', REMOTE_NODE_1, LOCAL_NODE_ID, 'incoming 2', 0);

      // User 1 reads msg1
      db.markAsRead('msg1', 1);

      // User 1 should see 1 unread
      const countsUser1 = db.getUnreadCountsByChannel(1, LOCAL_NODE_ID);
      expect(countsUser1[0]).toBe(1);

      // User 2 should see 2 unread
      const countsUser2 = db.getUnreadCountsByChannel(2, LOCAL_NODE_ID);
      expect(countsUser2[0]).toBe(2);
    });

    it('should return empty object when no unread messages', () => {
      db.insertMessage('msg1', LOCAL_NODE_ID, REMOTE_NODE_1, 'outgoing only', 0);

      const counts = db.getUnreadCountsByChannel(null, LOCAL_NODE_ID);
      expect(counts[0]).toBeUndefined();
      expect(Object.keys(counts).length).toBe(0);
    });
  });

  describe('getUnreadDMCount', () => {
    it('should only count incoming DMs from remote node', () => {
      // Incoming DM from remote to local
      db.insertMessage('dm1', REMOTE_NODE_1, LOCAL_NODE_ID, 'hello from remote', -1);
      // Outgoing DM from local to remote
      db.insertMessage('dm2', LOCAL_NODE_ID, REMOTE_NODE_1, 'hello to remote', -1);

      const count = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_1, null);
      expect(count).toBe(1);
    });

    it('should not count outgoing DMs', () => {
      // Only outgoing messages
      db.insertMessage('dm1', LOCAL_NODE_ID, REMOTE_NODE_1, 'outgoing 1', -1);
      db.insertMessage('dm2', LOCAL_NODE_ID, REMOTE_NODE_1, 'outgoing 2', -1);
      db.insertMessage('dm3', LOCAL_NODE_ID, REMOTE_NODE_1, 'outgoing 3', -1);

      const count = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_1, null);
      expect(count).toBe(0);
    });

    it('should count multiple incoming DMs', () => {
      db.insertMessage('dm1', REMOTE_NODE_1, LOCAL_NODE_ID, 'msg 1', -1);
      db.insertMessage('dm2', REMOTE_NODE_1, LOCAL_NODE_ID, 'msg 2', -1);
      db.insertMessage('dm3', REMOTE_NODE_1, LOCAL_NODE_ID, 'msg 3', -1);

      const count = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_1, null);
      expect(count).toBe(3);
    });

    it('should separate counts by remote node', () => {
      db.insertMessage('dm1', REMOTE_NODE_1, LOCAL_NODE_ID, 'from node 1', -1);
      db.insertMessage('dm2', REMOTE_NODE_1, LOCAL_NODE_ID, 'from node 1', -1);
      db.insertMessage('dm3', REMOTE_NODE_2, LOCAL_NODE_ID, 'from node 2', -1);

      const countNode1 = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_1, null);
      const countNode2 = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_2, null);

      expect(countNode1).toBe(2);
      expect(countNode2).toBe(1);
    });

    it('should exclude read DMs', () => {
      db.insertMessage('dm1', REMOTE_NODE_1, LOCAL_NODE_ID, 'msg 1', -1);
      db.insertMessage('dm2', REMOTE_NODE_1, LOCAL_NODE_ID, 'msg 2', -1);
      db.insertMessage('dm3', REMOTE_NODE_1, LOCAL_NODE_ID, 'msg 3', -1);

      db.markAsRead('dm2', null);

      const count = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_1, null);
      expect(count).toBe(2);
    });

    it('should handle user-specific read status for DMs', () => {
      db.insertMessage('dm1', REMOTE_NODE_1, LOCAL_NODE_ID, 'msg 1', -1);
      db.insertMessage('dm2', REMOTE_NODE_1, LOCAL_NODE_ID, 'msg 2', -1);

      // User 1 reads dm1
      db.markAsRead('dm1', 1);

      const countUser1 = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_1, 1);
      const countUser2 = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_1, 2);

      expect(countUser1).toBe(1);
      expect(countUser2).toBe(2);
    });

    it('should not count channel messages as DMs', () => {
      // Channel message (not DM)
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'channel msg', 0);
      // DM
      db.insertMessage('dm1', REMOTE_NODE_1, LOCAL_NODE_ID, 'dm', -1);

      const count = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_1, null);
      expect(count).toBe(1);
    });

    it('should not count non-text DMs', () => {
      db.insertMessage('dm1', REMOTE_NODE_1, LOCAL_NODE_ID, 'text dm', -1, 1);
      db.insertMessage('dm2', REMOTE_NODE_1, LOCAL_NODE_ID, 'position dm', -1, 3);

      const count = db.getUnreadDMCount(LOCAL_NODE_ID, REMOTE_NODE_1, null);
      expect(count).toBe(1);
    });
  });

  describe('Auto-generated messages scenario', () => {
    it('should not count Auto Welcome messages as unread', () => {
      // Simulate Auto Welcome scenario:
      // 1. Remote node joins and sends a message
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'Hello network!', 0);
      // 2. Our node sends Auto Welcome response (outgoing)
      db.insertMessage('msg2', LOCAL_NODE_ID, REMOTE_NODE_1, 'Welcome to the mesh!', 0);

      const counts = db.getUnreadCountsByChannel(null, LOCAL_NODE_ID);
      expect(counts[0]).toBe(1); // Only the incoming message
    });

    it('should not count Auto Ack messages as unread', () => {
      // Simulate Auto Ack scenario:
      // 1. Remote node sends a message matching pattern
      db.insertMessage('msg1', REMOTE_NODE_1, LOCAL_NODE_ID, 'STATUS?', 0);
      // 2. Our node sends Auto Ack response (outgoing)
      db.insertMessage('msg2', LOCAL_NODE_ID, REMOTE_NODE_1, 'All systems nominal', 0);
      // 3. Remote node sends another message
      db.insertMessage('msg3', REMOTE_NODE_2, LOCAL_NODE_ID, 'Hello', 0);

      const counts = db.getUnreadCountsByChannel(null, LOCAL_NODE_ID);
      expect(counts[0]).toBe(2); // Only the 2 incoming messages
    });

    it('should not count manually sent messages as unread', () => {
      // User manually sends messages
      db.insertMessage('msg1', LOCAL_NODE_ID, REMOTE_NODE_1, 'Hello from me', 0);
      db.insertMessage('msg2', LOCAL_NODE_ID, REMOTE_NODE_2, 'Hi there', 0);
      // Receives reply
      db.insertMessage('msg3', REMOTE_NODE_1, LOCAL_NODE_ID, 'Hello back!', 0);

      const counts = db.getUnreadCountsByChannel(null, LOCAL_NODE_ID);
      expect(counts[0]).toBe(1); // Only the reply
    });
  });
});
