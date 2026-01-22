/**
 * Auth Repository
 *
 * Handles authentication-related database operations.
 * Includes: users, permissions, sessions, audit_log, api_tokens
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, lt, desc, and } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import {
  usersSqlite, usersPostgres, usersMysql,
  permissionsSqlite, permissionsPostgres, permissionsMysql,
  sessionsSqlite, sessionsPostgres, sessionsMysql,
  auditLogSqlite, auditLogPostgres, auditLogMysql,
  apiTokensSqlite, apiTokensPostgres, apiTokensMysql,
} from '../schema/auth.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

const TOKEN_PREFIX = 'mm_v1_';
const TOKEN_LENGTH = 32; // characters after prefix
const SALT_ROUNDS = 12;

/**
 * User data interface
 */
export interface DbUser {
  id: number;
  username: string;
  passwordHash: string | null;
  email: string | null;
  displayName: string | null;
  authMethod: string;
  oidcSubject: string | null;
  isAdmin: boolean;
  isActive: boolean;
  passwordLocked: boolean | null;
  createdAt: number;
  updatedAt?: number; // PostgreSQL only
  lastLoginAt: number | null;
}

/**
 * Input for creating a user (without id, with required fields)
 */
export interface CreateUserInput {
  username: string;
  passwordHash?: string | null;
  email?: string | null;
  displayName?: string | null;
  authMethod: string;
  oidcSubject?: string | null;
  isAdmin?: boolean;
  isActive?: boolean;
  passwordLocked?: boolean;
  createdAt: number;
  updatedAt?: number; // Required for PostgreSQL, omitted for SQLite
  lastLoginAt?: number | null;
}

/**
 * Input for updating a user
 */
export interface UpdateUserInput {
  username?: string;
  passwordHash?: string | null;
  email?: string | null;
  displayName?: string | null;
  authMethod?: string;
  oidcSubject?: string | null;
  isAdmin?: boolean;
  isActive?: boolean;
  passwordLocked?: boolean;
  updatedAt?: number;
  lastLoginAt?: number | null;
}

/**
 * Permission data interface
 */
export interface DbPermission {
  id: number;
  userId: number;
  resource: string;
  canViewOnMap: boolean;
  canRead: boolean;
  canWrite: boolean;
  canDelete?: boolean; // PostgreSQL only
  grantedAt?: number; // SQLite only
  grantedBy?: number | null; // SQLite only
}

/**
 * Input for creating a permission
 */
export interface CreatePermissionInput {
  userId: number;
  resource: string;
  canViewOnMap?: boolean;
  canRead?: boolean;
  canWrite?: boolean;
  canDelete?: boolean; // PostgreSQL only
  grantedAt?: number; // SQLite only
  grantedBy?: number | null; // SQLite only
}

/**
 * API Token data interface
 */
export interface DbApiToken {
  id: number;
  userId: number;
  name: string;
  tokenHash: string;
  prefix: string;
  isActive: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  createdBy: number | null;
  revokedAt: number | null;
  revokedBy: number | null;
}

/**
 * Input for creating an API token
 */
export interface CreateApiTokenInput {
  userId: number;
  name: string;
  tokenHash: string;
  prefix: string;
  isActive?: boolean;
  createdAt: number;
  lastUsedAt?: number | null;
  expiresAt?: number | null;
  createdBy?: number | null;
}

/**
 * Audit log entry interface
 */
export interface DbAuditLogEntry {
  id?: number;
  userId: number | null;
  username?: string | null;
  action: string;
  resource: string | null;
  details: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: number;
}

/**
 * Repository for authentication operations
 */
