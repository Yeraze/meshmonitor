/**
 * API Key Model
 *
 * Handles API key data operations including creation, validation, and revocation
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const SALT_ROUNDS = 12;
const API_KEY_PREFIX = 'mm_';
const API_KEY_LENGTH = 32; // 32 random bytes = 64 hex characters

export interface ApiKey {
  id: number;
  userId: number;
  keyHash: string;
  keyPreview: string;
  createdAt: number;
  lastUsedAt: number | null;
  isActive: boolean;
}

export interface ApiKeyCreateInput {
  userId: number;
}

export class ApiKeyModel {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Generate a new API key with secure random bytes
   * Format: mm_<64 hex characters>
   */
  private generateKey(): string {
    const randomBytes = crypto.randomBytes(API_KEY_LENGTH);
    const hexString = randomBytes.toString('hex');
    return `${API_KEY_PREFIX}${hexString}`;
  }

  /**
   * Hash an API key using bcrypt
   */
  private async hashKey(key: string): Promise<string> {
    return bcrypt.hash(key, SALT_ROUNDS);
  }

  /**
   * Verify an API key against a hash
   */
  private async verifyKey(key: string, hash: string): Promise<boolean> {
    return bcrypt.compare(key, hash);
  }

  /**
   * Extract preview from API key (last 4 characters)
   */
  private extractPreview(key: string): string {
    return `${API_KEY_PREFIX}...${key.slice(-4)}`;
  }

  /**
   * Create a new API key for a user
   * Returns the plaintext key (only time it will be available)
   * Automatically revokes any existing active key for the user
   */
  async create(input: ApiKeyCreateInput): Promise<{ key: string; apiKey: ApiKey }> {
    // First, revoke any existing active keys for this user
    await this.revokeAllForUser(input.userId);

    // Generate new key
    const key = this.generateKey();
    const keyHash = await this.hashKey(key);
    const keyPreview = this.extractPreview(key);

    const stmt = this.db.prepare(`
      INSERT INTO api_keys (user_id, key_hash, key_preview, created_at, is_active)
      VALUES (?, ?, ?, ?, 1)
    `);

    const result = stmt.run(
      input.userId,
      keyHash,
      keyPreview,
      Date.now()
    );

    const apiKey = this.findById(Number(result.lastInsertRowid));
    if (!apiKey) {
      throw new Error('Failed to create API key');
    }

    return { key, apiKey };
  }

  /**
   * Find API key by ID
   */
  findById(id: number): ApiKey | null {
    const stmt = this.db.prepare(`
      SELECT
        id, user_id as userId, key_hash as keyHash, key_preview as keyPreview,
        created_at as createdAt, last_used_at as lastUsedAt, is_active as isActive
      FROM api_keys
      WHERE id = ?
    `);

    const row = stmt.get(id) as any;
    if (!row) return null;

    return this.mapRowToApiKey(row);
  }

  /**
   * Find active API key by user ID
   */
  findByUserId(userId: number): ApiKey | null {
    const stmt = this.db.prepare(`
      SELECT
        id, user_id as userId, key_hash as keyHash, key_preview as keyPreview,
        created_at as createdAt, last_used_at as lastUsedAt, is_active as isActive
      FROM api_keys
      WHERE user_id = ? AND is_active = 1
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = stmt.get(userId) as any;
    if (!row) return null;

    return this.mapRowToApiKey(row);
  }

  /**
   * Validate an API key and return the associated key record
   * Updates last_used_at timestamp on successful validation
   */
  async validateKey(key: string): Promise<ApiKey | null> {
    // Get all active API keys
    const stmt = this.db.prepare(`
      SELECT
        id, user_id as userId, key_hash as keyHash, key_preview as keyPreview,
        created_at as createdAt, last_used_at as lastUsedAt, is_active as isActive
      FROM api_keys
      WHERE is_active = 1
    `);

    const rows = stmt.all() as any[];

    // Try to verify against each active key
    for (const row of rows) {
      const isValid = await this.verifyKey(key, row.keyHash);
      if (isValid) {
        const apiKey = this.mapRowToApiKey(row);
        // Update last used timestamp
        this.updateLastUsed(apiKey.id);
        return apiKey;
      }
    }

    return null;
  }

  /**
   * Update last used timestamp for an API key
   */
  updateLastUsed(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE api_keys
      SET last_used_at = ?
      WHERE id = ?
    `);

    stmt.run(Date.now(), id);
  }

  /**
   * Revoke an API key
   */
  revoke(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE api_keys
      SET is_active = 0
      WHERE id = ?
    `);

    stmt.run(id);
  }

  /**
   * Revoke all API keys for a user
   */
  async revokeAllForUser(userId: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE api_keys
      SET is_active = 0
      WHERE user_id = ?
    `);

    stmt.run(userId);
  }

  /**
   * Get all API keys for a user (including revoked)
   */
  getAllForUser(userId: number): ApiKey[] {
    const stmt = this.db.prepare(`
      SELECT
        id, user_id as userId, key_hash as keyHash, key_preview as keyPreview,
        created_at as createdAt, last_used_at as lastUsedAt, is_active as isActive
      FROM api_keys
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(userId) as any[];
    return rows.map(row => this.mapRowToApiKey(row));
  }

  /**
   * Delete an API key permanently
   */
  delete(id: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM api_keys
      WHERE id = ?
    `);

    stmt.run(id);
  }

  /**
   * Map database row to ApiKey object
   */
  private mapRowToApiKey(row: any): ApiKey {
    return {
      id: row.id,
      userId: row.userId,
      keyHash: row.keyHash,
      keyPreview: row.keyPreview,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt || null,
      isActive: Boolean(row.isActive)
    };
  }
}
