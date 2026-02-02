/**
 * Channel Database Repository
 *
 * Handles all channel database operations for server-side decryption.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, and, desc } from 'drizzle-orm';
import {
  channelDatabaseSqlite,
  channelDatabasePostgres,
  channelDatabaseMysql,
  channelDatabasePermissionsSqlite,
  channelDatabasePermissionsPostgres,
  channelDatabasePermissionsMysql,
} from '../schema/channelDatabase.js';
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
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(channelDatabaseSqlite)
        .where(eq(channelDatabaseSqlite.id, id))
        .limit(1);

      if (result.length === 0) return null;
      return this.mapSqliteToDbChannelDatabase(result[0]);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(channelDatabaseMysql)
        .where(eq(channelDatabaseMysql.id, id))
        .limit(1);

      if (result.length === 0) return null;
      return this.mapMysqlToDbChannelDatabase(result[0]);
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(channelDatabasePostgres)
        .where(eq(channelDatabasePostgres.id, id))
        .limit(1);

      if (result.length === 0) return null;
      return this.mapPostgresToDbChannelDatabase(result[0]);
    }
  }

  /**
   * Get all channel database entries
   */
  async getAllAsync(): Promise<DbChannelDatabase[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(channelDatabaseSqlite)
        .orderBy(desc(channelDatabaseSqlite.createdAt));

      return results.map(r => this.mapSqliteToDbChannelDatabase(r));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(channelDatabaseMysql)
        .orderBy(desc(channelDatabaseMysql.createdAt));

      return results.map(r => this.mapMysqlToDbChannelDatabase(r));
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(channelDatabasePostgres)
        .orderBy(desc(channelDatabasePostgres.createdAt));

      return results.map(r => this.mapPostgresToDbChannelDatabase(r));
    }
  }

  /**
   * Get all enabled channel database entries (for decryption)
   */
  async getEnabledAsync(): Promise<DbChannelDatabase[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(channelDatabaseSqlite)
        .where(eq(channelDatabaseSqlite.isEnabled, true));

      return results.map(r => this.mapSqliteToDbChannelDatabase(r));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(channelDatabaseMysql)
        .where(eq(channelDatabaseMysql.isEnabled, true));

      return results.map(r => this.mapMysqlToDbChannelDatabase(r));
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(channelDatabasePostgres)
        .where(eq(channelDatabasePostgres.isEnabled, true));

      return results.map(r => this.mapPostgresToDbChannelDatabase(r));
    }
  }

  /**
   * Create a new channel database entry
   */
  async createAsync(data: ChannelDatabaseInput): Promise<number> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.insert(channelDatabaseSqlite).values({
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
      }).returning({ id: channelDatabaseSqlite.id });

      const insertId = Number(result[0].id);
      logger.debug(`Created channel database entry: ${data.name} (ID: ${insertId})`);
      return insertId;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.insert(channelDatabaseMysql).values({
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
      });

      // MySQL returns insertId from mysql2
      return Number(result[0].insertId);
    } else {
      const db = this.getPostgresDb();
      const result = await db.insert(channelDatabasePostgres).values({
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
      }).returning({ id: channelDatabasePostgres.id });

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

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(channelDatabaseSqlite)
        .set({
          ...data,
          updatedAt: now,
        })
        .where(eq(channelDatabaseSqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(channelDatabaseMysql)
        .set({
          ...data,
          updatedAt: now,
        })
        .where(eq(channelDatabaseMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(channelDatabasePostgres)
        .set({
          ...data,
          updatedAt: now,
        })
        .where(eq(channelDatabasePostgres.id, id));
    }

    logger.debug(`Updated channel database entry ID: ${id}`);
  }

  /**
   * Delete a channel database entry
   */
  async deleteAsync(id: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(channelDatabaseSqlite).where(eq(channelDatabaseSqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(channelDatabaseMysql).where(eq(channelDatabaseMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db.delete(channelDatabasePostgres).where(eq(channelDatabasePostgres.id, id));
    }

    logger.debug(`Deleted channel database entry ID: ${id}`);
  }

  /**
   * Increment decrypted packet count for a channel
   */
  async incrementDecryptedCountAsync(id: number): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const current = await this.getByIdAsync(id);
      if (current) {
        await db
          .update(channelDatabaseSqlite)
          .set({
            decryptedPacketCount: current.decryptedPacketCount + 1,
            lastDecryptedAt: now,
          })
          .where(eq(channelDatabaseSqlite.id, id));
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const current = await this.getByIdAsync(id);
      if (current) {
        await db
          .update(channelDatabaseMysql)
          .set({
            decryptedPacketCount: current.decryptedPacketCount + 1,
            lastDecryptedAt: now,
          })
          .where(eq(channelDatabaseMysql.id, id));
      }
    } else {
      const db = this.getPostgresDb();
      const current = await this.getByIdAsync(id);
      if (current) {
        await db
          .update(channelDatabasePostgres)
          .set({
            decryptedPacketCount: current.decryptedPacketCount + 1,
            lastDecryptedAt: now,
          })
          .where(eq(channelDatabasePostgres.id, id));
      }
    }
  }

  // ============ PERMISSION METHODS ============

  /**
   * Get permission for a specific user and channel
   */
  async getPermissionAsync(userId: number, channelDatabaseId: number): Promise<DbChannelDatabasePermission | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(channelDatabasePermissionsSqlite)
        .where(
          and(
            eq(channelDatabasePermissionsSqlite.userId, userId),
            eq(channelDatabasePermissionsSqlite.channelDatabaseId, channelDatabaseId)
          )
        )
        .limit(1);

      if (result.length === 0) return null;
      return this.mapSqliteToDbChannelDatabasePermission(result[0]);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(channelDatabasePermissionsMysql)
        .where(
          and(
            eq(channelDatabasePermissionsMysql.userId, userId),
            eq(channelDatabasePermissionsMysql.channelDatabaseId, channelDatabaseId)
          )
        )
        .limit(1);

      if (result.length === 0) return null;
      return this.mapMysqlToDbChannelDatabasePermission(result[0]);
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(channelDatabasePermissionsPostgres)
        .where(
          and(
            eq(channelDatabasePermissionsPostgres.userId, userId),
            eq(channelDatabasePermissionsPostgres.channelDatabaseId, channelDatabaseId)
          )
        )
        .limit(1);

      if (result.length === 0) return null;
      return this.mapPostgresToDbChannelDatabasePermission(result[0]);
    }
  }

  /**
   * Get all permissions for a user
   */
  async getPermissionsForUserAsync(userId: number): Promise<DbChannelDatabasePermission[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(channelDatabasePermissionsSqlite)
        .where(eq(channelDatabasePermissionsSqlite.userId, userId));

      return results.map(r => this.mapSqliteToDbChannelDatabasePermission(r));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(channelDatabasePermissionsMysql)
        .where(eq(channelDatabasePermissionsMysql.userId, userId));

      return results.map(r => this.mapMysqlToDbChannelDatabasePermission(r));
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(channelDatabasePermissionsPostgres)
        .where(eq(channelDatabasePermissionsPostgres.userId, userId));

      return results.map(r => this.mapPostgresToDbChannelDatabasePermission(r));
    }
  }

  /**
   * Get all permissions for a channel
   */
  async getPermissionsForChannelAsync(channelDatabaseId: number): Promise<DbChannelDatabasePermission[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(channelDatabasePermissionsSqlite)
        .where(eq(channelDatabasePermissionsSqlite.channelDatabaseId, channelDatabaseId));

      return results.map(r => this.mapSqliteToDbChannelDatabasePermission(r));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(channelDatabasePermissionsMysql)
        .where(eq(channelDatabasePermissionsMysql.channelDatabaseId, channelDatabaseId));

      return results.map(r => this.mapMysqlToDbChannelDatabasePermission(r));
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(channelDatabasePermissionsPostgres)
        .where(eq(channelDatabasePermissionsPostgres.channelDatabaseId, channelDatabaseId));

      return results.map(r => this.mapPostgresToDbChannelDatabasePermission(r));
    }
  }

  /**
   * Set permission for a user on a channel (upsert)
   */
  async setPermissionAsync(data: ChannelDatabasePermissionInput): Promise<void> {
    const now = this.now();
    const existing = await this.getPermissionAsync(data.userId, data.channelDatabaseId);

    if (existing) {
      // Update existing permission
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        await db
          .update(channelDatabasePermissionsSqlite)
          .set({
            canViewOnMap: data.canViewOnMap,
            canRead: data.canRead,
            grantedBy: data.grantedBy ?? existing.grantedBy,
            grantedAt: now,
          })
          .where(eq(channelDatabasePermissionsSqlite.id, existing.id!));
      } else if (this.isMySQL()) {
        const db = this.getMysqlDb();
        await db
          .update(channelDatabasePermissionsMysql)
          .set({
            canViewOnMap: data.canViewOnMap,
            canRead: data.canRead,
            grantedBy: data.grantedBy ?? existing.grantedBy,
            grantedAt: now,
          })
          .where(eq(channelDatabasePermissionsMysql.id, existing.id!));
      } else {
        const db = this.getPostgresDb();
        await db
          .update(channelDatabasePermissionsPostgres)
          .set({
            canViewOnMap: data.canViewOnMap,
            canRead: data.canRead,
            grantedBy: data.grantedBy ?? existing.grantedBy,
            grantedAt: now,
          })
          .where(eq(channelDatabasePermissionsPostgres.id, existing.id!));
      }
    } else {
      // Create new permission
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        await db.insert(channelDatabasePermissionsSqlite).values({
          userId: data.userId,
          channelDatabaseId: data.channelDatabaseId,
          canViewOnMap: data.canViewOnMap,
          canRead: data.canRead,
          grantedBy: data.grantedBy ?? null,
          grantedAt: now,
        });
      } else if (this.isMySQL()) {
        const db = this.getMysqlDb();
        await db.insert(channelDatabasePermissionsMysql).values({
          userId: data.userId,
          channelDatabaseId: data.channelDatabaseId,
          canViewOnMap: data.canViewOnMap,
          canRead: data.canRead,
          grantedBy: data.grantedBy ?? null,
          grantedAt: now,
        });
      } else {
        const db = this.getPostgresDb();
        await db.insert(channelDatabasePermissionsPostgres).values({
          userId: data.userId,
          channelDatabaseId: data.channelDatabaseId,
          canViewOnMap: data.canViewOnMap,
          canRead: data.canRead,
          grantedBy: data.grantedBy ?? null,
          grantedAt: now,
        });
      }
    }

    logger.debug(`Set permission for user ${data.userId} on channel_db ${data.channelDatabaseId}: canViewOnMap=${data.canViewOnMap}, canRead=${data.canRead}`);
  }

  /**
   * Delete permission for a user on a channel
   */
  async deletePermissionAsync(userId: number, channelDatabaseId: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .delete(channelDatabasePermissionsSqlite)
        .where(
          and(
            eq(channelDatabasePermissionsSqlite.userId, userId),
            eq(channelDatabasePermissionsSqlite.channelDatabaseId, channelDatabaseId)
          )
        );
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .delete(channelDatabasePermissionsMysql)
        .where(
          and(
            eq(channelDatabasePermissionsMysql.userId, userId),
            eq(channelDatabasePermissionsMysql.channelDatabaseId, channelDatabaseId)
          )
        );
    } else {
      const db = this.getPostgresDb();
      await db
        .delete(channelDatabasePermissionsPostgres)
        .where(
          and(
            eq(channelDatabasePermissionsPostgres.userId, userId),
            eq(channelDatabasePermissionsPostgres.channelDatabaseId, channelDatabaseId)
          )
        );
    }

    logger.debug(`Deleted permission for user ${userId} on channel_db ${channelDatabaseId}`);
  }

  // ============ MAPPING HELPERS ============

  private mapSqliteToDbChannelDatabase(row: any): DbChannelDatabase {
    return this.normalizeBigInts({
      id: row.id,
      name: row.name,
      psk: row.psk,
      pskLength: row.pskLength,
      description: row.description,
      isEnabled: Boolean(row.isEnabled),
      enforceNameValidation: Boolean(row.enforceNameValidation),
      decryptedPacketCount: row.decryptedPacketCount,
      lastDecryptedAt: row.lastDecryptedAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private mapPostgresToDbChannelDatabase(row: any): DbChannelDatabase {
    return {
      id: row.id,
      name: row.name,
      psk: row.psk,
      pskLength: row.pskLength,
      description: row.description,
      isEnabled: row.isEnabled,
      enforceNameValidation: row.enforceNameValidation,
      decryptedPacketCount: row.decryptedPacketCount,
      lastDecryptedAt: row.lastDecryptedAt ? Number(row.lastDecryptedAt) : null,
      createdBy: row.createdBy,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private mapMysqlToDbChannelDatabase(row: any): DbChannelDatabase {
    return {
      id: row.id,
      name: row.name,
      psk: row.psk,
      pskLength: row.pskLength,
      description: row.description,
      isEnabled: Boolean(row.isEnabled),
      enforceNameValidation: Boolean(row.enforceNameValidation),
      decryptedPacketCount: row.decryptedPacketCount,
      lastDecryptedAt: row.lastDecryptedAt ? Number(row.lastDecryptedAt) : null,
      createdBy: row.createdBy,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private mapSqliteToDbChannelDatabasePermission(row: any): DbChannelDatabasePermission {
    return this.normalizeBigInts({
      id: row.id,
      userId: row.userId,
      channelDatabaseId: row.channelDatabaseId,
      canViewOnMap: Boolean(row.canViewOnMap),
      canRead: Boolean(row.canRead),
      grantedBy: row.grantedBy,
      grantedAt: row.grantedAt,
    });
  }

  private mapPostgresToDbChannelDatabasePermission(row: any): DbChannelDatabasePermission {
    return {
      id: row.id,
      userId: row.userId,
      channelDatabaseId: row.channelDatabaseId,
      canViewOnMap: row.canViewOnMap,
      canRead: row.canRead,
      grantedBy: row.grantedBy,
      grantedAt: Number(row.grantedAt),
    };
  }

  private mapMysqlToDbChannelDatabasePermission(row: any): DbChannelDatabasePermission {
    return {
      id: row.id,
      userId: row.userId,
      channelDatabaseId: row.channelDatabaseId,
      canViewOnMap: Boolean(row.canViewOnMap),
      canRead: Boolean(row.canRead),
      grantedBy: row.grantedBy,
      grantedAt: Number(row.grantedAt),
    };
  }
}