export class AuthRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ USERS ============

  /**
   * Get user by ID
   */
  async getUserById(id: number): Promise<DbUser | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, id))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbUser;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(usersMysql)
        .where(eq(usersMysql.id, id))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbUser;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(usersPostgres)
        .where(eq(usersPostgres.id, id))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbUser;
    }
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<DbUser | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.username, username))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbUser;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(usersMysql)
        .where(eq(usersMysql.username, username))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbUser;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(usersPostgres)
        .where(eq(usersPostgres.username, username))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbUser;
    }
  }

  /**
   * Get user by OIDC subject
   */
  async getUserByOidcSubject(oidcSubject: string): Promise<DbUser | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.oidcSubject, oidcSubject))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbUser;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(usersMysql)
        .where(eq(usersMysql.oidcSubject, oidcSubject))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbUser;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(usersPostgres)
        .where(eq(usersPostgres.oidcSubject, oidcSubject))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbUser;
    }
  }

  /**
   * Get all users
   */
  async getAllUsers(): Promise<DbUser[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.select().from(usersSqlite);
      return result.map(u => this.normalizeBigInts(u) as DbUser);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.select().from(usersMysql);
      return result as DbUser[];
    } else {
      const db = this.getPostgresDb();
      const result = await db.select().from(usersPostgres);
      return result as DbUser[];
    }
  }

  /**
   * Create a new user
   */
  async createUser(user: CreateUserInput): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // SQLite doesn't have updatedAt column - remove it from the insert
      const { updatedAt, ...sqliteUser } = user;
      const result = await db.insert(usersSqlite).values(sqliteUser);
      return Number(result.lastInsertRowid);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // MySQL requires updatedAt
      if (!user.updatedAt) {
        user.updatedAt = Date.now();
      }
      const result = await db.insert(usersMysql).values(user as Required<Pick<CreateUserInput, 'updatedAt'>> & CreateUserInput);
      return Number(result[0].insertId);
    } else {
      const db = this.getPostgresDb();
      // PostgreSQL requires updatedAt
      if (!user.updatedAt) {
        user.updatedAt = Date.now();
      }
      const result = await db.insert(usersPostgres).values(user as Required<Pick<CreateUserInput, 'updatedAt'>> & CreateUserInput).returning({ id: usersPostgres.id });
      return result[0].id;
    }
  }

  /**
   * Update user
   */
  async updateUser(id: number, updates: UpdateUserInput): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // SQLite doesn't have updatedAt column - remove it from the update
      const { updatedAt, ...sqliteUpdates } = updates;
      await db.update(usersSqlite).set(sqliteUpdates).where(eq(usersSqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // Auto-set updatedAt for MySQL if not provided
      if (!updates.updatedAt) {
        updates.updatedAt = Date.now();
      }
      await db.update(usersMysql).set(updates).where(eq(usersMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      // Auto-set updatedAt for PostgreSQL if not provided
      if (!updates.updatedAt) {
        updates.updatedAt = Date.now();
      }
      await db.update(usersPostgres).set(updates).where(eq(usersPostgres.id, id));
    }
  }

  /**
   * Delete user
   */
  async deleteUser(id: number): Promise<boolean> {
    const existing = await this.getUserById(id);
    if (!existing) return false;

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(usersSqlite).where(eq(usersSqlite.id, id));
      return true;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(usersMysql).where(eq(usersMysql.id, id));
      return true;
    } else {
      const db = this.getPostgresDb();
      await db.delete(usersPostgres).where(eq(usersPostgres.id, id));
      return true;
    }
  }

  /**
   * Get user count
   */
  async getUserCount(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.select().from(usersSqlite);
      return result.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.select().from(usersMysql);
      return result.length;
    } else {
      const db = this.getPostgresDb();
      const result = await db.select().from(usersPostgres);
      return result.length;
    }
  }

  // ============ PERMISSIONS ============

  /**
   * Get permissions for a user
   */
  async getPermissionsForUser(userId: number): Promise<DbPermission[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(permissionsSqlite)
        .where(eq(permissionsSqlite.userId, userId));
      return result.map(p => this.normalizeBigInts(p) as DbPermission);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(permissionsMysql)
        .where(eq(permissionsMysql.userId, userId));
      return result as DbPermission[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(permissionsPostgres)
        .where(eq(permissionsPostgres.userId, userId));
      return result as DbPermission[];
    }
  }

  /**
   * Create permission
   */
  async createPermission(permission: CreatePermissionInput): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // SQLite requires grantedAt, doesn't have canDelete
      const { canDelete, ...rest } = permission;
      const sqlitePermission = {
        ...rest,
        grantedAt: permission.grantedAt ?? Date.now(),
      };
      const result = await db.insert(permissionsSqlite).values(sqlitePermission);
      return Number(result.lastInsertRowid);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // MySQL doesn't have grantedAt/grantedBy but has canDelete
      const { grantedAt, grantedBy, ...mysqlPermission } = permission;
      const result = await db.insert(permissionsMysql).values(mysqlPermission);
      return Number(result[0].insertId);
    } else {
      const db = this.getPostgresDb();
      // PostgreSQL doesn't have grantedAt/grantedBy
      const { grantedAt, grantedBy, ...postgresPermission } = permission;
      const result = await db.insert(permissionsPostgres).values(postgresPermission).returning({ id: permissionsPostgres.id });
      return result[0].id;
    }
  }

  /**
   * Delete permissions for a user
   */
  async deletePermissionsForUser(userId: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: permissionsSqlite.id })
        .from(permissionsSqlite)
        .where(eq(permissionsSqlite.userId, userId));

      for (const p of toDelete) {
        await db.delete(permissionsSqlite).where(eq(permissionsSqlite.id, p.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: permissionsMysql.id })
        .from(permissionsMysql)
        .where(eq(permissionsMysql.userId, userId));

      for (const p of toDelete) {
        await db.delete(permissionsMysql).where(eq(permissionsMysql.id, p.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: permissionsPostgres.id })
        .from(permissionsPostgres)
        .where(eq(permissionsPostgres.userId, userId));

      for (const p of toDelete) {
        await db.delete(permissionsPostgres).where(eq(permissionsPostgres.id, p.id));
      }
      return toDelete.length;
    }
  }

  // ============ API TOKENS ============

  /**
   * Get API token by hash
   */
  async getApiTokenByHash(tokenHash: string): Promise<DbApiToken | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(apiTokensSqlite)
        .where(eq(apiTokensSqlite.tokenHash, tokenHash))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbApiToken;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(apiTokensMysql)
        .where(eq(apiTokensMysql.tokenHash, tokenHash))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbApiToken;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(apiTokensPostgres)
        .where(eq(apiTokensPostgres.tokenHash, tokenHash))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbApiToken;
    }
  }

  /**
   * Get API tokens for a user
   */
  async getApiTokensForUser(userId: number): Promise<DbApiToken[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(apiTokensSqlite)
        .where(eq(apiTokensSqlite.userId, userId));
      return result.map(t => this.normalizeBigInts(t) as DbApiToken);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(apiTokensMysql)
        .where(eq(apiTokensMysql.userId, userId));
      return result as DbApiToken[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(apiTokensPostgres)
        .where(eq(apiTokensPostgres.userId, userId));
      return result as DbApiToken[];
    }
  }

  /**
   * Create API token
   */
  async createApiToken(token: CreateApiTokenInput): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.insert(apiTokensSqlite).values(token);
      return Number(result.lastInsertRowid);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.insert(apiTokensMysql).values(token);
      return Number(result[0].insertId);
    } else {
      const db = this.getPostgresDb();
      const result = await db.insert(apiTokensPostgres).values(token).returning({ id: apiTokensPostgres.id });
      return result[0].id;
    }
  }

  /**
   * Update API token last used time
   */
  async updateApiTokenLastUsed(id: number): Promise<void> {
    const now = this.now();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.update(apiTokensSqlite).set({ lastUsedAt: now }).where(eq(apiTokensSqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.update(apiTokensMysql).set({ lastUsedAt: now }).where(eq(apiTokensMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db.update(apiTokensPostgres).set({ lastUsedAt: now }).where(eq(apiTokensPostgres.id, id));
    }
  }

  /**
   * Delete API token
   */
  async deleteApiToken(id: number): Promise<boolean> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const existing = await db
        .select({ id: apiTokensSqlite.id })
        .from(apiTokensSqlite)
        .where(eq(apiTokensSqlite.id, id));
      if (existing.length === 0) return false;
      await db.delete(apiTokensSqlite).where(eq(apiTokensSqlite.id, id));
      return true;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const existing = await db
        .select({ id: apiTokensMysql.id })
        .from(apiTokensMysql)
        .where(eq(apiTokensMysql.id, id));
      if (existing.length === 0) return false;
      await db.delete(apiTokensMysql).where(eq(apiTokensMysql.id, id));
      return true;
    } else {
      const db = this.getPostgresDb();
      const existing = await db
        .select({ id: apiTokensPostgres.id })
        .from(apiTokensPostgres)
        .where(eq(apiTokensPostgres.id, id));
      if (existing.length === 0) return false;
      await db.delete(apiTokensPostgres).where(eq(apiTokensPostgres.id, id));
      return true;
    }
  }

  /**
   * Validate an API token and return the user if valid.
   * Also updates lastUsedAt timestamp.
   * @param token The full token string (e.g., "mm_v1_abc123...")
   * @returns The user associated with the token, or null if invalid
   */
  async validateApiToken(token: string): Promise<DbUser | null> {
    // Check if token format is valid
    if (!token || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }

    // Extract prefix (first 12 chars: "mm_v1_" + first 6 chars of random part)
    const prefix = token.substring(0, 12);

    // Find active tokens with matching prefix
    let tokenRecord: { id: number; userId: number; tokenHash: string } | null = null;

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select({
          id: apiTokensSqlite.id,
          userId: apiTokensSqlite.userId,
          tokenHash: apiTokensSqlite.tokenHash,
        })
        .from(apiTokensSqlite)
        .where(and(
          eq(apiTokensSqlite.prefix, prefix),
          eq(apiTokensSqlite.isActive, true)
        ))
        .limit(1);

      if (result.length > 0) {
        tokenRecord = result[0];
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select({
          id: apiTokensMysql.id,
          userId: apiTokensMysql.userId,
          tokenHash: apiTokensMysql.tokenHash,
        })
        .from(apiTokensMysql)
        .where(and(
          eq(apiTokensMysql.prefix, prefix),
          eq(apiTokensMysql.isActive, true)
        ))
        .limit(1);

      if (result.length > 0) {
        tokenRecord = result[0];
      }
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select({
          id: apiTokensPostgres.id,
          userId: apiTokensPostgres.userId,
          tokenHash: apiTokensPostgres.tokenHash,
        })
        .from(apiTokensPostgres)
        .where(and(
          eq(apiTokensPostgres.prefix, prefix),
          eq(apiTokensPostgres.isActive, true)
        ))
        .limit(1);

      if (result.length > 0) {
        tokenRecord = result[0];
      }
    }

    if (!tokenRecord) {
      return null;
    }

    // Verify token hash using bcrypt
    const isValid = await bcrypt.compare(token, tokenRecord.tokenHash);
    if (!isValid) {
      return null;
    }

    // Update lastUsedAt
    await this.updateApiTokenLastUsed(tokenRecord.id);

    // Get and return the user
    return this.getUserById(tokenRecord.userId);
  }

  /**
   * Get a user's active API token info (without sensitive hash)
   */
  async getUserActiveApiToken(userId: number): Promise<{
    id: number;
    prefix: string;
    isActive: boolean;
    createdAt: number;
    lastUsedAt: number | null;
  } | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select({
          id: apiTokensSqlite.id,
          prefix: apiTokensSqlite.prefix,
          isActive: apiTokensSqlite.isActive,
          createdAt: apiTokensSqlite.createdAt,
          lastUsedAt: apiTokensSqlite.lastUsedAt,
        })
        .from(apiTokensSqlite)
        .where(and(
          eq(apiTokensSqlite.userId, userId),
          eq(apiTokensSqlite.isActive, true)
        ))
        .limit(1);

      if (result.length === 0) return null;
      const r = this.normalizeBigInts(result[0]);
      return {
        id: r.id as number,
        prefix: r.prefix as string,
        isActive: Boolean(r.isActive),
        createdAt: r.createdAt as number,
        lastUsedAt: r.lastUsedAt as number | null,
      };
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select({
          id: apiTokensMysql.id,
          prefix: apiTokensMysql.prefix,
          isActive: apiTokensMysql.isActive,
          createdAt: apiTokensMysql.createdAt,
          lastUsedAt: apiTokensMysql.lastUsedAt,
        })
        .from(apiTokensMysql)
        .where(and(
          eq(apiTokensMysql.userId, userId),
          eq(apiTokensMysql.isActive, true)
        ))
        .limit(1);

      if (result.length === 0) return null;
      return {
        id: result[0].id,
        prefix: result[0].prefix,
        isActive: Boolean(result[0].isActive),
        createdAt: result[0].createdAt,
        lastUsedAt: result[0].lastUsedAt,
      };
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select({
          id: apiTokensPostgres.id,
          prefix: apiTokensPostgres.prefix,
          isActive: apiTokensPostgres.isActive,
          createdAt: apiTokensPostgres.createdAt,
          lastUsedAt: apiTokensPostgres.lastUsedAt,
        })
        .from(apiTokensPostgres)
        .where(and(
          eq(apiTokensPostgres.userId, userId),
          eq(apiTokensPostgres.isActive, true)
        ))
        .limit(1);

      if (result.length === 0) return null;
      return {
        id: result[0].id,
        prefix: result[0].prefix,
        isActive: Boolean(result[0].isActive),
        createdAt: result[0].createdAt,
        lastUsedAt: result[0].lastUsedAt,
      };
    }
  }

  /**
   * Revoke an API token by ID
   */
  async revokeApiToken(tokenId: number, revokedBy: number): Promise<boolean> {
    const now = this.now();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .update(apiTokensSqlite)
        .set({ isActive: false, revokedAt: now, revokedBy })
        .where(and(
          eq(apiTokensSqlite.id, tokenId),
          eq(apiTokensSqlite.isActive, true)
        ));
      return (result.changes ?? 0) > 0;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .update(apiTokensMysql)
        .set({ isActive: false, revokedAt: now, revokedBy })
        .where(and(
          eq(apiTokensMysql.id, tokenId),
          eq(apiTokensMysql.isActive, true)
        ));
      return (result[0].affectedRows ?? 0) > 0;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .update(apiTokensPostgres)
        .set({ isActive: false, revokedAt: now, revokedBy })
        .where(and(
          eq(apiTokensPostgres.id, tokenId),
          eq(apiTokensPostgres.isActive, true)
        ))
        .returning({ id: apiTokensPostgres.id });
      return result.length > 0;
    }
  }

  /**
   * Revoke all active API tokens for a user
   */
  async revokeAllUserApiTokens(userId: number, revokedBy: number): Promise<number> {
    const now = this.now();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .update(apiTokensSqlite)
        .set({ isActive: false, revokedAt: now, revokedBy })
        .where(and(
          eq(apiTokensSqlite.userId, userId),
          eq(apiTokensSqlite.isActive, true)
        ));
      return result.changes ?? 0;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .update(apiTokensMysql)
        .set({ isActive: false, revokedAt: now, revokedBy })
        .where(and(
          eq(apiTokensMysql.userId, userId),
          eq(apiTokensMysql.isActive, true)
        ));
      return result[0].affectedRows ?? 0;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .update(apiTokensPostgres)
        .set({ isActive: false, revokedAt: now, revokedBy })
        .where(and(
          eq(apiTokensPostgres.userId, userId),
          eq(apiTokensPostgres.isActive, true)
        ))
        .returning({ id: apiTokensPostgres.id });
      return result.length;
    }
  }

  /**
   * Generate and create a new API token for a user.
   * Automatically revokes any existing active token.
   * Returns the full token (shown once) and token info.
   */
  async generateAndCreateApiToken(userId: number, createdBy: number): Promise<{
    token: string;
    tokenInfo: {
      id: number;
      prefix: string;
      isActive: boolean;
      createdAt: number;
      lastUsedAt: number | null;
    };
  }> {
    // Generate cryptographically secure random token
    const randomBytes = crypto.randomBytes(TOKEN_LENGTH / 2); // 16 bytes = 32 hex chars
    const randomString = randomBytes.toString('hex');
    const token = `${TOKEN_PREFIX}${randomString}`;
    const prefix = token.substring(0, 12); // "mm_v1_" + first 6 chars of random part
    const tokenHash = await bcrypt.hash(token, SALT_ROUNDS);
    const now = this.now();

    // Revoke any existing active tokens for this user
    await this.revokeAllUserApiTokens(userId, createdBy);

    // Create new token
    const tokenId = await this.createApiToken({
      userId,
      name: 'API Token',
      tokenHash,
      prefix,
      isActive: true,
      createdAt: now,
      createdBy,
    });

    return {
      token,
      tokenInfo: {
        id: tokenId,
        prefix,
        isActive: true,
        createdAt: now,
        lastUsedAt: null,
      },
    };
  }

  // ============ AUDIT LOG ============

  /**
   * Create audit log entry
   */
  async createAuditLogEntry(entry: DbAuditLogEntry): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.insert(auditLogSqlite).values({
        userId: entry.userId,
        username: entry.username,
        action: entry.action,
        resource: entry.resource,
        details: entry.details,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        timestamp: entry.timestamp,
      });
      return Number(result.lastInsertRowid);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.insert(auditLogMysql).values({
        userId: entry.userId,
        username: entry.username,
        action: entry.action,
        resource: entry.resource,
        details: entry.details,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        timestamp: entry.timestamp,
      });
      return Number(result[0].insertId);
    } else {
      const db = this.getPostgresDb();
      const result = await db.insert(auditLogPostgres).values({
        userId: entry.userId,
        username: entry.username,
        action: entry.action,
        resource: entry.resource,
        details: entry.details,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        timestamp: entry.timestamp,
      }).returning({ id: auditLogPostgres.id });
      return result[0].id;
    }
  }

  /**
   * Get audit log entries with pagination
   */
  async getAuditLogEntries(limit: number = 100, offset: number = 0): Promise<DbAuditLogEntry[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(auditLogSqlite)
        .orderBy(desc(auditLogSqlite.timestamp))
        .limit(limit)
        .offset(offset);
      return result.map(e => this.normalizeBigInts(e) as DbAuditLogEntry);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(auditLogMysql)
        .orderBy(desc(auditLogMysql.timestamp))
        .limit(limit)
        .offset(offset);
      return result as DbAuditLogEntry[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(auditLogPostgres)
        .orderBy(desc(auditLogPostgres.timestamp))
        .limit(limit)
        .offset(offset);
      return result as DbAuditLogEntry[];
    }
  }

  /**
   * Cleanup old audit log entries
   */
  async cleanupOldAuditLogs(days: number = 90): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: auditLogSqlite.id })
        .from(auditLogSqlite)
        .where(lt(auditLogSqlite.timestamp, cutoff));

      for (const entry of toDelete) {
        await db.delete(auditLogSqlite).where(eq(auditLogSqlite.id, entry.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: auditLogMysql.id })
        .from(auditLogMysql)
        .where(lt(auditLogMysql.timestamp, cutoff));

      for (const entry of toDelete) {
        await db.delete(auditLogMysql).where(eq(auditLogMysql.id, entry.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: auditLogPostgres.id })
        .from(auditLogPostgres)
        .where(lt(auditLogPostgres.timestamp, cutoff));

      for (const entry of toDelete) {
        await db.delete(auditLogPostgres).where(eq(auditLogPostgres.id, entry.id));
      }
      return toDelete.length;
    }
  }

  // ============ SESSIONS ============

  /**
   * Get session by SID
   */
  async getSession(sid: string): Promise<{ sid: string; sess: string; expire: number } | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(sessionsSqlite)
        .where(eq(sessionsSqlite.sid, sid))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as { sid: string; sess: string; expire: number };
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(sessionsMysql)
        .where(eq(sessionsMysql.sid, sid))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as { sid: string; sess: string; expire: number };
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(sessionsPostgres)
        .where(eq(sessionsPostgres.sid, sid))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as { sid: string; sess: string; expire: number };
    }
  }

  /**
   * Set session (upsert)
   */
  async setSession(sid: string, sess: string, expire: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .insert(sessionsSqlite)
        .values({ sid, sess, expire })
        .onConflictDoUpdate({
          target: sessionsSqlite.sid,
          set: { sess, expire },
        });
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .insert(sessionsMysql)
        .values({ sid, sess, expire })
        .onDuplicateKeyUpdate({
          set: { sess, expire },
        });
    } else {
      const db = this.getPostgresDb();
      await db
        .insert(sessionsPostgres)
        .values({ sid, sess, expire })
        .onConflictDoUpdate({
          target: sessionsPostgres.sid,
          set: { sess, expire },
        });
    }
  }

  /**
   * Delete session
   */
  async deleteSession(sid: string): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(sessionsSqlite).where(eq(sessionsSqlite.sid, sid));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(sessionsMysql).where(eq(sessionsMysql.sid, sid));
    } else {
      const db = this.getPostgresDb();
      await db.delete(sessionsPostgres).where(eq(sessionsPostgres.sid, sid));
    }
  }

  /**
   * Cleanup expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ sid: sessionsSqlite.sid })
        .from(sessionsSqlite)
        .where(lt(sessionsSqlite.expire, now));

      for (const session of toDelete) {
        await db.delete(sessionsSqlite).where(eq(sessionsSqlite.sid, session.sid));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ sid: sessionsMysql.sid })
        .from(sessionsMysql)
        .where(lt(sessionsMysql.expire, now));

      for (const session of toDelete) {
        await db.delete(sessionsMysql).where(eq(sessionsMysql.sid, session.sid));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ sid: sessionsPostgres.sid })
        .from(sessionsPostgres)
        .where(lt(sessionsPostgres.expire, now));

      for (const session of toDelete) {
        await db.delete(sessionsPostgres).where(eq(sessionsPostgres.sid, session.sid));
      }
      return toDelete.length;
    }
  }
}
