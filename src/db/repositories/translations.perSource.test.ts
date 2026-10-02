/**
 * `message_translations` per-source isolation (#5520). The cache itself is
 * global by design; the LINKS are per-source and must never leak.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { TranslationsRepository } from './translations.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('TranslationsRepository — per-source isolation', () => {
  let db: Database.Database;
  let repo: TranslationsRepository;

  beforeEach(async () => {
    const t = createTestDb();
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
});
