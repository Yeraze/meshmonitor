/**
 * meshcore_nodes.name is scrubbed to printable text on write and on read, so
 * rows stored from a corrupt serial frame (before the ingest guard) display
 * as a public-key fallback instead of binary junk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SOURCE = 'src-a';
const KEY = 'ab'.repeat(32);
const fromHex = (hex: string) => Buffer.from(hex, 'hex').toString('utf8');

describe('MeshCoreRepository — node name sanitising', () => {
  let db: Database.Database;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('strips a truncated trailing multi-byte char on write', async () => {
    await repo.upsertNode(
      { publicKey: KEY, name: fromHex('4476796e736f756c20474154353632204261736520efbfbd') },
      SOURCE,
    );
    const raw = db.prepare('SELECT name FROM meshcore_nodes WHERE publicKey = ?').get(KEY) as { name: string };
    expect(raw.name).toBe('Dvynsoul GAT562 Base');
  });

  it('does not let a binary name overwrite a good one', async () => {
    await repo.upsertNode({ publicKey: KEY, name: 'Good Name' }, SOURCE);
    // Nothing printable left ⇒ "not observed" ⇒ the stored name survives.
    await repo.upsertNode({ publicKey: KEY, name: fromHex('efbfbdefbfbd01') }, SOURCE);
    expect((await repo.getNodeByPublicKeyAndSource(KEY, SOURCE))?.name).toBe('Good Name');
  });

  it('sanitises legacy binary names on read', async () => {
    // Simulate a row written before the fix.
    await repo.upsertNode({ publicKey: KEY, name: 'placeholder' }, SOURCE);
    db.prepare('UPDATE meshcore_nodes SET name = ? WHERE publicKey = ?')
      .run(fromHex('efbfbd01393827efbfbdefbfbd'), KEY);
    const other = 'cd'.repeat(32);
    await repo.upsertNode({ publicKey: other, name: 'placeholder' }, SOURCE);
    db.prepare('UPDATE meshcore_nodes SET name = ? WHERE publicKey = ?')
      .run(fromHex('4476796e736f756c20474154353632204261736520efbfbd'), other);

    const byKey = new Map((await repo.getNodesBySource(SOURCE)).map((n) => [n.publicKey, n.name]));
    expect(byKey.get(KEY)).toBeNull();
    expect(byKey.get(other)).toBe('Dvynsoul GAT562 Base');
    expect((await repo.getNodeByPublicKey(KEY))?.name).toBeNull();
    expect((await repo.getAllNodes()).find((n) => n.publicKey === other)?.name).toBe('Dvynsoul GAT562 Base');
  });
});
