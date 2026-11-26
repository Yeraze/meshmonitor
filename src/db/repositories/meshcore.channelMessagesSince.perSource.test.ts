/**
 * MeshCoreRepository.getChannelMessagesSince (#6566): one channel's messages
 * since a time, per source, oldest first, no reactions, newest kept at the limit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MeshCoreRepository, type DbMeshCoreMessage } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MeshCoreRepository.getChannelMessagesSince', () => {
  let db: Database.Database;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
  });
  afterEach(() => db.close());

  const insert = (id: string, sourceId: string, createdAt: number, extra: Partial<DbMeshCoreMessage> = {}) =>
    repo.insertMessage({
      id, fromPublicKey: 'channel-1', toPublicKey: null as any, text: id, timestamp: createdAt,
      messageType: 'text', sourceId, createdAt, ...extra,
    } as DbMeshCoreMessage, sourceId);

  it('returns this source and channel only, at or after the cutoff, oldest first, without reactions', async () => {
    await insert('old', 'a', 100);
    await insert('m1', 'a', 200);
    await insert('m2', 'a', 300);
    await insert('other-source', 'b', 250);
    await insert('other-channel', 'a', 260, { fromPublicKey: 'channel-2' });
    await insert('reaction', 'a', 270, { reactionEmoji: '👍' });
    await insert('own-send', 'a', 280, { fromPublicKey: 'aa'.repeat(32), toPublicKey: 'channel-1' });
    const rows = await repo.getChannelMessagesSince(1, 'a', 200, 100);
    expect(rows.map((r) => r.id)).toEqual(['m1', 'own-send', 'm2']);
  });

  it('keeps the newest rows at the limit', async () => {
    await insert('m1', 'a', 100);
    await insert('m2', 'a', 200);
    await insert('m3', 'a', 300);
    const rows = await repo.getChannelMessagesSince(1, 'a', 0, 2);
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm3']);
  });
});
