/**
 * MessagesRepository.getDirectMessages — chat portnum widening (#3691).
 *
 * The DM thread view previously hard-filtered `portnum = 1`
 * (TEXT_MESSAGE_APP), which hid ATAK GeoChat DMs: processTakPacket persists
 * them with channel = -1 and portnum = 72 (ATAK_PLUGIN), so the row existed
 * but never rendered. getDirectMessages now matches the DM_CHAT_PORTNUMS
 * allow-list [TEXT_MESSAGE_APP, ATAK_PLUGIN] while still excluding non-chat
 * rows (telemetry, traceroutes) from the thread.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import { ALL_SOURCES } from './base.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { PortNum } from '../../server/constants/meshtastic.js';

describe('MessagesRepository.getDirectMessages chat portnums', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const LOCAL_NUM = 0x12345678;
  const LOCAL_ID = '!12345678';
  const PEER_NUM = 0x87654321;
  const PEER_ID = '!87654321';

  beforeEach(() => {
    // Full production schema from the migration registry — see testDb.ts.
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;

    // Seed referenced nodes (full schema NOT NULL/PK columns: sourceId, timestamps).
    const now = Date.now();
    const insertNode = db.prepare(
      "INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, 'default', ?, ?)",
    );
    insertNode.run(LOCAL_NUM, LOCAL_ID, now, now);
    insertNode.run(PEER_NUM, PEER_ID, now, now);

    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const insert = (id: string, portnum: number | null, createdAt: number, channel = -1, text = 'x') => {
    db.prepare(
      `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, portnum, timestamp, rxTime, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, LOCAL_NUM, PEER_NUM, LOCAL_ID, PEER_ID, text, channel, portnum, createdAt, createdAt, createdAt);
  };

  it('returns ATAK GeoChat DMs (portnum 72) alongside text DMs (portnum 1)', async () => {
    insert('text-dm', PortNum.TEXT_MESSAGE_APP, 1000);
    insert('atak-dm', PortNum.ATAK_PLUGIN, 2000, -1, '[ATAK ALPHA] hi');

    const result = await repo.getDirectMessages(LOCAL_ID, PEER_ID, 100, 0, ALL_SOURCES);

    expect(result.map(m => m.id).sort()).toEqual(['atak-dm', 'text-dm']);
  });

  it('still excludes non-chat DM rows (telemetry, traceroute)', async () => {
    insert('text-dm', PortNum.TEXT_MESSAGE_APP, 1000);
    insert('telemetry-dm', PortNum.TELEMETRY_APP, 2000);
    insert('traceroute-dm', PortNum.TRACEROUTE_APP, 3000);

    const result = await repo.getDirectMessages(LOCAL_ID, PEER_ID, 100, 0, ALL_SOURCES);

    expect(result.map(m => m.id)).toEqual(['text-dm']);
  });

  it('does not pull broadcast ATAK GeoChat rows into a DM thread (channel != -1)', async () => {
    insert('atak-dm', PortNum.ATAK_PLUGIN, 1000, -1);
    insert('atak-broadcast', PortNum.ATAK_PLUGIN, 2000, 3);

    const result = await repo.getDirectMessages(LOCAL_ID, PEER_ID, 100, 0, ALL_SOURCES);

    expect(result.map(m => m.id)).toEqual(['atak-dm']);
  });
});
