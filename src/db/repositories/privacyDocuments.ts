/**
 * Privacy Documents Repository (#5156)
 *
 * CRUD for the GLOBAL `privacy_documents` table — the operator's hosted
 * privacy policy / terms / contact pages. Not source-scoped: the document
 * describes the deployment serving the dashboard, not any one mesh source.
 *
 * There is at most one row per slug, so every write is an upsert keyed on
 * `slug` and every read is a slug lookup. `content` is Markdown source; see
 * `src/db/schema/privacyDocuments.ts` for why it must never be HTML.
 */
import { eq, asc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';
import { PRIVACY_DOCUMENT_SLUGS, type PrivacyDocumentSlug } from '../schema/privacyDocuments.js';

export interface PrivacyDocument {
  id: number;
  slug: PrivacyDocumentSlug;
  title: string;
  content: string;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** True when `slug` is one of the three documents an operator can host. */
export function isPrivacyDocumentSlug(slug: unknown): slug is PrivacyDocumentSlug {
  return typeof slug === 'string' && (PRIVACY_DOCUMENT_SLUGS as readonly string[]).includes(slug);
}

export class PrivacyDocumentsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- row shape varies by dialect; mirrors sibling repositories
  private map(row: any): PrivacyDocument {
    return this.normalizeBigInts({
      id: Number(row.id),
      slug: row.slug as PrivacyDocumentSlug,
      title: row.title,
      content: row.content,
      updatedBy: row.updatedBy ?? null,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    });
  }

  /** Every hosted document, ordered by slug. */
  async getAllAsync(): Promise<PrivacyDocument[]> {
    const { privacyDocuments } = this.tables;
    const rows = await this.db
      .select()
      .from(privacyDocuments)
      .orderBy(asc(privacyDocuments.slug));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see map()
    return rows.map((r: any) => this.map(r));
  }

  /** One hosted document, or null when the operator hasn't written it. */
  async getBySlugAsync(slug: string): Promise<PrivacyDocument | null> {
    if (!isPrivacyDocumentSlug(slug)) return null;
    const { privacyDocuments } = this.tables;
    const rows = await this.db
      .select()
      .from(privacyDocuments)
      .where(eq(privacyDocuments.slug, slug))
      .limit(1);
    return rows.length ? this.map(rows[0]) : null;
  }

  /**
   * The slugs that currently have a hosted document. Used by the public
   * links endpoint, which must not ship document bodies to anonymous
   * visitors just to decide whether to render a link.
   */
  async getHostedSlugsAsync(): Promise<PrivacyDocumentSlug[]> {
    const { privacyDocuments } = this.tables;
    const rows = await this.db
      .select({ slug: privacyDocuments.slug })
      .from(privacyDocuments)
      .orderBy(asc(privacyDocuments.slug));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see map()
    return rows.map((r: any) => r.slug as PrivacyDocumentSlug);
  }

  /**
   * Create or replace the document for `slug`. `createdAt` is preserved
   * across edits so the UI can show when the operator first published,
   * not merely when they last touched it.
   *
   * Throws on an unknown slug so callers can surface a 400.
   */
  async upsertAsync(
    slug: string,
    title: string,
    content: string,
    updatedBy?: string | null,
  ): Promise<PrivacyDocument> {
    if (!isPrivacyDocumentSlug(slug)) {
      throw new Error(`Unknown privacy document slug: ${slug}`);
    }
    const trimmedTitle = (title ?? '').trim();
    if (!trimmedTitle) {
      throw new Error('Document title is required');
    }

    const now = this.now();
    const { privacyDocuments } = this.tables;
    const existing = await this.getBySlugAsync(slug);
    const author = (updatedBy ?? '').trim() || null;

    if (existing) {
      await this.db
        .update(privacyDocuments)
        .set({ title: trimmedTitle, content, updatedBy: author, updatedAt: now })
        .where(eq(privacyDocuments.slug, slug));
      logger.debug(`Updated privacy document "${slug}"`);
      return { ...existing, title: trimmedTitle, content, updatedBy: author, updatedAt: now };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- insert shape varies by dialect
    const values: any = {
      slug,
      title: trimmedTitle,
      content,
      updatedBy: author,
      createdAt: now,
      updatedAt: now,
    };

    if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.insert(privacyDocuments).values(values);
      const id = Number(result[0].insertId);
      logger.debug(`Created privacy document "${slug}" (ID: ${id})`);
      return { id, slug, title: trimmedTitle, content, updatedBy: author, createdAt: now, updatedAt: now };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- .returning() is not on the union type
    const result = await (this.db as any)
      .insert(privacyDocuments)
      .values(values)
      .returning({ id: privacyDocuments.id });
    const id = Number(result[0].id);
    logger.debug(`Created privacy document "${slug}" (ID: ${id})`);
    return { id, slug, title: trimmedTitle, content, updatedBy: author, createdAt: now, updatedAt: now };
  }

  /** Remove a hosted document. Silent when it was never written. */
  async deleteAsync(slug: string): Promise<void> {
    if (!isPrivacyDocumentSlug(slug)) return;
    const { privacyDocuments } = this.tables;
    await this.db.delete(privacyDocuments).where(eq(privacyDocuments.slug, slug));
    logger.debug(`Deleted privacy document "${slug}"`);
  }
}
