/**
 * Repository for `meshcore_source_pki_keys` — per-source encrypted Ed25519
 * (orlp format) identity private keys for MeshCore Companion sources, captured
 * on connect and used to decrypt our own echoed DMs for #6194 heard-by
 * matching (issue #6195).
 *
 * Stores only the encrypted envelope (see meshcoreSourcePkiKeyStore); callers
 * never put a raw private key through here. One row per source.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbMeshCoreSourcePkiKey {
  sourceId: string;
  encryptedPrivateKey: string;
  publicKey: string | null;
  keyMismatch: number;
  createdAt: number;
  updatedAt: number;
}

export class MeshCoreSourcePkiKeysRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Get the stored (encrypted) key row for a source, or null. */
  async getBySourceId(sourceId: string): Promise<DbMeshCoreSourcePkiKey | null> {
    const { meshcoreSourcePkiKeys } = this.tables;
    const rows = await this.db
      .select()
      .from(meshcoreSourcePkiKeys)
      .where(eq(meshcoreSourcePkiKeys.sourceId, sourceId))
      .limit(1);
    return (rows[0] as DbMeshCoreSourcePkiKey) ?? null;
  }

  /** The source that owns a stored key with this public key, or null. */
  async getByPublicKey(publicKey: string): Promise<DbMeshCoreSourcePkiKey | null> {
    const { meshcoreSourcePkiKeys } = this.tables;
    const rows = await this.db
      .select()
      .from(meshcoreSourcePkiKeys)
      .where(eq(meshcoreSourcePkiKeys.publicKey, publicKey))
      .limit(1);
    return (rows[0] as DbMeshCoreSourcePkiKey) ?? null;
  }

  /**
   * Insert or replace the encrypted key for a source. `encryptedPrivateKey`
   * is the AES-256-GCM envelope JSON, never a raw key. A fresh store clears any
   * prior key-mismatch flag.
   */
  async upsert(
    sourceId: string,
    encryptedPrivateKey: string,
    publicKey: string | null,
    keyMismatch = 0,
  ): Promise<void> {
    if (!sourceId) throw new Error('MeshCoreSourcePkiKeysRepository.upsert requires a sourceId');
    const { meshcoreSourcePkiKeys } = this.tables;
    const now = Date.now();
    const existing = await this.getBySourceId(sourceId);
    if (existing) {
      await this.db
        .update(meshcoreSourcePkiKeys)
        .set({ encryptedPrivateKey, publicKey, keyMismatch, updatedAt: now })
        .where(eq(meshcoreSourcePkiKeys.sourceId, sourceId));
    } else {
      await this.db.insert(meshcoreSourcePkiKeys).values({
        sourceId,
        encryptedPrivateKey,
        publicKey,
        keyMismatch,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /**
   * Flag an EXISTING row as a key mismatch without touching its stored key:
   * the device now reports a different public key than the one we captured, so
   * we refuse to overwrite silently. No-op if no row exists.
   */
  async setKeyMismatch(sourceId: string, mismatch: boolean): Promise<void> {
    const { meshcoreSourcePkiKeys } = this.tables;
    const existing = await this.getBySourceId(sourceId);
    if (!existing) return;
    await this.db
      .update(meshcoreSourcePkiKeys)
      .set({ keyMismatch: mismatch ? 1 : 0, updatedAt: Date.now() })
      .where(eq(meshcoreSourcePkiKeys.sourceId, sourceId));
  }

  /** Delete the stored key for a source. No-op if none exists. */
  async deleteBySourceId(sourceId: string): Promise<void> {
    const { meshcoreSourcePkiKeys } = this.tables;
    await this.db.delete(meshcoreSourcePkiKeys).where(eq(meshcoreSourcePkiKeys.sourceId, sourceId));
  }
}
