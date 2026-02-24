/**
 * Migration 025: Add API tokens table
 *
 * Creates the api_tokens table to enable token-based authentication for the
 * new versioned API (/api/v1/*). Each user can have one active API token that
 * inherits their account permissions.
 *
 * This enables:
 * - Token-based authentication for external integrations
 * - Single token per user model with regeneration capability
 * - Audit trail of token creation and usage
 * - Token revocation without affecting user account
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 025: Add API tokens table');

    try {
      // STEP 1: Create api_tokens table
      db.exec(`
        CREATE TABLE api_tokens (
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
          FOREIGN KEY (revoked_by) REFERENCES users(id),
          CHECK (is_active IN (0, 1))
        )
      `);
      logger.debug('✅ Created api_tokens table');

      // STEP 2: Create indices for efficient lookups
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash);
        CREATE INDEX IF NOT EXISTS idx_api_tokens_is_active ON api_tokens(is_active);
        CREATE INDEX IF NOT EXISTS idx_api_tokens_prefix ON api_tokens(prefix);
      `);
      logger.debug('✅ Created api_tokens indices');

      // STEP 3: Create unique index to enforce one active token per user
      db.exec(`
        CREATE UNIQUE INDEX idx_api_tokens_one_per_user
        ON api_tokens(user_id)
        WHERE is_active = 1
      `);
      logger.debug('✅ Created unique constraint for one active token per user');

      logger.debug('✅ Migration 025 completed successfully');
      logger.debug('ℹ️  Users can now generate API tokens for external integrations');
    } catch (error: any) {
      logger.error('❌ Migration 025 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Reverting migration 025: Remove API tokens table');

    try {
      // Drop the api_tokens table (indices are dropped automatically)
      db.exec(`DROP TABLE IF EXISTS api_tokens`);

      logger.debug('✅ Migration 025 reverted');
    } catch (error) {
      logger.error('❌ Migration 025 rollback failed:', error);
      throw error;
    }
  }
};
