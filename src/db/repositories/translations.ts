/**
 * Repository for the translation cache (#5520): the GLOBAL `translation_cache`
 * table (hashed text → translation) and the PER-SOURCE `message_translations`
 * links from a Meshtastic message to a cache entry.
 *
 * Invariants (see docs/internal/dev-notes/TRANSLATION_CACHE_SPEC.md):
 *  - Callers pass a precomputed `cacheKey` (`computeTranslationCacheKey`); the
 *    source text never reaches this layer and is never stored.
 *  - No method looks a cache entry up by text, and no route exposes
 *    `getCacheEntry` — the cache is server-internal.
 *  - `messageRefCount` = number of link rows pointing at the entry. It is
 *    bumped when a link is added, and recounted from the link table whenever
 *    links are removed (`removeOrphanedLinks`) and by the hourly prune.
 *  - An entry with `messageRefCount >= 1` is never pruned; one with
 *    `messageRefCount >= 2` is pinned (exempt from TTL and the size cap).
 *
 * Raw SQL here is limited to correlated NOT EXISTS / COUNT subqueries that
 * name two tables; column names go through `this.col()` for PostgreSQL's
 * quoted camelCase.
 */
import { and, asc, count, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase, type SourceScope, ALL_SOURCES } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbTranslationCacheEntry {
  cacheKey: string;
  targetLang: string;
  sourceLang: string | null;
  translatedText: string;
  detectedSourceLanguage: string | null;
  provider: string;
  createdAt: number;
  lastUsedAt: number;
  hitCount: number;
  messageRefCount: number;
}

export interface NewTranslationCacheEntry {
  cacheKey: string;
  targetLang: string;
  sourceLang?: string | null;
  translatedText: string;
  detectedSourceLanguage?: string | null;
  provider: string;
}

export interface StoredMessageTranslation {
  messageId: string;
  targetLang: string;
  translatedText: string;
  detectedSourceLanguage: string | null;
  provider: string;
}

export interface PruneTranslationCacheOptions {
  /** Unix ms "now". */
  now: number;
  /** Unreferenced entries unused for longer than this are deleted. */
  ttlMs: number;
  /** Max number of non-pinned (`messageRefCount < 2`) entries to keep. */
  maxUnpinned: number;
}

export interface PruneTranslationCacheResult {
  orphanedLinksRemoved: number;
  expired: number;
  evicted: number;
}

/** Pinned = referenced by at least this many distinct messages. */
export const TRANSLATION_PIN_THRESHOLD = 2;

const DELETE_CHUNK = 500;

/** Column widths shared with the MySQL schema. */
const MAX_LANG_LEN = 16;
const MAX_PROVIDER_LEN = 32;

