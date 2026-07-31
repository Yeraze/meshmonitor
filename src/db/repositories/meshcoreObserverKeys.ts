/**
 * Repository for `meshcore_observer_keys` — per-source encrypted Ed25519
 * (orlp format) signing keys used to mint MeshCore Analyzer Observer auth
 * tokens (epic #4457).
 *
 * Stores only the encrypted envelope (see meshcoreObserverKeyStore); callers
 * never put a raw private key through here. One row per source.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbMeshCoreObserverKey {
  sourceId: string;
  encryptedPrivateKey: string;
  publicKey: string | null;
  keyOrigin: string | null;
  createdAt: number;
  updatedAt: number;
}

export class MeshCoreObserverKeysRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Get the stored (encrypted) key row for a source, or null. */
  async getBySourceId(sourceId: string): Promise<DbMeshCoreObserverKey | null> {
    const { meshcoreObserverKeys } = this.tables;
    const rows = await this.db
      .select()
      .from(meshcoreObserverKeys)
      .where(eq(meshcoreObserverKeys.sourceId, sourceId))
      .limit(1);
    return (rows[0] as DbMeshCoreObserverKey) ?? null;
  }

  /** True when a source has a stored key (cheap existence check). */
  async hasKey(sourceId: string): Promise<boolean> {
    return (await this.getBySourceId(sourceId)) !== null;
  }

  /**
   * Insert or replace the encrypted key for a source. `encryptedPrivateKey`
   * is the AES-256-GCM envelope JSON, never a raw key.
   */
  async upsert(
    sourceId: string,
    encryptedPrivateKey: string,
    publicKey: string | null,
    keyOrigin: 'device' | 'manual',
  ): Promise<void> {
    if (!sourceId) throw new Error('MeshCoreObserverKeysRepository.upsert requires a sourceId');
    const { meshcoreObserverKeys } = this.tables;
    const now = Date.now();
    const existing = await this.getBySourceId(sourceId);
    if (existing) {
      await this.db
        .update(meshcoreObserverKeys)
        .set({ encryptedPrivateKey, publicKey, keyOrigin, updatedAt: now })
        .where(eq(meshcoreObserverKeys.sourceId, sourceId));
    } else {
      await this.db.insert(meshcoreObserverKeys).values({
        sourceId,
        encryptedPrivateKey,
        publicKey,
        keyOrigin,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /** Delete the stored key for a source. No-op if none exists. */
  async deleteBySourceId(sourceId: string): Promise<void> {
    const { meshcoreObserverKeys } = this.tables;
    await this.db.delete(meshcoreObserverKeys).where(eq(meshcoreObserverKeys.sourceId, sourceId));
  }
}
