/**
 * `message_translations` per-source isolation (#5520). The cache itself is
 * global by design; the LINKS are per-source and must never leak.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { TranslationsRepository } from './translations.js';
import { MeshCoreRepository } from './meshcore.js';
import { ALL_SOURCES } from './base.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('TranslationsRepository — per-source isolation', () => {
  let db: Database.Database;
  let repo: TranslationsRepository;
  let t: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    t = createTestDb();
    db = t.sqlite;
    repo = new TranslationsRepository(t.db, 'sqlite');
    await repo.insertCacheEntry({ cacheKey: 'k', targetLang: 'en', translatedText: 'Hello', provider: 'deepl' });
    // Same message id on two sources (ids are per-source in practice; the
    // composite PK must keep them apart anyway).
    await repo.linkMessage('src-a', 'shared-id', 'en', 'k');
    await repo.linkMessage('src-b', 'shared-id', 'en', 'k');
  });

  afterEach(() => db.close());

  it('reads only the requested source', async () => {
    const a = await repo.getStoredTranslations('src-a', ['shared-id'], 'en');
    expect(a).toHaveLength(1);
    expect(await repo.getStoredTranslations('src-c', ['shared-id'], 'en')).toEqual([]);
    expect(await repo.getLinksForMessage('src-a', 'shared-id')).toEqual([{ targetLang: 'en', cacheKey: 'k' }]);
  });

  it('requires a sourceId on every per-source read and write', async () => {
    await expect(repo.getStoredTranslations('', ['shared-id'], 'en')).rejects.toThrow(/sourceId/);
    await expect(repo.linkMessage('', 'm', 'en', 'k')).rejects.toThrow(/sourceId/);
    await expect(repo.getLinksForMessage('', 'm')).rejects.toThrow(/sourceId/);
  });

  it('a source-scoped orphan sweep leaves other sources alone', async () => {
    // Neither message exists in `messages`, so both links are orphans.
    expect(await repo.removeOrphanedLinks('src-a')).toBe(1);
    expect(await repo.getLinksForMessage('src-a', 'shared-id')).toEqual([]);
    expect(await repo.getLinksForMessage('src-b', 'shared-id')).toHaveLength(1);
    expect((await repo.getCacheEntry('k'))?.messageRefCount).toBe(1);
  });

  it('a MeshCore delete on one source sweeps only that source\'s links (#6261)', async () => {
    const mc = new MeshCoreRepository(t.db, 'sqlite');
    const row = (id: string) => ({
      id, fromPublicKey: 'aa', toPublicKey: 'channel-0', text: 'x', timestamp: 1, createdAt: 1, messageType: 'channel',
    });
    await repo.linkMessage('src-a', 'mc-a', 'en', 'k');
    await repo.linkMessage('src-b', 'mc-b', 'en', 'k');
    await mc.insertMessage(row('mc-a') as never, 'src-a');
    await mc.insertMessage(row('mc-b') as never, 'src-b');
    // Drop the beforeEach links for the Meshtastic-style shared id.
    await repo.removeOrphanedLinks(ALL_SOURCES);

    // Both rows exist: nothing is an orphan.
    expect(await repo.removeOrphanedLinks(ALL_SOURCES)).toBe(0);

    // A delete scoped to the wrong source removes nothing and sweeps nothing.
    expect(await mc.deleteMessageForSource('mc-a', 'src-b')).toBe(false);
    expect(await repo.getLinksForMessage('src-a', 'mc-a')).toHaveLength(1);

    expect(await mc.deleteMessageForSource('mc-a', 'src-a')).toBe(true);
    expect(await repo.getLinksForMessage('src-a', 'mc-a')).toEqual([]);
    expect(await repo.getLinksForMessage('src-b', 'mc-b')).toHaveLength(1);
    expect((await repo.getCacheEntry('k'))?.messageRefCount).toBe(1);
  });
});
