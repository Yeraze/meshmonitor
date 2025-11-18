/**
 * APIToken Model
 *
 * Handles API token data operations for authentication of external integrations
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { APIToken, CreateAPITokenInput, APITokenInfo } from '../../types/auth.js';

const SALT_ROUNDS = 12;
const TOKEN_PREFIX = 'mm_v1_';
const TOKEN_LENGTH = 32; // characters after prefix

export interface GeneratedToken {
  token: string;        // Full token (shown once)
  tokenInfo: APITokenInfo;  // Info to return to user
}

export class APITokenModel {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Generate a cryptographically secure random token
   * Format: mm_v1_<32_random_hex_chars>
   */
  private generateToken(): string {
    const randomBytes = crypto.randomBytes(TOKEN_LENGTH / 2);  // 16 bytes = 32 hex chars
    const randomString = randomBytes.toString('hex');
    return `${TOKEN_PREFIX}${randomString}`;
  }

  /**
   * Extract prefix from token for display (first 8 chars including mm_v1_)
   */
  private getTokenPrefix(token: string): string {
    return token.substring(0, 12); // "mm_v1_" + first 6 chars of random part
  }

  /**
   * Hash a token using bcrypt
   */
  private async hashToken(token: string): Promise<string> {
    return bcrypt.hash(token, SALT_ROUNDS);
  }

  /**
   * Verify a token against a hash
   */
  private async verifyToken(token: string, hash: string): Promise<boolean> {
    return bcrypt.compare(token, hash);
  }

  /**
   * Create a new API token for a user
   * Note: Automatically revokes any existing active token for the user
   */
  async create(input: CreateAPITokenInput): Promise<GeneratedToken> {
    // Generate token
    const token = this.generateToken();
    const prefix = this.getTokenPrefix(token);
    const tokenHash = await this.hashToken(token);

    // Use transaction to ensure atomic operation
    const transaction = this.db.transaction(() => {
      // Revoke any existing active token for this user
      const revokeStmt = this.db.prepare(`
        UPDATE api_tokens
        SET is_active = 0, revoked_at = ?, revoked_by = ?
        WHERE user_id = ? AND is_active = 1
      `);
      revokeStmt.run(Date.now(), input.createdBy, input.userId);

      // Create new token
      const createStmt = this.db.prepare(`
        INSERT INTO api_tokens (
          user_id, token_hash, prefix, is_active, created_at, created_by
        ) VALUES (?, ?, ?, 1, ?, ?)
      `);

      const result = createStmt.run(
        input.userId,
        tokenHash,
        prefix,
        Date.now(),
        input.createdBy
      );

      return Number(result.lastInsertRowid);
    });

    const tokenId = transaction();

    // Return full token (shown once) and token info
    return {
      token,
      tokenInfo: {
        id: tokenId,
        prefix,
        isActive: true,
        createdAt: Date.now(),
        lastUsedAt: null
      }
    };
  }

  /**
   * Validate a token and return associated user ID
   * Also updates last_used_at timestamp
   */
  async validate(token: string): Promise<number | null> {
    // First check if token format is valid
    if (!token.startsWith(TOKEN_PREFIX)) {
      return null;
    }

    const prefix = this.getTokenPrefix(token);

    // Find active tokens with matching prefix
    const stmt = this.db.prepare(`
      SELECT id, user_id as userId, token_hash as tokenHash
      FROM api_tokens
      WHERE prefix = ? AND is_active = 1
      LIMIT 1
    `);

    const row = stmt.get(prefix) as any;
    if (!row) {
      return null;
    }

    // Verify token hash
    const isValid = await this.verifyToken(token, row.tokenHash);
    if (!isValid) {
      return null;
    }

    // Update last_used_at
    const updateStmt = this.db.prepare(`
      UPDATE api_tokens
      SET last_used_at = ?
      WHERE id = ?
    `);
    updateStmt.run(Date.now(), row.id);

    return row.userId;
  }

  /**
   * Get token info for a user (without sensitive data)
   */
  getUserToken(userId: number): APITokenInfo | null {
    const stmt = this.db.prepare(`
      SELECT
        id, prefix, is_active as isActive,
        created_at as createdAt, last_used_at as lastUsedAt
      FROM api_tokens
      WHERE user_id = ? AND is_active = 1
      LIMIT 1
    `);

    const row = stmt.get(userId) as any;
    if (!row) return null;

    return {
      id: row.id,
      prefix: row.prefix,
      isActive: Boolean(row.isActive),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt || null
    };
  }

  /**
   * Revoke a token
   */
  revoke(tokenId: number, revokedBy: number): boolean {
    const stmt = this.db.prepare(`
      UPDATE api_tokens
      SET is_active = 0, revoked_at = ?, revoked_by = ?
      WHERE id = ? AND is_active = 1
    `);

    const result = stmt.run(Date.now(), revokedBy, tokenId);
    return result.changes > 0;
  }

  /**
   * Revoke all tokens for a user
   */
  revokeAllForUser(userId: number, revokedBy: number): number {
    const stmt = this.db.prepare(`
      UPDATE api_tokens
      SET is_active = 0, revoked_at = ?, revoked_by = ?
      WHERE user_id = ? AND is_active = 1
    `);

    const result = stmt.run(Date.now(), revokedBy, userId);
    return result.changes;
  }

  /**
   * Get all tokens for a user (admin function)
   */
  getAllForUser(userId: number): APIToken[] {
    const stmt = this.db.prepare(`
      SELECT
        id, user_id as userId, token_hash as tokenHash, prefix,
        is_active as isActive, created_at as createdAt,
        last_used_at as lastUsedAt, created_by as createdBy,
        revoked_at as revokedAt, revoked_by as revokedBy
      FROM api_tokens
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(userId) as any[];
    return rows.map(row => ({
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      prefix: row.prefix,
      isActive: Boolean(row.isActive),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt || null,
      createdBy: row.createdBy,
      revokedAt: row.revokedAt || null,
      revokedBy: row.revokedBy || null
    }));
  }

  /**
   * Get all tokens (admin function)
   */
  getAll(): APIToken[] {
    const stmt = this.db.prepare(`
      SELECT
        id, user_id as userId, token_hash as tokenHash, prefix,
        is_active as isActive, created_at as createdAt,
        last_used_at as lastUsedAt, created_by as createdBy,
        revoked_at as revokedAt, revoked_by as revokedBy
      FROM api_tokens
      ORDER BY created_at DESC
    `);

    const rows = stmt.all() as any[];
    return rows.map(row => ({
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      prefix: row.prefix,
      isActive: Boolean(row.isActive),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt || null,
      createdBy: row.createdBy,
      revokedAt: row.revokedAt || null,
      revokedBy: row.revokedBy || null
    }));
  }
}
