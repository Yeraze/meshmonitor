/**
 * Repository for `meshcore_observer_credentials` — per-source static MQTT
 * broker credentials for the MeshCore Analyzer Observer (issue #4595).
 *
 * Stores only the encrypted password envelope (see
 * `meshcoreObserverCredentialStore`); callers never put a raw password
 * through here. One row per source.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbMeshCoreObserverCredential {
  sourceId: string;
  username: string;
  encryptedPassword: string;
  createdAt: number;
  updatedAt: number;
}

export class MeshCoreObserverCredentialsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Get the stored (encrypted) credential row for a source, or null. */
  async getBySourceId(sourceId: string): Promise<DbMeshCoreObserverCredential | null> {
    const { meshcoreObserverCredentials } = this.tables;
    const rows = await this.db
      .select()
      .from(meshcoreObserverCredentials)
      .where(eq(meshcoreObserverCredentials.sourceId, sourceId))
      .limit(1);
    return (rows[0] as DbMeshCoreObserverCredential) ?? null;
  }

  /**
   * Insert or replace the credentials for a source. `encryptedPassword` is
   * the AES-256-GCM envelope JSON, never a raw password.
   */
  async upsert(sourceId: string, username: string, encryptedPassword: string): Promise<void> {
    if (!sourceId) throw new Error('MeshCoreObserverCredentialsRepository.upsert requires a sourceId');
    const { meshcoreObserverCredentials } = this.tables;
    const now = Date.now();
    const existing = await this.getBySourceId(sourceId);
    if (existing) {
      await this.db
        .update(meshcoreObserverCredentials)
        .set({ username, encryptedPassword, updatedAt: now })
        .where(eq(meshcoreObserverCredentials.sourceId, sourceId));
    } else {
      await this.db.insert(meshcoreObserverCredentials).values({
        sourceId,
        username,
        encryptedPassword,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /** Delete the stored credentials for a source. No-op if none exists. */
  async deleteBySourceId(sourceId: string): Promise<void> {
    const { meshcoreObserverCredentials } = this.tables;
    await this.db.delete(meshcoreObserverCredentials).where(eq(meshcoreObserverCredentials.sourceId, sourceId));
  }
}
