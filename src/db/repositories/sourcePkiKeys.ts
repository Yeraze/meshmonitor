/**
 * Repository for `source_pki_keys` — per-source encrypted X25519 private keys
 * used for server-side PKI direct-message decryption (issue #3441).
 *
 * Stores only the encrypted envelope (see sourcePkiKeyStore); callers never put
 * a raw private key through here. One row per source.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbSourcePkiKey {
  sourceId: string;
  encryptedPrivateKey: string;
  publicKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export class SourcePkiKeysRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Get the stored (encrypted) key row for a source, or null. */
  async getBySourceId(sourceId: string): Promise<DbSourcePkiKey | null> {
    const { sourcePkiKeys } = this.tables;
    const rows = await this.db
      .select()
      .from(sourcePkiKeys)
      .where(eq(sourcePkiKeys.sourceId, sourceId))
      .limit(1);
    return (rows[0] as DbSourcePkiKey) ?? null;
  }

  /** True when a source has a stored key (cheap existence check). */
  async hasKey(sourceId: string): Promise<boolean> {
    return (await this.getBySourceId(sourceId)) !== null;
  }

  /**
   * Insert or replace the encrypted key for a source. `encryptedPrivateKey` is
   * the AES-256-GCM envelope JSON, never a raw key.
   */
  async upsert(sourceId: string, encryptedPrivateKey: string, publicKey: string | null): Promise<void> {
    if (!sourceId) throw new Error('SourcePkiKeysRepository.upsert requires a sourceId');
    const { sourcePkiKeys } = this.tables;
    const now = Date.now();
    const existing = await this.getBySourceId(sourceId);
    if (existing) {
      await this.db
        .update(sourcePkiKeys)
        .set({ encryptedPrivateKey, publicKey, updatedAt: now })
        .where(eq(sourcePkiKeys.sourceId, sourceId));
    } else {
      await this.db.insert(sourcePkiKeys).values({
        sourceId,
        encryptedPrivateKey,
        publicKey,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /** Delete the stored key for a source. No-op if none exists. */
  async deleteBySourceId(sourceId: string): Promise<void> {
    const { sourcePkiKeys } = this.tables;
    await this.db.delete(sourcePkiKeys).where(eq(sourcePkiKeys.sourceId, sourceId));
  }
}