export class TranslationsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private mapEntry(row: any): DbTranslationCacheEntry { // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
    return {
      cacheKey: row.cacheKey,
      targetLang: row.targetLang,
      sourceLang: row.sourceLang ?? null,
      translatedText: row.translatedText,
      detectedSourceLanguage: row.detectedSourceLanguage ?? null,
      provider: row.provider,
      createdAt: Number(row.createdAt),
      lastUsedAt: Number(row.lastUsedAt),
      hitCount: Number(row.hitCount ?? 0),
      messageRefCount: Number(row.messageRefCount ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // translation_cache (global)
  // -------------------------------------------------------------------------

  /** Server-internal lookup by hash. Never exposed to a route. */
  async getCacheEntry(cacheKey: string): Promise<DbTranslationCacheEntry | null> {
    const { translationCache } = this.tables;
    const rows = await this.db
      .select()
      .from(translationCache)
      .where(eq(translationCache.cacheKey, cacheKey))
      .limit(1);
    return rows.length > 0 ? this.mapEntry(rows[0]) : null;
  }

  /** Record a cache hit: refresh `lastUsedAt` and bump `hitCount`. */
  async touchCacheEntry(cacheKey: string, now: number = this.now()): Promise<void> {
    const { translationCache } = this.tables;
    await this.db
      .update(translationCache)
      .set({ lastUsedAt: now, hitCount: sql`${translationCache.hitCount} + 1` })
      .where(eq(translationCache.cacheKey, cacheKey));
  }

  /**
   * Insert a cache entry. A concurrent insert of the same key wins; this one
   * is dropped (both carry a provider translation of the same text).
   * Returns true when a row was written.
   */
  async insertCacheEntry(entry: NewTranslationCacheEntry, now: number = this.now()): Promise<boolean> {
    const { translationCache } = this.tables;
    const result = await this.insertIgnore(translationCache, {
      cacheKey: entry.cacheKey,
      targetLang: entry.targetLang.slice(0, MAX_LANG_LEN),
      sourceLang: entry.sourceLang ? entry.sourceLang.slice(0, MAX_LANG_LEN) : null,
      translatedText: entry.translatedText,
      detectedSourceLanguage: entry.detectedSourceLanguage
        ? entry.detectedSourceLanguage.slice(0, MAX_LANG_LEN)
        : null,
      provider: entry.provider.slice(0, MAX_PROVIDER_LEN),
      createdAt: now,
      lastUsedAt: now,
      hitCount: 0,
      messageRefCount: 0,
    });
    return this.getAffectedRows(result) > 0;
  }

  async countCacheEntries(): Promise<number> {
    const { translationCache } = this.tables;
    const [{ c }] = await this.db.select({ c: count() }).from(translationCache);
    return Number(c);
  }

  private async adjustRefCount(cacheKey: string, delta: 1 | -1): Promise<void> {
    const { translationCache } = this.tables;
    const condition = delta < 0
      ? and(eq(translationCache.cacheKey, cacheKey), sql`${translationCache.messageRefCount} > 0`)
      : eq(translationCache.cacheKey, cacheKey);
    await this.db
      .update(translationCache)
      .set({ messageRefCount: sql`${translationCache.messageRefCount} + ${delta}` })
      .where(condition);
  }

  // -------------------------------------------------------------------------
  // message_translations (per-source)
  // -------------------------------------------------------------------------

  /**
   * Link a message to a cache entry for one target language, maintaining
   * `messageRefCount`. Re-linking to the same entry is a no-op; re-linking to
   * a different entry moves the reference. Returns false (and writes nothing)
   * when the cache entry does not exist.
   */
  async linkMessage(
    sourceId: string,
    messageId: string,
    targetLang: string,
    cacheKey: string,
    now: number = this.now(),
  ): Promise<boolean> {
    if (!sourceId) throw new Error('linkMessage: sourceId is required');
    if (!messageId) throw new Error('linkMessage: messageId is required');
    const { messageTranslations: links, translationCache } = this.tables;

    const entry = await this.db
      .select({ cacheKey: translationCache.cacheKey })
      .from(translationCache)
      .where(eq(translationCache.cacheKey, cacheKey))
      .limit(1);
    if (entry.length === 0) return false;

    const pk = and(
      this.withSourceScope(links, sourceId),
      eq(links.messageId, messageId),
      eq(links.targetLang, targetLang),
    );
    const existing = await this.db.select({ cacheKey: links.cacheKey }).from(links).where(pk).limit(1);

    if (existing.length > 0) {
      const oldKey: string = existing[0].cacheKey;
      if (oldKey === cacheKey) return true;
      const moved = await this.db
        .update(links)
        .set({ cacheKey, createdAt: now })
        .where(and(pk, eq(links.cacheKey, oldKey)));
      if (this.getAffectedRows(moved) > 0) {
        await this.adjustRefCount(oldKey, -1);
        await this.adjustRefCount(cacheKey, 1);
      }
      return true;
    }

    const inserted = await this.insertIgnore(links, { sourceId, messageId, targetLang, cacheKey, createdAt: now });
    if (this.getAffectedRows(inserted) > 0) {
      await this.adjustRefCount(cacheKey, 1);
    }
    return true;
  }

  /**
   * Stored translations for `messageIds` on one source in one language.
   * Pure read: no provider call, no `lastUsedAt` refresh (linked entries are
   * never pruned, so a read does not need to keep them alive). The caller
   * applies message visibility.
   */
  async getStoredTranslations(
    sourceId: string,
    messageIds: string[],
    targetLang: string,
  ): Promise<StoredMessageTranslation[]> {
    if (!sourceId) throw new Error('getStoredTranslations: sourceId is required');
    if (messageIds.length === 0) return [];
    const { messageTranslations: links, translationCache } = this.tables;
    const rows = await this.db
      .select({
        messageId: links.messageId,
        targetLang: links.targetLang,
        translatedText: translationCache.translatedText,
        detectedSourceLanguage: translationCache.detectedSourceLanguage,
        provider: translationCache.provider,
      })
      .from(links)
      .innerJoin(translationCache, eq(links.cacheKey, translationCache.cacheKey))
      .where(and(
        this.withSourceScope(links, sourceId),
        eq(links.targetLang, targetLang),
        inArray(links.messageId, messageIds),
      ));
    return (rows as any[]).map((r) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union
      messageId: r.messageId,
      targetLang: r.targetLang,
      translatedText: r.translatedText,
      detectedSourceLanguage: r.detectedSourceLanguage ?? null,
      provider: r.provider,
    }));
  }

  /** Every link for one message (all languages). Mostly for tests/diagnostics. */
  async getLinksForMessage(sourceId: string, messageId: string): Promise<Array<{ targetLang: string; cacheKey: string }>> {
    const { messageTranslations: links } = this.tables;
    const rows = await this.db
      .select({ targetLang: links.targetLang, cacheKey: links.cacheKey })
      .from(links)
      .where(and(this.withSourceScope(links, sourceId), eq(links.messageId, messageId)));
    return rows as Array<{ targetLang: string; cacheKey: string }>;
  }

