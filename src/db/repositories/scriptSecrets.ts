/**
 * Repository for `script_secrets` — global named values handed to user
 * scripts as environment variables.
 *
 * Stores only the encrypted value envelope (see `scriptSecretStore`); callers
 * never put a plain value through here. One row per name. Global by design:
 * there is no sourceId.
 */
import { eq, count } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbScriptSecret {
  name: string;
  encryptedValue: string;
  createdAt: number;
  updatedAt: number;
}

/** A row without anything a caller could show as the value. */
export interface ScriptSecretMetadataRow {
  name: string;
  updatedAt: number;
}

export class ScriptSecretsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Every row, envelope included. For the store's cache load and status checks only. */
  async getAll(): Promise<DbScriptSecret[]> {
    const { scriptSecrets } = this.tables;
    const rows = await this.db.select().from(scriptSecrets).orderBy(scriptSecrets.name);
    return (rows as DbScriptSecret[]).map((r) => ({
      name: r.name,
      encryptedValue: r.encryptedValue,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    }));
  }

  /** Names and timestamps only — never the envelope. */
  async listMetadata(): Promise<ScriptSecretMetadataRow[]> {
    const { scriptSecrets } = this.tables;
    const rows = await this.db
      .select({ name: scriptSecrets.name, updatedAt: scriptSecrets.updatedAt })
      .from(scriptSecrets)
      .orderBy(scriptSecrets.name);
    return (rows as ScriptSecretMetadataRow[]).map((r) => ({ name: r.name, updatedAt: Number(r.updatedAt) }));
  }

  async exists(name: string): Promise<boolean> {
    const { scriptSecrets } = this.tables;
    const rows = await this.db
      .select({ name: scriptSecrets.name })
      .from(scriptSecrets)
      .where(eq(scriptSecrets.name, name))
      .limit(1);
    return rows.length > 0;
  }

  async count(): Promise<number> {
    const { scriptSecrets } = this.tables;
    const rows = await this.db.select({ n: count() }).from(scriptSecrets);
    return Number((rows as Array<{ n: number | string }>)[0]?.n ?? 0);
  }

  /**
   * Insert or replace the envelope for `name`. Returns whether a new row was
   * created and the `updatedAt` written.
   */
  async upsert(name: string, encryptedValue: string): Promise<{ created: boolean; updatedAt: number }> {
    if (!name) throw new Error('ScriptSecretsRepository.upsert requires a name');
    const { scriptSecrets } = this.tables;
    const now = Date.now();
    if (await this.exists(name)) {
      await this.db
        .update(scriptSecrets)
        .set({ encryptedValue, updatedAt: now })
        .where(eq(scriptSecrets.name, name));
      return { created: false, updatedAt: now };
    }
    await this.db.insert(scriptSecrets).values({ name, encryptedValue, createdAt: now, updatedAt: now });
    return { created: true, updatedAt: now };
  }

  /** Delete one secret. Returns false when no row had that name. */
  async delete(name: string): Promise<boolean> {
    if (!(await this.exists(name))) return false;
    const { scriptSecrets } = this.tables;
    await this.db.delete(scriptSecrets).where(eq(scriptSecrets.name, name));
    return true;
  }
}
