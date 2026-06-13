/**
 * Repository for `source_pki_keys` — per-source encrypted X25519 private keys
 * used for server-side PKI direct-message decryption (issue #3441).
 *
 * Stores only the encrypted envelope (see sourcePkiKeyStore); callers never put
 * a raw private key through here. One row per source.
 */
import { eq, desc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbSourcePkiKey {
  sourceId: string;
  nodeNum: number | null;
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

  /**
   * Get a stored key by the local node identity it belongs to. A PKI DM to node
   * X can be decrypted by X's key regardless of which source received the
   * packet, so the decrypt hook looks up by destination nodeNum. If more than
   * one source holds the same node's key, the most-recently-updated row wins.
   */
  async getByNodeNum(nodeNum: number): Promise<DbSourcePkiKey | null> {
    const { sourcePkiKeys } = this.tables;
    const rows = await this.db
      .select()
      .from(sourcePkiKeys)
      .where(eq(sourcePkiKeys.nodeNum, nodeNum))
      .orderBy(desc(sourcePkiKeys.updatedAt))
      .limit(1);
    return (rows[0] as DbSourcePkiKey) ?? null;
  }

  /** True when a source has a stored key (cheap existence check). */
  async hasKey(sourceId: string): Promise<boolean> {
    return (await this.getBySourceId(sourceId)) !== null;
  }

  /**
   * Insert or replace the encrypted key for a source. `encryptedPrivateKey` is
   * the AES-256-GCM envelope JSON, never a raw key. `nodeNum` is the source's
   * local node identity (for destination-keyed decrypt lookups).
   */
  async upsert(
    sourceId: string,
    nodeNum: number | null,
    encryptedPrivateKey: string,
    publicKey: string | null,
  ): Promise<void> {
    if (!sourceId) throw new Error('SourcePkiKeysRepository.upsert requires a sourceId');
    const { sourcePkiKeys } = this.tables;
    const now = Date.now();
    const existing = await this.getBySourceId(sourceId);
    if (existing) {
      await this.db
        .update(sourcePkiKeys)
        .set({ nodeNum, encryptedPrivateKey, publicKey, updatedAt: now })
        .where(eq(sourcePkiKeys.sourceId, sourceId));
    } else {
      await this.db.insert(sourcePkiKeys).values({
        sourceId,
        nodeNum,
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

  /** Delete every stored key (used when the global master switch is turned off). Returns the count removed. */
  async deleteAll(): Promise<number> {
    const { sourcePkiKeys } = this.tables;
    const rows = await this.db.select({ sourceId: sourcePkiKeys.sourceId }).from(sourcePkiKeys);
    if (rows.length === 0) return 0;
    await this.db.delete(sourcePkiKeys);
    return rows.length;
  }
}
