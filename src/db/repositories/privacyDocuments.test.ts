/**
 * Privacy Documents Repository Tests (#5156)
 *
 * CRUD + upsert-by-slug coverage for the GLOBAL `privacy_documents` table
 * against a real in-memory SQLite database (migration 161 applied via
 * createTestDb).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { PrivacyDocumentsRepository, isPrivacyDocumentSlug } from './privacyDocuments.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('isPrivacyDocumentSlug', () => {
  it('accepts the three known slugs and nothing else', () => {
    expect(isPrivacyDocumentSlug('privacy')).toBe(true);
    expect(isPrivacyDocumentSlug('terms')).toBe(true);
    expect(isPrivacyDocumentSlug('contact')).toBe(true);
    expect(isPrivacyDocumentSlug('policy')).toBe(false);
    expect(isPrivacyDocumentSlug('')).toBe(false);
    expect(isPrivacyDocumentSlug('../../etc/passwd')).toBe(false);
    expect(isPrivacyDocumentSlug(null)).toBe(false);
    expect(isPrivacyDocumentSlug(42)).toBe(false);
  });
});

describe('PrivacyDocumentsRepository', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: PrivacyDocumentsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new PrivacyDocumentsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('starts empty', async () => {
    expect(await repo.getAllAsync()).toEqual([]);
    expect(await repo.getHostedSlugsAsync()).toEqual([]);
  });

  it('creates and reads back a document', async () => {
    const saved = await repo.upsertAsync('privacy', 'Privacy Policy', '# Hello', 'admin');

    expect(saved.slug).toBe('privacy');
    expect(saved.title).toBe('Privacy Policy');
    expect(saved.content).toBe('# Hello');
    expect(saved.updatedBy).toBe('admin');

    const fetched = await repo.getBySlugAsync('privacy');
    expect(fetched?.content).toBe('# Hello');
  });

  it('replaces rather than duplicating on a second write to the same slug', async () => {
    await repo.upsertAsync('privacy', 'V1', 'first', 'admin');
    await repo.upsertAsync('privacy', 'V2', 'second', 'editor');

    const all = await repo.getAllAsync();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('V2');
    expect(all[0].content).toBe('second');
    expect(all[0].updatedBy).toBe('editor');
  });

  it('preserves createdAt across an edit but moves updatedAt', async () => {
    // The UI shows "last updated"; the operator's original publication date is
    // still the honest createdAt, so an edit must not rewrite it.
    const first = await repo.upsertAsync('privacy', 'V1', 'first');
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.upsertAsync('privacy', 'V2', 'second');

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it('keeps the three slugs independent', async () => {
    await repo.upsertAsync('privacy', 'P', 'p-body');
    await repo.upsertAsync('terms', 'T', 't-body');

    expect(await repo.getHostedSlugsAsync()).toEqual(['privacy', 'terms']);
    expect((await repo.getBySlugAsync('privacy'))?.content).toBe('p-body');
    expect((await repo.getBySlugAsync('terms'))?.content).toBe('t-body');
    expect(await repo.getBySlugAsync('contact')).toBeNull();
  });

  it('rejects an unknown slug rather than creating a row for it', async () => {
    await expect(repo.upsertAsync('malware', 'X', 'body')).rejects.toThrow(/Unknown privacy document slug/);
    expect(await repo.getAllAsync()).toEqual([]);
  });

  it('requires a title', async () => {
    await expect(repo.upsertAsync('privacy', '   ', 'body')).rejects.toThrow(/title is required/i);
  });

  it('treats a blank author as no author rather than an empty string', async () => {
    const saved = await repo.upsertAsync('privacy', 'P', 'body', '  ');
    expect(saved.updatedBy).toBeNull();
  });

  it('deletes a document and leaves the others alone', async () => {
    await repo.upsertAsync('privacy', 'P', 'p-body');
    await repo.upsertAsync('terms', 'T', 't-body');

    await repo.deleteAsync('privacy');

    expect(await repo.getBySlugAsync('privacy')).toBeNull();
    expect(await repo.getHostedSlugsAsync()).toEqual(['terms']);
  });

  it('ignores a delete for an unknown slug', async () => {
    await repo.upsertAsync('privacy', 'P', 'p-body');
    await expect(repo.deleteAsync('nonsense')).resolves.toBeUndefined();
    expect(await repo.getHostedSlugsAsync()).toEqual(['privacy']);
  });

  it('returns null for an unknown slug rather than throwing', async () => {
    expect(await repo.getBySlugAsync('nonsense')).toBeNull();
  });
});
