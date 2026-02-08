/**
 * User Model
 *
 * Handles user data operations including creation, retrieval, and updates
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { User, CreateUserInput, UpdateUserInput } from '../../types/auth.js';

const SALT_ROUNDS = 12;

export class UserModel {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Hash a password using bcrypt
   */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  /**
   * Verify a password against a hash
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Create a new user
   */
  async create(input: CreateUserInput): Promise<User> {
    let passwordHash: string | null = null;

    // Hash password for local auth users
    if (input.authProvider === 'local' && input.password) {
      passwordHash = await this.hashPassword(input.password);
    }

    const stmt = this.db.prepare(`
      INSERT INTO users (
        username, password_hash, email, display_name,
        auth_provider, oidc_subject, is_admin, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.username,
      passwordHash,
      input.email || null,
      input.displayName || null,
      input.authProvider,
      input.oidcSubject || null,
      input.isAdmin ? 1 : 0,
      Date.now(),
      input.createdBy || null
    );

    const user = this.findById(Number(result.lastInsertRowid));
    if (!user) {
      throw new Error('Failed to create user');
    }

    return user;
  }

  /**
   * Find user by ID
   */
  findById(id: number): User | null {
    const stmt = this.db.prepare(`
      SELECT
        id, username, password_hash as passwordHash, email, display_name as displayName,
        auth_provider as authProvider, oidc_subject as oidcSubject,
        is_admin as isAdmin, is_active as isActive, password_locked as passwordLocked,
        created_at as createdAt, last_login_at as lastLoginAt, created_by as createdBy
      FROM users
      WHERE id = ?
    `);

    const row = stmt.get(id) as any;
    if (!row) return null;

    return this.mapRowToUser(row);
  }

  /**
   * Find user by username
   */
  findByUsername(username: string): User | null {
    const stmt = this.db.prepare(`
      SELECT
        id, username, password_hash as passwordHash, email, display_name as displayName,
        auth_provider as authProvider, oidc_subject as oidcSubject,
        is_admin as isAdmin, is_active as isActive, password_locked as passwordLocked,
        created_at as createdAt, last_login_at as lastLoginAt, created_by as createdBy
      FROM users
      WHERE username = ?
    `);

    const row = stmt.get(username) as any;
    if (!row) return null;

    return this.mapRowToUser(row);
  }

  /**
   * Find user by OIDC subject
   */
  findByOIDCSubject(subject: string): User | null {
    const stmt = this.db.prepare(`
      SELECT
        id, username, password_hash as passwordHash, email, display_name as displayName,
        auth_provider as authProvider, oidc_subject as oidcSubject,
        is_admin as isAdmin, is_active as isActive, password_locked as passwordLocked,
        created_at as createdAt, last_login_at as lastLoginAt, created_by as createdBy
      FROM users
      WHERE oidc_subject = ?
    `);

    const row = stmt.get(subject) as any;
    if (!row) return null;

    return this.mapRowToUser(row);
  }

  /**
   * Get all users
   */
  findAll(): User[] {
    const stmt = this.db.prepare(`
      SELECT
        id, username, password_hash as passwordHash, email, display_name as displayName,
        auth_provider as authProvider, oidc_subject as oidcSubject,
        is_admin as isAdmin, is_active as isActive, password_locked as passwordLocked,
        created_at as createdAt, last_login_at as lastLoginAt, created_by as createdBy
      FROM users
      ORDER BY created_at DESC
    `);

    const rows = stmt.all() as any[];
    return rows.map(row => this.mapRowToUser(row));
  }

  /**
   * Update user information
   */
  update(id: number, input: UpdateUserInput): User | null {
    const updates: string[] = [];
    const params: any[] = [];

    if (input.email !== undefined) {
      updates.push('email = ?');
      params.push(input.email);
    }

    if (input.displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(input.displayName);
    }

    if (input.isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(input.isActive ? 1 : 0);
    }

    if (input.passwordLocked !== undefined) {
      updates.push('password_locked = ?');
      params.push(input.passwordLocked ? 1 : 0);
    }

    if (input.mfaEnabled !== undefined) {
      updates.push('mfa_enabled = ?');
      params.push(input.mfaEnabled ? 1 : 0);
    }

    if (input.mfaSecret !== undefined) {
      updates.push('mfa_secret = ?');
      params.push(input.mfaSecret);
    }

    if (input.mfaBackupCodes !== undefined) {
      updates.push('mfa_backup_codes = ?');
      params.push(input.mfaBackupCodes);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    params.push(id);

    const stmt = this.db.prepare(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    stmt.run(...params);

    return this.findById(id);
  }

  /**
   * Update user password (local auth only)
   */
  async updatePassword(id: number, newPassword: string): Promise<void> {
    const user = this.findById(id);
    if (!user || user.authProvider !== 'local') {
      throw new Error('Cannot update password for non-local user');
    }

    const passwordHash = await this.hashPassword(newPassword);

    const stmt = this.db.prepare(`
      UPDATE users
      SET password_hash = ?
      WHERE id = ?
    `);

    stmt.run(passwordHash, id);
  }

  /**
   * Update admin status
   */
  updateAdminStatus(id: number, isAdmin: boolean): User | null {
    const stmt = this.db.prepare(`
      UPDATE users
      SET is_admin = ?
      WHERE id = ?
    `);

    stmt.run(isAdmin ? 1 : 0, id);

    return this.findById(id);
  }

  /**
   * Update last login timestamp
   */
  updateLastLogin(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE users
      SET last_login_at = ?
      WHERE id = ?
    `);

    stmt.run(Date.now(), id);
  }

  /**
   * Migrate a native-login user to OIDC authentication
   * This preserves all user settings, permissions, and data while
   * converting the authentication method to OIDC
   */
  migrateToOIDC(id: number, oidcSubject: string, email?: string, displayName?: string): User | null {
    const user = this.findById(id);
    if (!user) {
      throw new Error('User not found');
    }

    if (user.authProvider === 'oidc') {
      throw new Error('User is already using OIDC authentication');
    }

    const stmt = this.db.prepare(`
      UPDATE users
      SET
        auth_provider = 'oidc',
        oidc_subject = ?,
        password_hash = NULL,
        email = COALESCE(?, email),
        display_name = COALESCE(?, display_name),
        last_login_at = ?
      WHERE id = ?
    `);

    stmt.run(
      oidcSubject,
      email || null,
      displayName || null,
      Date.now(),
      id
    );

    return this.findById(id);
  }

  /**
   * Find user by email (case-insensitive)
   */
  findByEmail(email: string): User | null {
    const stmt = this.db.prepare(`
      SELECT
        id, username, password_hash as passwordHash, email, display_name as displayName,
        auth_provider as authProvider, oidc_subject as oidcSubject,
        is_admin as isAdmin, is_active as isActive, password_locked as passwordLocked,
        created_at as createdAt, last_login_at as lastLoginAt, created_by as createdBy
      FROM users
      WHERE LOWER(email) = LOWER(?)
    `);

    const row = stmt.get(email) as any;
    if (!row) return null;

    return this.mapRowToUser(row);
  }

  /**
   * Delete (deactivate) a user
   */
  delete(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE users
      SET is_active = 0
      WHERE id = ?
    `);

    stmt.run(id);
  }

  /**
   * Permanently delete a user (use with caution)
   */
  hardDelete(id: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM users
      WHERE id = ?
    `);

    stmt.run(id);
  }

  /**
   * Check if any users exist
   */
  hasUsers(): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM users
    `);

    const result = stmt.get() as { count: number };
    return result.count > 0;
  }

  /**
   * Check if any admin users exist
   */
  hasAdminUser(): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM users WHERE is_admin = 1 AND is_active = 1
    `);

    const result = stmt.get() as { count: number };
    return result.count > 0;
  }

  /**
   * Authenticate a local user
   */
  async authenticate(username: string, password: string): Promise<User | null> {
    const user = this.findByUsername(username);

    if (!user || !user.isActive) {
      return null;
    }

    if (user.authProvider !== 'local' || !user.passwordHash) {
      return null;
    }

    const isValid = await this.verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return null;
    }

    // Update last login
    this.updateLastLogin(user.id);

    return user;
  }

  /**
   * Get user's map preferences
   */
  getMapPreferences(userId: number): Record<string, any> | null {
    const stmt = this.db.prepare(`
      SELECT
        map_tileset as mapTileset,
        show_paths as showPaths,
        show_neighbor_info as showNeighborInfo,
        show_route as showRoute,
        show_motion as showMotion,
        show_mqtt_nodes as showMqttNodes,
        show_animations as showAnimations,
        position_history_hours as positionHistoryHours
      FROM user_map_preferences
      WHERE user_id = ?
    `);

    const row = stmt.get(userId) as any;
    if (!row) return null;

    return {
      mapTileset: row.mapTileset || null,
      showPaths: Boolean(row.showPaths),
      showNeighborInfo: Boolean(row.showNeighborInfo),
      showRoute: Boolean(row.showRoute),
      showMotion: Boolean(row.showMotion),
      showMqttNodes: Boolean(row.showMqttNodes),
      showAnimations: Boolean(row.showAnimations),
      positionHistoryHours: row.positionHistoryHours ?? null,
    };
  }

  /**
   * Save user's map preferences
   */
  saveMapPreferences(userId: number, preferences: {
    mapTileset?: string;
    showPaths?: boolean;
    showNeighborInfo?: boolean;
    showRoute?: boolean;
    showMotion?: boolean;
    showMqttNodes?: boolean;
    showAnimations?: boolean;
    positionHistoryHours?: number | null;
  }): void {
    const now = Date.now();

    // Check if preferences exist
    const existing = this.db.prepare('SELECT user_id FROM user_map_preferences WHERE user_id = ?').get(userId);

    if (existing) {
      // Update existing preferences
      const updates: string[] = [];
      const params: any[] = [];

      if (preferences.mapTileset !== undefined) {
        updates.push('map_tileset = ?');
        params.push(preferences.mapTileset);
      }
      if (preferences.showPaths !== undefined) {
        updates.push('show_paths = ?');
        params.push(preferences.showPaths ? 1 : 0);
      }
      if (preferences.showNeighborInfo !== undefined) {
        updates.push('show_neighbor_info = ?');
        params.push(preferences.showNeighborInfo ? 1 : 0);
      }
      if (preferences.showRoute !== undefined) {
        updates.push('show_route = ?');
        params.push(preferences.showRoute ? 1 : 0);
      }
      if (preferences.showMotion !== undefined) {
        updates.push('show_motion = ?');
        params.push(preferences.showMotion ? 1 : 0);
      }
      if (preferences.showMqttNodes !== undefined) {
        updates.push('show_mqtt_nodes = ?');
        params.push(preferences.showMqttNodes ? 1 : 0);
      }
      if (preferences.showAnimations !== undefined) {
        updates.push('show_animations = ?');
        params.push(preferences.showAnimations ? 1 : 0);
      }
      if (preferences.positionHistoryHours !== undefined) {
        updates.push('position_history_hours = ?');
        params.push(preferences.positionHistoryHours);
      }

      if (updates.length > 0) {
        updates.push('updated_at = ?');
        params.push(now);
        params.push(userId);

        const stmt = this.db.prepare(`
          UPDATE user_map_preferences
          SET ${updates.join(', ')}
          WHERE user_id = ?
        `);
        stmt.run(...params);
      }
    } else {
      // Insert new preferences
      const stmt = this.db.prepare(`
        INSERT INTO user_map_preferences (
          user_id, map_tileset, show_paths, show_neighbor_info,
          show_route, show_motion, show_mqtt_nodes, show_animations,
          position_history_hours, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        userId,
        preferences.mapTileset || null,
        preferences.showPaths ? 1 : 0,
        preferences.showNeighborInfo ? 1 : 0,
        preferences.showRoute !== undefined ? (preferences.showRoute ? 1 : 0) : 1, // default true
        preferences.showMotion !== undefined ? (preferences.showMotion ? 1 : 0) : 1, // default true
        preferences.showMqttNodes !== undefined ? (preferences.showMqttNodes ? 1 : 0) : 1, // default true
        preferences.showAnimations ? 1 : 0,
        preferences.positionHistoryHours ?? null,
        now,
        now
      );
    }
  }

  /**
   * Map database row to User object
   */
  private mapRowToUser(row: any): User {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.passwordHash || null,
      email: row.email || null,
      displayName: row.displayName || null,
      authProvider: row.authProvider,
      oidcSubject: row.oidcSubject || null,
      isAdmin: Boolean(row.isAdmin),
      isActive: Boolean(row.isActive),
      passwordLocked: Boolean(row.passwordLocked),
      mfaEnabled: Boolean(row.mfaEnabled || row.mfa_enabled),
      mfaSecret: row.mfaSecret || row.mfa_secret || null,
      mfaBackupCodes: row.mfaBackupCodes || row.mfa_backup_codes || null,
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt || null,
      createdBy: row.createdBy || null
    };
  }
}
