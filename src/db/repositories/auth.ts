/**
 * Auth Repository
 *
 * Handles authentication-related database operations.
 * Includes: users, permissions, sessions, audit_log, api_tokens
 * Supports both SQLite and PostgreSQL through Drizzle ORM.
 */
import { eq, lt, desc } from 'drizzle-orm';
import {
  usersSqlite, usersPostgres,
  permissionsSqlite, permissionsPostgres,
  sessionsSqlite, sessionsPostgres,
  auditLogSqlite, auditLogPostgres,
  apiTokensSqlite, apiTokensPostgres,
} from '../schema/auth.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

/**
 * User data interface
 */
export interface DbUser {
  id: number;
  username: string;
  password_hash: string | null;
  email: string | null;
  display_name: string | null;
  auth_provider: string;
  oidc_subject: string | null;
  is_admin: boolean;
  is_active: boolean;
  password_locked: boolean | null;
  created_at: number;
  last_login_at: number | null;
  created_by: number | null;
}

/**
 * Input for creating a user (without id, with required fields)
 */
export interface CreateUserInput {
  username: string;
  password_hash?: string | null;
  email?: string | null;
  display_name?: string | null;
  auth_provider: string;
  oidc_subject?: string | null;
  is_admin?: boolean;
  is_active?: boolean;
  password_locked?: boolean;
  created_at: number;
  last_login_at?: number | null;
  created_by?: number | null;
}

/**
 * Input for updating a user
 */
export interface UpdateUserInput {
  username?: string;
  password_hash?: string | null;
  email?: string | null;
  display_name?: string | null;
  auth_provider?: string;
  oidc_subject?: string | null;
  is_admin?: boolean;
  is_active?: boolean;
  password_locked?: boolean;
  last_login_at?: number | null;
}

/**
 * Permission data interface
 */
export interface DbPermission {
  id: number;
  user_id: number;
  resource: string;
  can_read: boolean;
  can_write: boolean;
  granted_at: number;
  granted_by: number | null;
}

/**
 * Input for creating a permission
 */
export interface CreatePermissionInput {
  user_id: number;
  resource: string;
  can_read?: boolean;
  can_write?: boolean;
  granted_at: number;
  granted_by?: number | null;
}

/**
 * API Token data interface
 */
export interface DbApiToken {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  prefix: string;
  is_active: boolean;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

/**
 * Input for creating an API token
 */
export interface CreateApiTokenInput {
  user_id: number;
  name: string;
  token_hash: string;
  prefix: string;
  is_active?: boolean;
  created_at: number;
  last_used_at?: number | null;
  expires_at?: number | null;
}

/**
 * Audit log entry interface
 */
export interface DbAuditLogEntry {
  id?: number;
  user_id: number | null;
  action: string;
  resource: string | null;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
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
        .where(eq(usersSqlite.oidc_subject, oidcSubject))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbUser;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(usersPostgres)
        .where(eq(usersPostgres.oidc_subject, oidcSubject))
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
      const result = await db.insert(usersSqlite).values(user);
      return Number(result.lastInsertRowid);
    } else {
      const db = this.getPostgresDb();
      const result = await db.insert(usersPostgres).values(user).returning({ id: usersPostgres.id });
      return result[0].id;
    }
  }

  /**
   * Update user
   */
  async updateUser(id: number, updates: UpdateUserInput): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.update(usersSqlite).set(updates).where(eq(usersSqlite.id, id));
    } else {
      const db = this.getPostgresDb();
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
        .where(eq(permissionsSqlite.user_id, userId));
      return result.map(p => this.normalizeBigInts(p) as DbPermission);
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(permissionsPostgres)
        .where(eq(permissionsPostgres.user_id, userId));
      return result as DbPermission[];
    }
  }

  /**
   * Create permission
   */
  async createPermission(permission: CreatePermissionInput): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.insert(permissionsSqlite).values(permission);
      return Number(result.lastInsertRowid);
    } else {
      const db = this.getPostgresDb();
      const result = await db.insert(permissionsPostgres).values(permission).returning({ id: permissionsPostgres.id });
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
        .where(eq(permissionsSqlite.user_id, userId));

      for (const p of toDelete) {
        await db.delete(permissionsSqlite).where(eq(permissionsSqlite.id, p.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: permissionsPostgres.id })
        .from(permissionsPostgres)
        .where(eq(permissionsPostgres.user_id, userId));

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
        .where(eq(apiTokensSqlite.token_hash, tokenHash))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbApiToken;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(apiTokensPostgres)
        .where(eq(apiTokensPostgres.token_hash, tokenHash))
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
        .where(eq(apiTokensSqlite.user_id, userId));
      return result.map(t => this.normalizeBigInts(t) as DbApiToken);
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(apiTokensPostgres)
        .where(eq(apiTokensPostgres.user_id, userId));
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
      await db.update(apiTokensSqlite).set({ last_used_at: now }).where(eq(apiTokensSqlite.id, id));
    } else {
      const db = this.getPostgresDb();
      await db.update(apiTokensPostgres).set({ last_used_at: now }).where(eq(apiTokensPostgres.id, id));
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

  // ============ AUDIT LOG ============

  /**
   * Create audit log entry
   */
  async createAuditLogEntry(entry: DbAuditLogEntry): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.insert(auditLogSqlite).values(entry);
      return Number(result.lastInsertRowid);
    } else {
      const db = this.getPostgresDb();
      const result = await db.insert(auditLogPostgres).values(entry).returning({ id: auditLogPostgres.id });
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
