/**
 * Channel Database Repository
 *
 * Handles all channel database operations for server-side decryption.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, and, asc, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbChannelDatabase, DbChannelDatabasePermission } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Channel database data for insert/update operations
 */
export interface ChannelDatabaseInput {
  name: string;
  psk: string; // Base64-encoded PSK
  pskLength: number; // 16 for AES-128, 32 for AES-256
  description?: string | null;
  isEnabled?: boolean;
  enforceNameValidation?: boolean;
  createdBy?: number | null;
}

/**
 * Channel database update data
 */
export interface ChannelDatabaseUpdate {
  name?: string;
  psk?: string;
  pskLength?: number;
  description?: string | null;
  isEnabled?: boolean;
  enforceNameValidation?: boolean;
  sortOrder?: number;
}

/**
 * Channel reorder entry
 */
export interface ChannelReorderEntry {
  id: number;
  sortOrder: number;
}

/**
 * Channel database permission input
 */
export interface ChannelDatabasePermissionInput {
  userId: number;
  channelDatabaseId: number;
  canViewOnMap: boolean;
  canRead: boolean;
  grantedBy?: number | null;
}

/**
 * Repository for channel database operations
 */
export class ChannelDatabaseRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ CHANNEL DATABASE METHODS ============

  /**
   * Get a channel database entry by ID
   */
  async getByIdAsync(id: number): Promise<DbChannelDatabase | null> {
    const { channelDatabase } = this.tables;
    const result = await this.db
      .select()
      .from(channelDatabase)
      .where(eq(channelDatabase.id, id))
      .limit(1);

    if (result.length === 0) return null;
    return this.mapToDbChannelDatabase(result[0]);
  }

  /**
   * Get all channel database entries (ordered by sortOrder, then id)
   */
  async getAllAsync(): Promise<DbChannelDatabase[]> {
    const { channelDatabase } = this.tables;
    const results = await this.db
      .select()
      .from(channelDatabase)
      .orderBy(asc(channelDatabase.sortOrder), asc(channelDatabase.id));

    return results.map((r: any) => this.mapToDbChannelDatabase(r));
  }

  /**
   * Get all enabled channel database entries (for decryption, ordered by sortOrder)
   */
  async getEnabledAsync(): Promise<DbChannelDatabase[]> {
    const { channelDatabase } = this.tables;
    const results = await this.db
      .select()
      .from(channelDatabase)
      .where(eq(channelDatabase.isEnabled, true))
      .orderBy(asc(channelDatabase.sortOrder), asc(channelDatabase.id));

    return results.map((r: any) => this.mapToDbChannelDatabase(r));
  }

  /**
   * Create a new channel database entry.
   * Keeps branching: MySQL returns insertId differently, SQLite/Postgres use .returning().
   */
  async createAsync(data: ChannelDatabaseInput, sourceId?: string): Promise<number> {
    const now = this.now();
    const { channelDatabase } = this.tables;
    const values: any = {
      name: data.name,
      psk: data.psk,
      pskLength: data.pskLength,
      description: data.description ?? null,
      isEnabled: data.isEnabled ?? true,
      enforceNameValidation: data.enforceNameValidation ?? false,
      decryptedPacketCount: 0,
      lastDecryptedAt: null,
      createdBy: data.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (sourceId) {
      values.sourceId = sourceId;
    }

    if (this.isMySQL()) {
      // MySQL returns insertId from mysql2
      const db = this.getMysqlDb();
      const result = await db.insert(channelDatabase).values(values);
      return Number(result[0].insertId);
    } else {
      // SQLite and PostgreSQL support .returning()
      const result = await (this.db as any)
        .insert(channelDatabase)
        .values(values)
        .returning({ id: channelDatabase.id });

      const insertId = Number(result[0].id);
      logger.debug(`Created channel database entry: ${data.name} (ID: ${insertId})`);
      return insertId;
    }
  }

  /**
   * Update a channel database entry
   */
  async updateAsync(id: number, data: ChannelDatabaseUpdate): Promise<void> {
    const now = this.now();
    const { channelDatabase } = this.tables;

    await this.db
      .update(channelDatabase)
      .set({
        ...data,
        updatedAt: now,
      })
      .where(eq(channelDatabase.id, id));

    logger.debug(`Updated channel database entry ID: ${id}`);
  }

  /**
   * Delete a channel database entry
   */
  async deleteAsync(id: number): Promise<void> {
    const { channelDatabase } = this.tables;
    await this.db.delete(channelDatabase).where(eq(channelDatabase.id, id));
    logger.debug(`Deleted channel database entry ID: ${id}`);
  }

  /**
   * Increment decrypted packet count for a channel
   */
  async incrementDecryptedCountAsync(id: number): Promise<void> {
    const now = this.now();
    const { channelDatabase } = this.tables;
    // Atomic increment — avoids read-then-write race on concurrent decryptions
    await this.db
      .update(channelDatabase)
      .set({
        decryptedPacketCount: sql`${channelDatabase.decryptedPacketCount} + 1`,
        lastDecryptedAt: now,
      } as any)
      .where(eq(channelDatabase.id, id));
  }

  /**
   * Reorder multiple channel database entries
   * Updates the sortOrder for each entry in the provided array
   */
  async reorderAsync(updates: ChannelReorderEntry[]): Promise<void> {
    const now = this.now();
    const { channelDatabase } = this.tables;

    for (const { id, sortOrder } of updates) {
      await this.db
        .update(channelDatabase)
        .set({ sortOrder, updatedAt: now })
        .where(eq(channelDatabase.id, id));
    }

    logger.debug(`Reordered ${updates.length} channel database entries`);
  }

  // ============ PERMISSION METHODS ============

  /**
   * Get permission for a specific user and channel
   */
  async getPermissionAsync(userId: number, channelDatabaseId: number): Promise<DbChannelDatabasePermission | null> {
    const { channelDatabasePermissions } = this.tables;
    const result = await this.db
      .select()
      .from(channelDatabasePermissions)
      .where(
        and(
          eq(channelDatabasePermissions.userId, userId),
          eq(channelDatabasePermissions.channelDatabaseId, channelDatabaseId)
        )
      )
      .limit(1);

    if (result.length === 0) return null;
    return this.mapToDbChannelDatabasePermission(result[0]);
  }

  /**
   * Get all permissions for a user
   */
  async getPermissionsForUserAsync(userId: number): Promise<DbChannelDatabasePermission[]> {
    const { channelDatabasePermissions } = this.tables;
    const results = await this.db
      .select()
      .from(channelDatabasePermissions)
      .where(eq(channelDatabasePermissions.userId, userId));

    return results.map((r: any) => this.mapToDbChannelDatabasePermission(r));
  }

  /**
   * Get all permissions for a channel
   */
  async getPermissionsForChannelAsync(channelDatabaseId: number): Promise<DbChannelDatabasePermission[]> {
    const { channelDatabasePermissions } = this.tables;
    const results = await this.db
      .select()
      .from(channelDatabasePermissions)
      .where(eq(channelDatabasePermissions.channelDatabaseId, channelDatabaseId));

    return results.map((r: any) => this.mapToDbChannelDatabasePermission(r));
  }

  /**
   * Set permission for a user on a channel (upsert)
   */
  async setPermissionAsync(data: ChannelDatabasePermissionInput): Promise<void> {
    const now = this.now();
    const { channelDatabasePermissions } = this.tables;
    const existing = await this.getPermissionAsync(data.userId, data.channelDatabaseId);

    if (existing) {
      // Update existing permission
      await this.db
        .update(channelDatabasePermissions)
        .set({
          canViewOnMap: data.canViewOnMap,
          canRead: data.canRead,
          grantedBy: data.grantedBy ?? existing.grantedBy,
          grantedAt: now,
        })
        .where(eq(channelDatabasePermissions.id, existing.id!));
    } else {
      // Create new permission
      await this.db.insert(channelDatabasePermissions).values({
        userId: data.userId,
        channelDatabaseId: data.channelDatabaseId,
        canViewOnMap: data.canViewOnMap,
        canRead: data.canRead,
        grantedBy: data.grantedBy ?? null,
        grantedAt: now,
      });
    }

    logger.debug(`Set permission for user ${data.userId} on channel_db ${data.channelDatabaseId}: canViewOnMap=${data.canViewOnMap}, canRead=${data.canRead}`);
  }

  /**
   * Delete permission for a user on a channel
   */
  async deletePermissionAsync(userId: number, channelDatabaseId: number): Promise<void> {
    const { channelDatabasePermissions } = this.tables;
    await this.db
      .delete(channelDatabasePermissions)
      .where(
        and(
          eq(channelDatabasePermissions.userId, userId),
          eq(channelDatabasePermissions.channelDatabaseId, channelDatabaseId)
        )
      );

    logger.debug(`Deleted permission for user ${userId} on channel_db ${channelDatabaseId}`);
  }

  // ============ MAPPING HELPERS ============

  /**
   * Unified mapper for all dialects. Uses normalizeBigInts for BigInt->Number
   * and Boolean() for boolean coercion (handles SQLite 0/1 and MySQL tinyint).
   */
  private mapToDbChannelDatabase(row: any): DbChannelDatabase {
    return this.normalizeBigInts({
      id: row.id,
      name: row.name,
      psk: row.psk,
      pskLength: row.pskLength,
      description: row.description,
      isEnabled: Boolean(row.isEnabled),
      enforceNameValidation: Boolean(row.enforceNameValidation),
      sortOrder: row.sortOrder ?? 0,
      decryptedPacketCount: row.decryptedPacketCount,
      lastDecryptedAt: row.lastDecryptedAt ? Number(row.lastDecryptedAt) : null,
      createdBy: row.createdBy,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      sourceId: row.sourceId ?? null,
    });
  }

  private mapToDbChannelDatabasePermission(row: any): DbChannelDatabasePermission {
    return this.normalizeBigInts({
      id: row.id,
      userId: row.userId,
      channelDatabaseId: row.channelDatabaseId,
      canViewOnMap: Boolean(row.canViewOnMap),
      canRead: Boolean(row.canRead),
      grantedBy: row.grantedBy,
      grantedAt: Number(row.grantedAt),
    });
  }
}