  // -------------------------------------------------------------------------
  // Cleanup: orphaned links + refcount reconciliation
  // -------------------------------------------------------------------------

  /** `DELETE` of links whose message row no longer exists (optionally per source). */
  private orphanedLinksDeleteSql(scope: SourceScope): SQL {
    const c = (n: string) => this.col(n);
    const scopeClause = scope === ALL_SOURCES
      ? sql``
      : sql`${c('sourceId')} = ${scope} AND `;
    return sql`DELETE FROM message_translations WHERE ${scopeClause}NOT EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = message_translations.${c('messageId')}
        AND m.${c('sourceId')} = message_translations.${c('sourceId')}
    )`;
  }

  /** Recount `messageRefCount` from the link table for every drifted entry. */
  private reconcileRefCountsSql(): SQL {
    const c = (n: string) => this.col(n);
    const linkCount = sql`(SELECT COUNT(*) FROM message_translations l WHERE l.${c('cacheKey')} = translation_cache.${c('cacheKey')})`;
    return sql`UPDATE translation_cache SET ${c('messageRefCount')} = ${linkCount} WHERE ${c('messageRefCount')} <> ${linkCount}`;
  }

  private assertScope(scope: SourceScope | undefined): asserts scope is SourceScope {
    if (scope === undefined || scope === null || scope === '') {
      throw new Error('removeOrphanedLinks: pass a sourceId or ALL_SOURCES');
    }
  }

  /**
   * Delete links whose message is gone and, if any were removed, recount
   * `messageRefCount`. Called after every message delete path in
   * `MessagesRepository` and by the hourly prune. Returns links removed.
   */
  async removeOrphanedLinks(scope: SourceScope): Promise<number> {
    this.assertScope(scope);
    const result = await this.executeRun(this.orphanedLinksDeleteSql(scope));
    const removed = this.getAffectedRows(result);
    if (removed > 0) {
      await this.executeRun(this.reconcileRefCountsSql());
    }
    return removed;
  }

  /** Synchronous SQLite twin of `removeOrphanedLinks` for the legacy sync facade. */
  removeOrphanedLinksSqliteSync(scope: SourceScope): number {
    this.assertScope(scope);
    const db = this.getSqliteDb();
    const result = db.run(this.orphanedLinksDeleteSql(scope));
    const removed = Number(result?.changes ?? 0);
    if (removed > 0) {
      db.run(this.reconcileRefCountsSql());
    }
    return removed;
  }

  /** Recount every drifted `messageRefCount` from the link table. */
  async reconcileMessageRefCounts(): Promise<void> {
    await this.executeRun(this.reconcileRefCountsSql());
  }

  // -------------------------------------------------------------------------
  // Pruning
  // -------------------------------------------------------------------------

  /**
   * Hourly / startup prune. DB-only.
   *  1. Sweep orphaned links (any delete path that bypassed the repository)
   *     and reconcile `messageRefCount`.
   *  2. TTL: delete unreferenced entries unused for longer than `ttlMs`.
   *  3. Size cap: while non-pinned entries exceed `maxUnpinned`, delete the
   *     least recently used UNREFERENCED entries. Referenced and pinned entries
   *     are never deleted, so the cap is best-effort when references alone
   *     exceed it.
   */
  async pruneCache(opts: PruneTranslationCacheOptions): Promise<PruneTranslationCacheResult> {
    const orphanedLinksRemoved = await this.removeOrphanedLinks(ALL_SOURCES);
    await this.reconcileMessageRefCounts();

    const { translationCache } = this.tables;
    const c = (n: string) => this.col(n);
    const cutoff = opts.now - opts.ttlMs;

    const expiredResult = await this.executeRun(sql`DELETE FROM translation_cache
      WHERE ${c('messageRefCount')} = 0
        AND ${c('lastUsedAt')} < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM message_translations l WHERE l.${c('cacheKey')} = translation_cache.${c('cacheKey')})`);
    const expired = this.getAffectedRows(expiredResult);

    const [{ unpinned }] = await this.db
      .select({ unpinned: count() })
      .from(translationCache)
      .where(lt(translationCache.messageRefCount, TRANSLATION_PIN_THRESHOLD));
    const excess = Number(unpinned) - opts.maxUnpinned;

    let evicted = 0;
    if (excess > 0) {
      const victims = await this.db
        .select({ cacheKey: translationCache.cacheKey })
        .from(translationCache)
        .where(eq(translationCache.messageRefCount, 0))
        .orderBy(asc(translationCache.lastUsedAt))
        .limit(excess);
      const keys = (victims as Array<{ cacheKey: string }>).map((v) => v.cacheKey);
      for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
        const chunk = keys.slice(i, i + DELETE_CHUNK);
        const res = await this.db
          .delete(translationCache)
          .where(and(inArray(translationCache.cacheKey, chunk), eq(translationCache.messageRefCount, 0)));
        evicted += this.getAffectedRows(res);
      }
    }

    return { orphanedLinksRemoved, expired, evicted };
  }
}
