/**
 * Auth Repository
 *
 * Handles authentication-related database operations.
 * Includes: users, permissions, sessions, audit_log, api_tokens
 * Supports both SQLite and PostgreSQL through Drizzle ORM.
 */
import { eq, lt, desc, and } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import {
  usersSqlite, usersPostgres,
  permissionsSqlite, permissionsPostgres,
  sessionsSqlite, sessionsPostgres,
  auditLogSqlite, auditLogPostgres,
  apiTokensSqlite, apiTokensPostgres,
} from '../schema/auth.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

const TOKEN_PREFIX = 'mm_v1_';

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
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const existing = await this.getUserById(id);
      if (!existing) return false;
      await db.delete(usersSqlite).where(eq(usersSqlite.id, id));
      return true;
    } else {
      const db = this.getPostgresDb();
      const existing = await this.getUserById(id);
      if (!existing) return false;
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
