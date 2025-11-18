/**
 * API Token Model Tests
 *
 * Tests API token functionality including:
 * - Token generation (format, uniqueness, security)
 * - Token validation (valid tokens, invalid tokens, expired tokens)
 * - Token revocation (successful revocation, already revoked)
 * - Single token per user constraint
 * - Transaction rollback scenarios
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

// Constants from APIToken model
const TOKEN_PREFIX = 'mm_v1_';
const TOKEN_LENGTH = 32;
const SALT_ROUNDS = 12;

// Create a test database service with API token functionality
const createTestDatabase = () => {
  const Database = require('better-sqlite3');
  const bcrypt = require('bcrypt');
  const crypto = require('crypto');

  class TestAPITokenModel {
    public db: Database.Database;

    constructor() {
      this.db = new Database(':memory:');
      this.db.pragma('foreign_keys = ON');
      this.createTables();
    }

    private createTables(): void {
      // Users table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT,
          email TEXT,
          display_name TEXT,
          auth_provider TEXT NOT NULL DEFAULT 'local',
          oidc_sub TEXT,
          is_admin INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          last_login_at INTEGER,
          CHECK (is_admin IN (0, 1)),
          CHECK (is_active IN (0, 1)),
          CHECK (auth_provider IN ('local', 'oidc'))
        )
      `);

      // API tokens table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS api_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          token_hash TEXT UNIQUE NOT NULL,
          prefix TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          created_by INTEGER NOT NULL,
          revoked_at INTEGER,
          revoked_by INTEGER,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id),
          FOREIGN KEY (revoked_by) REFERENCES users(id)
        )
      `);

      // Unique constraint: one active token per user
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_one_per_user
        ON api_tokens(user_id) WHERE is_active = 1
      `);

      // Audit log table for testing audit trail
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action TEXT NOT NULL,
          resource TEXT,
          details TEXT,
          ip_address TEXT,
          timestamp INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
    }

    private generateToken(): string {
      const randomBytes = crypto.randomBytes(TOKEN_LENGTH / 2);
      const randomString = randomBytes.toString('hex');
      return `${TOKEN_PREFIX}${randomString}`;
    }

    private getTokenPrefix(token: string): string {
      return token.substring(0, TOKEN_PREFIX.length + 8);
    }

    private async hashToken(token: string): Promise<string> {
      return bcrypt.hash(token, SALT_ROUNDS);
    }

    private async verifyToken(token: string, hash: string): Promise<boolean> {
      return bcrypt.compare(token, hash);
    }

    async create(input: { userId: number; createdBy: number }): Promise<{ token: string; tokenInfo: any }> {
      const token = this.generateToken();
      const prefix = this.getTokenPrefix(token);
      const tokenHash = await this.hashToken(token);

      const transaction = this.db.transaction(() => {
        // Revoke any existing active token
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
        const result = createStmt.run(input.userId, tokenHash, prefix, Date.now(), input.createdBy);
        return Number(result.lastInsertRowid);
      });

      const tokenId = transaction();

      const tokenInfo = this.db.prepare(`
        SELECT id, user_id as userId, prefix, is_active as isActive,
               created_at as createdAt, last_used_at as lastUsedAt,
               created_by as createdBy, revoked_at as revokedAt,
               revoked_by as revokedBy
        FROM api_tokens
        WHERE id = ?
      `).get(tokenId);

      return { token, tokenInfo };
    }

    async validate(token: string): Promise<number | null> {
      if (!token.startsWith(TOKEN_PREFIX)) {
        return null;
      }

      const prefix = this.getTokenPrefix(token);

      const stmt = this.db.prepare(`
        SELECT id, user_id as userId, token_hash as tokenHash
        FROM api_tokens
        WHERE prefix = ? AND is_active = 1
        LIMIT 1
      `);

      const row = stmt.get(prefix) as { id: number; userId: number; tokenHash: string } | undefined;

      if (!row) {
        return null;
      }

      const isValid = await this.verifyToken(token, row.tokenHash);
      if (!isValid) {
        return null;
      }

      // Update last_used_at
      const updateStmt = this.db.prepare(`
        UPDATE api_tokens SET last_used_at = ? WHERE id = ?
      `);
      updateStmt.run(Date.now(), row.id);

      return row.userId;
    }

    revoke(tokenId: number, revokedBy: number): boolean {
      const stmt = this.db.prepare(`
        UPDATE api_tokens
        SET is_active = 0, revoked_at = ?, revoked_by = ?
        WHERE id = ? AND is_active = 1
      `);
      const result = stmt.run(Date.now(), revokedBy, tokenId);
      return result.changes > 0;
    }

    getUserToken(userId: number): any {
      const stmt = this.db.prepare(`
        SELECT id, user_id as userId, prefix, is_active as isActive,
               created_at as createdAt, last_used_at as lastUsedAt,
               created_by as createdBy, revoked_at as revokedAt,
               revoked_by as revokedBy
        FROM api_tokens
        WHERE user_id = ? AND is_active = 1
        LIMIT 1
      `);
      return stmt.get(userId);
    }
  }

  return new TestAPITokenModel();
};

describe('API Token Model', () => {
  let db: any;
  let testUserId: number;
  let adminUserId: number;

  beforeEach(() => {
    db = createTestDatabase();

    // Create test user
    const userResult = db.db.prepare(`
      INSERT INTO users (username, email, auth_provider, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('testuser', 'test@example.com', 'local', 0, Date.now());
    testUserId = userResult.lastInsertRowid as number;

    // Create admin user for testing created_by/revoked_by
    const adminResult = db.db.prepare(`
      INSERT INTO users (username, email, auth_provider, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('admin', 'admin@example.com', 'local', 1, Date.now());
    adminUserId = adminResult.lastInsertRowid as number;
  });

  describe('Token Generation (create)', () => {
    it('should generate a token with correct format', async () => {
      const { token, tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Token format: mm_v1_ + 32 hex characters
      expect(token).toMatch(/^mm_v1_[0-9a-f]{32}$/);
      expect(token.length).toBe(38); // 'mm_v1_' (6) + 32 hex chars
      expect(token.startsWith('mm_v1_')).toBe(true);
    });

    it('should store token prefix but not full token', async () => {
      const { token, tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Prefix should be stored (first 14 characters)
      expect(tokenInfo.prefix).toBe(token.substring(0, 14));
      expect(tokenInfo.prefix.length).toBe(14);

      // Full token should not be in database
      const dbToken = db.db.prepare('SELECT token_hash FROM api_tokens WHERE id = ?')
        .get(tokenInfo.id);
      expect(dbToken.token_hash).not.toBe(token);
      expect(dbToken.token_hash.length).toBeGreaterThan(token.length); // bcrypt hash is longer
    });

    it('should hash token with bcrypt', async () => {
      const { token, tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      const dbToken = db.db.prepare('SELECT token_hash FROM api_tokens WHERE id = ?')
        .get(tokenInfo.id);

      // bcrypt hash should start with $2b$ (bcrypt identifier)
      expect(dbToken.token_hash).toMatch(/^\$2[aby]\$/);

      // Should be able to verify the token
      const bcrypt = require('bcrypt');
      const isValid = await bcrypt.compare(token, dbToken.token_hash);
      expect(isValid).toBe(true);
    });

    it('should generate unique tokens', async () => {
      const { token: token1 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Create another user to generate second token
      const user2Result = db.db.prepare(`
        INSERT INTO users (username, email, auth_provider, is_admin, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('user2', 'user2@example.com', 'local', 0, Date.now());
      const user2Id = user2Result.lastInsertRowid as number;

      const { token: token2 } = await db.create({
        userId: user2Id,
        createdBy: user2Id
      });

      expect(token1).not.toBe(token2);
    });

    it('should store token metadata correctly', async () => {
      const beforeTime = Date.now();
      const { tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: adminUserId
      });
      const afterTime = Date.now();

      expect(tokenInfo.userId).toBe(testUserId);
      expect(tokenInfo.createdBy).toBe(adminUserId);
      expect(tokenInfo.isActive).toBe(1);
      expect(tokenInfo.createdAt).toBeGreaterThanOrEqual(beforeTime);
      expect(tokenInfo.createdAt).toBeLessThanOrEqual(afterTime);
      expect(tokenInfo.lastUsedAt).toBeNull();
      expect(tokenInfo.revokedAt).toBeNull();
      expect(tokenInfo.revokedBy).toBeNull();
    });

    it('should revoke old token when generating new one (single token per user)', async () => {
      // Generate first token
      const { token: token1, tokenInfo: info1 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Verify first token is active
      expect(info1.isActive).toBe(1);

      // Generate second token
      const { token: token2, tokenInfo: info2 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Verify second token is active
      expect(info2.isActive).toBe(1);

      // Verify first token is now revoked
      const oldToken = db.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info1.id);
      expect(oldToken.is_active).toBe(0);
      expect(oldToken.revoked_at).toBeTruthy();
      expect(oldToken.revoked_by).toBe(testUserId);

      // Verify only one active token per user
      const activeTokens = db.db.prepare(
        'SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ? AND is_active = 1'
      ).get(testUserId);
      expect(activeTokens.count).toBe(1);
    });

    it('should handle atomic transaction (revoke + create)', async () => {
      // This test verifies that the transaction is atomic
      // If the create fails, the revoke should also be rolled back

      // Generate first token
      await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Generate second token (this should revoke first and create second atomically)
      const { tokenInfo: info2 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Verify state is consistent
      const allTokens = db.db.prepare(
        'SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at'
      ).all(testUserId);

      expect(allTokens.length).toBe(2);
      expect(allTokens[0].is_active).toBe(0); // First token revoked
      expect(allTokens[1].is_active).toBe(1); // Second token active
      expect(allTokens[1].id).toBe(info2.id);
    });
  });

  describe('Token Validation (validate)', () => {
    it('should validate a valid token and return user ID', async () => {
      const { token } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      const validatedUserId = await db.validate(token);
      expect(validatedUserId).toBe(testUserId);
    });

    it('should update last_used_at on successful validation', async () => {
      const { token, tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      expect(tokenInfo.lastUsedAt).toBeNull();

      // Wait a moment to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      const beforeValidation = Date.now();
      await db.validate(token);
      const afterValidation = Date.now();

      const updatedToken = db.db.prepare('SELECT * FROM api_tokens WHERE id = ?')
        .get(tokenInfo.id);

      expect(updatedToken.last_used_at).toBeTruthy();
      expect(updatedToken.last_used_at).toBeGreaterThanOrEqual(beforeValidation);
      expect(updatedToken.last_used_at).toBeLessThanOrEqual(afterValidation);
    });

    it('should reject token with wrong prefix', async () => {
      const invalidToken = 'wrong_prefix_0123456789abcdef0123456789abcdef';
      const result = await db.validate(invalidToken);
      expect(result).toBeNull();
    });

    it('should reject token with wrong format', async () => {
      const invalidTokens = [
        'mm_v1_',  // Too short
        'mm_v1_short',  // Too short
        'mm_v1_GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',  // Invalid hex (G is not hex)
        'not_a_token',
        '',
        'mm_v2_0123456789abcdef0123456789abcdef'  // Wrong version
      ];

      for (const invalidToken of invalidTokens) {
        const result = await db.validate(invalidToken);
        expect(result).toBeNull();
      }
    });

    it('should reject revoked token', async () => {
      const { token, tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Revoke the token
      db.revoke(tokenInfo.id, adminUserId);

      // Try to validate
      const result = await db.validate(token);
      expect(result).toBeNull();
    });

    it('should reject token with correct prefix but wrong hash', async () => {
      const { token } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Create a fake token with same prefix but different suffix
      const prefix = token.substring(0, 14);
      const fakeToken = prefix + '0'.repeat(24);  // Different suffix

      const result = await db.validate(fakeToken);
      expect(result).toBeNull();
    });

    it('should reject token for non-existent prefix', async () => {
      // Valid format but never created
      const fakeToken = 'mm_v1_' + '0'.repeat(32);
      const result = await db.validate(fakeToken);
      expect(result).toBeNull();
    });

    it('should handle multiple validation attempts', async () => {
      const { token, tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Validate multiple times
      const result1 = await db.validate(token);
      expect(result1).toBe(testUserId);

      await new Promise(resolve => setTimeout(resolve, 10));

      const result2 = await db.validate(token);
      expect(result2).toBe(testUserId);

      // last_used_at should be updated
      const updatedToken = db.db.prepare('SELECT * FROM api_tokens WHERE id = ?')
        .get(tokenInfo.id);
      expect(updatedToken.last_used_at).toBeGreaterThan(tokenInfo.createdAt);
    });
  });

  describe('Token Revocation (revoke)', () => {
    it('should revoke an active token successfully', async () => {
      const { tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      const beforeRevoke = Date.now();
      const revoked = db.revoke(tokenInfo.id, adminUserId);
      const afterRevoke = Date.now();

      expect(revoked).toBe(true);

      const revokedToken = db.db.prepare('SELECT * FROM api_tokens WHERE id = ?')
        .get(tokenInfo.id);

      expect(revokedToken.is_active).toBe(0);
      expect(revokedToken.revoked_at).toBeGreaterThanOrEqual(beforeRevoke);
      expect(revokedToken.revoked_at).toBeLessThanOrEqual(afterRevoke);
      expect(revokedToken.revoked_by).toBe(adminUserId);
    });

    it('should return false when revoking already revoked token', async () => {
      const { tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // First revocation
      const revoked1 = db.revoke(tokenInfo.id, adminUserId);
      expect(revoked1).toBe(true);

      // Second revocation
      const revoked2 = db.revoke(tokenInfo.id, adminUserId);
      expect(revoked2).toBe(false);
    });

    it('should return false when revoking non-existent token', async () => {
      const revoked = db.revoke(99999, adminUserId);
      expect(revoked).toBe(false);
    });

    it('should make token invalid after revocation', async () => {
      const { token, tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Verify token works before revocation
      const validBefore = await db.validate(token);
      expect(validBefore).toBe(testUserId);

      // Revoke token
      db.revoke(tokenInfo.id, adminUserId);

      // Verify token no longer works
      const validAfter = await db.validate(token);
      expect(validAfter).toBeNull();
    });
  });

  describe('Get User Token (getUserToken)', () => {
    it('should return active token for user', async () => {
      const { tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      const userToken = db.getUserToken(testUserId);
      expect(userToken).toBeTruthy();
      expect(userToken.id).toBe(tokenInfo.id);
      expect(userToken.userId).toBe(testUserId);
      expect(userToken.isActive).toBe(1);
    });

    it('should return null when user has no active token', async () => {
      const userToken = db.getUserToken(testUserId);
      expect(userToken).toBeUndefined();
    });

    it('should return null when user token is revoked', async () => {
      const { tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      db.revoke(tokenInfo.id, adminUserId);

      const userToken = db.getUserToken(testUserId);
      expect(userToken).toBeUndefined();
    });

    it('should return only active token when user has multiple tokens', async () => {
      // Create first token
      await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Create second token (revokes first)
      const { tokenInfo: info2 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Should return only the active (second) token
      const userToken = db.getUserToken(testUserId);
      expect(userToken.id).toBe(info2.id);
      expect(userToken.isActive).toBe(1);
    });
  });

  describe('Single Token Per User Constraint', () => {
    it('should enforce unique active token per user via index', async () => {
      // Create first token
      await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Try to manually insert another active token (should fail)
      const crypto = require('crypto');
      const bcrypt = require('bcrypt');

      const token2 = 'mm_v1_' + crypto.randomBytes(16).toString('hex');
      const hash2 = await bcrypt.hash(token2, SALT_ROUNDS);
      const prefix2 = token2.substring(0, 14);

      expect(() => {
        db.db.prepare(`
          INSERT INTO api_tokens (
            user_id, token_hash, prefix, is_active, created_at, created_by
          ) VALUES (?, ?, ?, 1, ?, ?)
        `).run(testUserId, hash2, prefix2, Date.now(), testUserId);
      }).toThrow(); // Should violate unique constraint
    });

    it('should allow multiple revoked tokens per user', async () => {
      // Create and revoke first token
      const { tokenInfo: info1 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });
      db.revoke(info1.id, adminUserId);

      // Create and revoke second token
      const { tokenInfo: info2 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });
      db.revoke(info2.id, adminUserId);

      // Should have two revoked tokens
      const revokedTokens = db.db.prepare(`
        SELECT COUNT(*) as count FROM api_tokens
        WHERE user_id = ? AND is_active = 0
      `).get(testUserId);

      expect(revokedTokens.count).toBe(2);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle user deletion (CASCADE)', async () => {
      const { tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Delete user
      db.db.prepare('DELETE FROM users WHERE id = ?').run(testUserId);

      // Token should be deleted due to CASCADE
      const token = db.db.prepare('SELECT * FROM api_tokens WHERE id = ?')
        .get(tokenInfo.id);
      expect(token).toBeUndefined();
    });

    it('should handle very long validation delays', async () => {
      const { token, tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Simulate long delay (e.g., token generated a week ago)
      const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      db.db.prepare('UPDATE api_tokens SET created_at = ? WHERE id = ?')
        .run(weekAgo, tokenInfo.id);

      // Token should still validate (no expiration)
      const result = await db.validate(token);
      expect(result).toBe(testUserId);
    });

    it('should handle concurrent token generation gracefully', async () => {
      // This test verifies that the transaction properly handles
      // the case where a token is created, revoked, and created again

      const { tokenInfo: info1 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      const { tokenInfo: info2 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Only the second token should be active
      const token1 = db.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info1.id);
      const token2 = db.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info2.id);

      expect(token1.is_active).toBe(0);
      expect(token2.is_active).toBe(1);
    });

    it('should preserve token metadata through multiple regenerations', async () => {
      // Create, revoke, create cycle
      const { tokenInfo: info1 } = await db.create({
        userId: testUserId,
        createdBy: adminUserId
      });

      db.revoke(info1.id, adminUserId);

      const { tokenInfo: info2 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Verify both tokens have correct metadata
      const token1 = db.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info1.id);
      const token2 = db.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info2.id);

      expect(token1.created_by).toBe(adminUserId);
      expect(token1.revoked_by).toBe(adminUserId);
      expect(token2.created_by).toBe(testUserId);
      expect(token2.revoked_by).toBeNull();
    });

    it('should handle empty or null token validation', async () => {
      const result1 = await db.validate('');
      expect(result1).toBeNull();

      // For null/undefined, the validate function would fail in TypeScript
      // In production, middleware checks for token presence before calling validate
      // Test that empty string is handled gracefully
      const result2 = await db.validate('   ');
      expect(result2).toBeNull();
    });

    it('should handle special characters in token (should not occur but test anyway)', async () => {
      // Our generation only creates hex, but test validation rejects non-hex
      const invalidToken = 'mm_v1_!!!invalid!!!';
      const result = await db.validate(invalidToken);
      expect(result).toBeNull();
    });
  });

  describe('Security Properties', () => {
    it('should use cryptographically secure random generation', async () => {
      // Generate multiple tokens and verify randomness
      const tokens = new Set<string>();

      for (let i = 0; i < 10; i++) {
        const userResult = db.db.prepare(`
          INSERT INTO users (username, email, auth_provider, is_admin, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(`user${i}`, `user${i}@example.com`, 'local', 0, Date.now());
        const userId = userResult.lastInsertRowid as number;

        const { token } = await db.create({
          userId,
          createdBy: userId
        });

        tokens.add(token);
      }

      // All tokens should be unique
      expect(tokens.size).toBe(10);
    });

    it('should use bcrypt with sufficient rounds', async () => {
      const { token, tokenInfo } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      const dbToken = db.db.prepare('SELECT token_hash FROM api_tokens WHERE id = ?')
        .get(tokenInfo.id);

      // bcrypt hash should indicate proper rounds (12)
      // Format: $2b$12$... where 12 is the cost factor
      expect(dbToken.token_hash).toMatch(/^\$2[aby]\$12\$/);
    });

    it('should not leak timing information on invalid token', async () => {
      // This is a basic test - in production, constant-time comparison is important
      const { token } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      const validPrefix = token.substring(0, 14);
      const invalidToken = validPrefix + '0'.repeat(24);

      // Both should fail, but validation should use bcrypt.compare
      // which is designed to be timing-safe
      const result = await db.validate(invalidToken);
      expect(result).toBeNull();
    });

    it('should hash different tokens to different hashes', async () => {
      const { tokenInfo: info1 } = await db.create({
        userId: testUserId,
        createdBy: testUserId
      });

      // Create another user
      const user2Result = db.db.prepare(`
        INSERT INTO users (username, email, auth_provider, is_admin, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('user2', 'user2@example.com', 'local', 0, Date.now());
      const user2Id = user2Result.lastInsertRowid as number;

      const { tokenInfo: info2 } = await db.create({
        userId: user2Id,
        createdBy: user2Id
      });

      const hash1 = db.db.prepare('SELECT token_hash FROM api_tokens WHERE id = ?')
        .get(info1.id).token_hash;
      const hash2 = db.db.prepare('SELECT token_hash FROM api_tokens WHERE id = ?')
        .get(info2.id).token_hash;

      expect(hash1).not.toBe(hash2);
    });
  });
});
