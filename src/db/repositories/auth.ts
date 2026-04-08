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
  usersPostgres,
  permissionsPostgres,
  auditLogPostgres,
  apiTokensPostgres,
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
  mfaEnabled: boolean;
  mfaSecret: string | null;
  mfaBackupCodes: string | null;
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
  mfaEnabled?: boolean;
  mfaSecret?: string | null;
  mfaBackupCodes?: string | null;
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
  canDelete?: boolean; // PostgreSQL/MySQL only
  grantedAt?: number;
  grantedBy?: number | null;
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
  canDelete?: boolean; // PostgreSQL/MySQL only
  grantedAt?: number;
  grantedBy?: number | null;
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
    const { users } = this.tables;
    const result = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbUser;
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<DbUser | null> {
    const { users } = this.tables;
    const result = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbUser;
  }

  /**
   * Get user by OIDC subject
   */
  async getUserByOidcSubject(oidcSubject: string): Promise<DbUser | null> {
    const { users } = this.tables;
    const result = await this.db
      .select()
      .from(users)
      .where(eq(users.oidcSubject, oidcSubject))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbUser;
  }

  /**
   * Get user by email
   * Note: Email is NOT unique in the schema. If multiple users share the same email,
   * returns the first match.
   */
  async getUserByEmail(email: string): Promise<DbUser | null> {
    const { users } = this.tables;
    const result = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbUser;
  }

  /**
   * Get all users
   */
  async getAllUsers(): Promise<DbUser[]> {
    const { users } = this.tables;
    const result = await this.db.select().from(users);
    return this.normalizeBigInts(result) as DbUser[];
  }

  /**
   * Create a new user.
   * Keeps branching: SQLite lacks updatedAt column, different insertId patterns.
   */
  async createUser(user: CreateUserInput): Promise<number> {
    const { users } = this.tables;
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // SQLite doesn't have updatedAt column - remove it from the insert
      const { updatedAt, ...sqliteUser } = user;
      const result = await db.insert(users).values(sqliteUser);
      return Number(result.lastInsertRowid);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // MySQL requires updatedAt
      if (!user.updatedAt) {
        user.updatedAt = Date.now();
      }
      const result = await db.insert(users).values(user as Required<Pick<CreateUserInput, 'updatedAt'>> & CreateUserInput);
      return Number(result[0].insertId);
    } else {
      const db = this.getPostgresDb();
      // PostgreSQL requires updatedAt
      if (!user.updatedAt) {
        user.updatedAt = Date.now();
      }
      const result = await db.insert(users).values(user as Required<Pick<CreateUserInput, 'updatedAt'>> & CreateUserInput).returning({ id: usersPostgres.id });
      return result[0].id;
    }
  }

  /**
   * Update user.
   * Keeps branching: SQLite lacks updatedAt column.
   */
  async updateUser(id: number, updates: UpdateUserInput): Promise<void> {
    const { users } = this.tables;
    if (this.isSQLite()) {
      // SQLite doesn't have updatedAt column - remove it from the update
      const { updatedAt, ...sqliteUpdates } = updates;
      await this.db.update(users).set(sqliteUpdates).where(eq(users.id, id));
    } else {
      // Auto-set updatedAt for MySQL/PostgreSQL if not provided
      if (!updates.updatedAt) {
        updates.updatedAt = Date.now();
      }
      await this.db.update(users).set(updates).where(eq(users.id, id));
    }
  }

  /**
   * Delete user
   */
  async deleteUser(id: number): Promise<boolean> {
    const existing = await this.getUserById(id);
    if (!existing) return false;

    const { users } = this.tables;
    await this.db.delete(users).where(eq(users.id, id));
    return true;
  }

  /**
   * Get user count
   */
  async getUserCount(): Promise<number> {
    const { users } = this.tables;
    const result = await this.db.select().from(users);
    return result.length;
  }

  // ============ PERMISSIONS ============

  /**
   * Get permissions for a user
   */
  async getPermissionsForUser(userId: number): Promise<DbPermission[]> {
    const { permissions } = this.tables;
    const result = await this.db
      .select()
      .from(permissions)
      .where(eq(permissions.userId, userId));
    return this.normalizeBigInts(result) as DbPermission[];
  }

  /**
   * Create permission.
   * Keeps branching: SQLite doesn't have canDelete, PG/MySQL do.
   * All backends now support grantedAt/grantedBy.
   */
  async createPermission(permission: CreatePermissionInput): Promise<number> {
    const { permissions } = this.tables;
    const permissionWithGrantedAt = {
      ...permission,
      grantedAt: permission.grantedAt ?? Date.now(),
    };
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // SQLite doesn't have canDelete
      const { canDelete, ...rest } = permissionWithGrantedAt;
      const result = await db.insert(permissions).values(rest);
      return Number(result.lastInsertRowid);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.insert(permissions).values(permissionWithGrantedAt);
      return Number(result[0].insertId);
    } else {
      const db = this.getPostgresDb();
      const result = await db.insert(permissions).values(permissionWithGrantedAt).returning({ id: permissionsPostgres.id });
      return result[0].id;
    }
  }

  /**
   * Delete permissions for a user
   */
  async deletePermissionsForUser(userId: number): Promise<number> {
    const { permissions } = this.tables;
    const toDelete = await this.db
      .select({ id: permissions.id })
      .from(permissions)
      .where(eq(permissions.userId, userId));

    for (const p of toDelete) {
      await this.db.delete(permissions).where(eq(permissions.id, p.id));
    }
    return toDelete.length;
  }

  // ============ API TOKENS ============

  /**
   * Get API token by hash
   */
  async getApiTokenByHash(tokenHash: string): Promise<DbApiToken | null> {
    const { apiTokens } = this.tables;
    const result = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, tokenHash))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbApiToken;
  }

  /**
   * Get API tokens for a user
   */
  async getApiTokensForUser(userId: number): Promise<DbApiToken[]> {
    const { apiTokens } = this.tables;
    const result = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId));
    return this.normalizeBigInts(result) as DbApiToken[];
  }

  /**
   * Create API token.
   * Keeps branching: different insertId access patterns per dialect.
   */
  async createApiToken(token: CreateApiTokenInput): Promise<number> {
    const { apiTokens } = this.tables;
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.insert(apiTokens).values(token);
      return Number(result.lastInsertRowid);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.insert(apiTokens).values(token);
      return Number(result[0].insertId);
    } else {
      const db = this.getPostgresDb();
      const result = await db.insert(apiTokens).values(token).returning({ id: apiTokensPostgres.id });
      return result[0].id;
    }
  }

  /**
   * Update API token last used time
   */
  async updateApiTokenLastUsed(id: number): Promise<void> {
    const now = this.now();
    const { apiTokens } = this.tables;
    await this.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, id));
  }

  /**
   * Delete API token
   */
  async deleteApiToken(id: number): Promise<boolean> {
    const { apiTokens } = this.tables;
    const existing = await this.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(eq(apiTokens.id, id));
    if (existing.length === 0) return false;
    await this.db.delete(apiTokens).where(eq(apiTokens.id, id));
    return true;
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
    const { apiTokens } = this.tables;

    // Find active tokens with matching prefix
    const result = await this.db
      .select({
        id: apiTokens.id,
        userId: apiTokens.userId,
        tokenHash: apiTokens.tokenHash,
      })
      .from(apiTokens)
      .where(and(
        eq(apiTokens.prefix, prefix),
        eq(apiTokens.isActive, true)
      ))
      .limit(1);

    let tokenRecord: { id: number; userId: number; tokenHash: string } | null = null;
    if (result.length > 0) {
      tokenRecord = result[0];
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
    const { apiTokens } = this.tables;
    const result = await this.db
      .select({
        id: apiTokens.id,
        prefix: apiTokens.prefix,
        isActive: apiTokens.isActive,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
      })
      .from(apiTokens)
      .where(and(
        eq(apiTokens.userId, userId),
        eq(apiTokens.isActive, true)
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
  }

  /**
   * Revoke an API token by ID.
   * Keeps branching: different result shapes for affected row count.
   */
  async revokeApiToken(tokenId: number, revokedBy: number): Promise<boolean> {
    const now = this.now();
    const { apiTokens } = this.tables;
    const result = await this.db
      .update(apiTokens)
      .set({ isActive: false, revokedAt: now, revokedBy })
      .where(and(
        eq(apiTokens.id, tokenId),
        eq(apiTokens.isActive, true)
      ));
    return this.getAffectedRows(result) > 0;
  }

  /**
   * Revoke all active API tokens for a user.
   */
  async revokeAllUserApiTokens(userId: number, revokedBy: number): Promise<number> {
    const now = this.now();
    const { apiTokens } = this.tables;
    const result = await this.db
      .update(apiTokens)
      .set({ isActive: false, revokedAt: now, revokedBy })
      .where(and(
        eq(apiTokens.userId, userId),
        eq(apiTokens.isActive, true)
      ));
    return this.getAffectedRows(result);
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
   * Create audit log entry.
   * Keeps branching: different insertId access patterns per dialect.
   */
  async createAuditLogEntry(entry: DbAuditLogEntry): Promise<number> {
    const { auditLog } = this.tables;
    const values = {
      userId: entry.userId,
      username: entry.username,
      action: entry.action,
      resource: entry.resource,
      details: entry.details,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      timestamp: entry.timestamp,
    };

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.insert(auditLog).values(values);
      return Number(result.lastInsertRowid);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.insert(auditLog).values(values);
      return Number(result[0].insertId);
    } else {
      const db = this.getPostgresDb();
      const result = await db.insert(auditLog).values(values).returning({ id: auditLogPostgres.id });
      return result[0].id;
    }
  }

  /**
   * Get audit log entries with pagination
   */
  async getAuditLogEntries(limit: number = 100, offset: number = 0): Promise<DbAuditLogEntry[]> {
    const { auditLog } = this.tables;
    const result = await this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.timestamp))
      .limit(limit)
      .offset(offset);
    return this.normalizeBigInts(result) as DbAuditLogEntry[];
  }

  /**
   * Cleanup old audit log entries
   */
  async cleanupOldAuditLogs(days: number = 90): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);
    const { auditLog } = this.tables;

    const toDelete = await this.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(lt(auditLog.timestamp, cutoff));

    for (const entry of toDelete) {
      await this.db.delete(auditLog).where(eq(auditLog.id, entry.id));
    }
    return toDelete.length;
  }

  // ============ SESSIONS ============

  /**
   * Get session by SID
   */
  async getSession(sid: string): Promise<{ sid: string; sess: string; expire: number } | null> {
    const { sessions } = this.tables;
    const result = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.sid, sid))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as { sid: string; sess: string; expire: number };
  }

  /**
   * Set session (upsert).
   */
  async setSession(sid: string, sess: string, expire: number): Promise<void> {
    const { sessions } = this.tables;
    await this.upsert(sessions, { sid, sess, expire }, sessions.sid, { sess, expire });
  }

  /**
   * Delete session
   */
  async deleteSession(sid: string): Promise<void> {
    const { sessions } = this.tables;
    await this.db.delete(sessions).where(eq(sessions.sid, sid));
  }

  /**
   * Cleanup expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    const now = this.now();
    const { sessions } = this.tables;

    const toDelete = await this.db
      .select({ sid: sessions.sid })
      .from(sessions)
      .where(lt(sessions.expire, now));

    for (const session of toDelete) {
      await this.db.delete(sessions).where(eq(sessions.sid, session.sid));
    }
    return toDelete.length;
  }

  /**
   * Migrate channel permissions when channels are moved between slots.
   * Uses the same swap/move pattern as message migration.
   */
  async migratePermissionsForChannelMoves(moves: { from: number; to: number }[]): Promise<void> {
    if (moves.length === 0) return;

    const { permissions } = this.tables;

    // Detect swap pairs
    const swapPairs = new Set<string>();
    for (const move of moves) {
      const reverse = moves.find(m => m.from === move.to && m.to === move.from);
      if (reverse) {
        swapPairs.add([Math.min(move.from, move.to), Math.max(move.from, move.to)].join(','));
      }
    }

    // Helper: read all permissions for a resource, delete them, re-insert with new resource
    // Uses Drizzle ORM to handle column naming differences across backends
    // and avoids SQLite CHECK constraint on resource values (no temp values needed)
    const movePermissions = async (fromResource: string, toResource: string) => {
      const rows = await this.db
        .select()
        .from(permissions)
        .where(eq(permissions.resource, fromResource));
      if (rows.length === 0) return;

      await this.db.delete(permissions).where(eq(permissions.resource, fromResource));

      for (const row of rows) {
        const values: any = {
          userId: (row as any).userId,
          resource: toResource,
          canViewOnMap: (row as any).canViewOnMap,
          canRead: (row as any).canRead,
          canWrite: (row as any).canWrite,
          grantedAt: (row as any).grantedAt ?? Date.now(),
          grantedBy: (row as any).grantedBy,
        };
        // PG/MySQL have canDelete, SQLite does not
        if (!this.isSQLite()) {
          values.canDelete = (row as any).canDelete;
        }
        await this.db.insert(permissions).values(values);
      }
    };

    // Process swaps using delete + re-insert (avoids CHECK constraint issues)
    const processedSwaps = new Set<string>();
    for (const move of moves) {
      const key = [Math.min(move.from, move.to), Math.max(move.from, move.to)].join(',');
      if (swapPairs.has(key) && !processedSwaps.has(key)) {
        processedSwaps.add(key);
        const a = Math.min(move.from, move.to);
        const b = Math.max(move.from, move.to);
        const resourceA = 'channel_' + a;
        const resourceB = 'channel_' + b;

        // Read both before deleting either
        const rowsA = await this.db.select().from(permissions).where(eq(permissions.resource, resourceA));
        const rowsB = await this.db.select().from(permissions).where(eq(permissions.resource, resourceB));

        // Delete both
        await this.db.delete(permissions).where(eq(permissions.resource, resourceA));
        await this.db.delete(permissions).where(eq(permissions.resource, resourceB));

        // Re-insert swapped: A's permissions → resourceB, B's → resourceA
        for (const row of rowsA) {
          const values: any = {
            userId: (row as any).userId,
            resource: resourceB,
            canViewOnMap: (row as any).canViewOnMap,
            canRead: (row as any).canRead,
            canWrite: (row as any).canWrite,
            grantedAt: (row as any).grantedAt ?? Date.now(),
            grantedBy: (row as any).grantedBy,
          };
          if (!this.isSQLite()) values.canDelete = (row as any).canDelete;
          await this.db.insert(permissions).values(values);
        }
        for (const row of rowsB) {
          const values: any = {
            userId: (row as any).userId,
            resource: resourceA,
            canViewOnMap: (row as any).canViewOnMap,
            canRead: (row as any).canRead,
            canWrite: (row as any).canWrite,
            grantedAt: (row as any).grantedAt ?? Date.now(),
            grantedBy: (row as any).grantedBy,
          };
          if (!this.isSQLite()) values.canDelete = (row as any).canDelete;
          await this.db.insert(permissions).values(values);
        }
      }
    }

    // Process simple moves using delete + re-insert (consistent approach across all backends)
    for (const move of moves) {
      const key = [Math.min(move.from, move.to), Math.max(move.from, move.to)].join(',');
      if (!swapPairs.has(key)) {
        await movePermissions('channel_' + move.from, 'channel_' + move.to);
      }
    }
  }

  // ============ NODE ADMIN PERMISSIONS ============

  async hasNodeAdminPermission(userId: number, nodeNum: number): Promise<boolean> {
    const { nodeAdminPermissions } = this.tables;
    const result = await this.db
      .select()
      .from(nodeAdminPermissions)
      .where(and(
        eq(nodeAdminPermissions.userId, userId),
        eq(nodeAdminPermissions.nodeNum, nodeNum)
      ))
      .limit(1);
    return result.length > 0;
  }

  async getNodeAdminPermissionsForUser(userId: number): Promise<{ nodeNum: number; grantedAt: number; grantedBy: number | null }[]> {
    const { nodeAdminPermissions } = this.tables;
    const result = await this.db
      .select({
        nodeNum: nodeAdminPermissions.nodeNum,
        grantedAt: nodeAdminPermissions.grantedAt,
        grantedBy: nodeAdminPermissions.grantedBy,
      })
      .from(nodeAdminPermissions)
      .where(eq(nodeAdminPermissions.userId, userId));
    return this.normalizeBigInts(result) as { nodeNum: number; grantedAt: number; grantedBy: number | null }[];
  }

  async grantNodeAdminPermission(userId: number, nodeNum: number, grantedBy: number): Promise<void> {
    const { nodeAdminPermissions } = this.tables;
    await this.insertIgnore(nodeAdminPermissions, {
      userId,
      nodeNum,
      grantedBy,
      grantedAt: Date.now(),
    });
  }

  async revokeNodeAdminPermission(userId: number, nodeNum: number): Promise<boolean> {
    const { nodeAdminPermissions } = this.tables;
    const result = await this.db
      .delete(nodeAdminPermissions)
      .where(and(
        eq(nodeAdminPermissions.userId, userId),
        eq(nodeAdminPermissions.nodeNum, nodeNum)
      ));
    return this.getAffectedRows(result) > 0;
  }

  async revokeAllNodeAdminPermissions(userId: number): Promise<number> {
    const { nodeAdminPermissions } = this.tables;
    const result = await this.db
      .delete(nodeAdminPermissions)
      .where(eq(nodeAdminPermissions.userId, userId));
    return this.getAffectedRows(result);
  }
}
