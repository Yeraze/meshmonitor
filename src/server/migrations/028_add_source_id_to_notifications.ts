/**
 * Migration 028: Add sourceId to notification tables
 *
 * Phase A of the multi-source notifications refactor (MeshMonitor 4.0).
 * Makes push_subscriptions and user_notification_preferences per-source
 * so each source can have its own subscription set and preference row.
 *
 * Changes to both tables:
 *   - add sourceId column (TEXT / "sourceId" TEXT / sourceId VARCHAR(64))
 *   - backfill: existing rows with NULL sourceId are DELETED (not migrated)
 *     This is the simpler/safer approach because:
 *       * push subscriptions are user-recoverable (browser re-subscribes)
 *       * notification preferences default to sane values on first load
 *       * we avoid having to guess which source legacy rows "belonged" to
 *   - replace old UNIQUE(userId) / UNIQUE(endpoint) constraints with
 *     composite uniques that include sourceId
 *   - add (userId, sourceId) index on both tables
 *
 * Idempotent on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 028 (SQLite): Adding sourceId to notification tables...');

    // --- push_subscriptions ---
    const hasPushTable = db
      .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='push_subscriptions'")
      .get() as { count: number };
    if (hasPushTable.count > 0) {
      try {
        db.exec(`ALTER TABLE push_subscriptions ADD COLUMN source_id TEXT`);
        logger.debug('Added source_id column to push_subscriptions');
      } catch (e: any) {
        if (/duplicate column/i.test(e.message)) {
          logger.debug('push_subscriptions.source_id already exists, skipping');
        } else {
          throw e;
        }
      }

      // Backfill: delete any rows with NULL source_id (user-recoverable data)
      try {
        const result = db
          .prepare(`DELETE FROM push_subscriptions WHERE source_id IS NULL`)
          .run();
        if (result.changes > 0) {
          logger.info(`Deleted ${result.changes} legacy push_subscriptions rows with NULL source_id`);
        }
      } catch (e: any) {
        logger.debug(`Could not backfill-delete push_subscriptions: ${e.message}`);
      }

      try {
        db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_user_endpoint_source ON push_subscriptions(user_id, endpoint, source_id)`
        );
      } catch (e: any) {
        logger.debug(`Could not create push_subscriptions composite unique: ${e.message}`);
      }
      try {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_source ON push_subscriptions(user_id, source_id)`
        );
      } catch (e: any) {
        logger.debug(`Could not create push_subscriptions user/source index: ${e.message}`);
      }
    } else {
      logger.debug('push_subscriptions table does not exist yet, skipping');
    }

    // --- user_notification_preferences ---
    const hasPrefsTable = db
      .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='user_notification_preferences'")
      .get() as { count: number };
    if (hasPrefsTable.count > 0) {
      try {
        db.exec(`ALTER TABLE user_notification_preferences ADD COLUMN source_id TEXT`);
        logger.debug('Added source_id column to user_notification_preferences');
      } catch (e: any) {
        if (/duplicate column/i.test(e.message)) {
          logger.debug('user_notification_preferences.source_id already exists, skipping');
        } else {
          throw e;
        }
      }

      // Backfill: delete any rows with NULL source_id
      try {
        const result = db
          .prepare(`DELETE FROM user_notification_preferences WHERE source_id IS NULL`)
          .run();
        if (result.changes > 0) {
          logger.info(`Deleted ${result.changes} legacy user_notification_preferences rows with NULL source_id`);
        }
      } catch (e: any) {
        logger.debug(`Could not backfill-delete user_notification_preferences: ${e.message}`);
      }

      // Drop the old UNIQUE(user_id) index from migration 015 if present,
      // replace with UNIQUE(user_id, source_id).
      try {
        db.exec(`DROP INDEX IF EXISTS idx_user_notification_preferences_user_id`);
      } catch (e: any) {
        logger.debug(`Could not drop old prefs unique index: ${e.message}`);
      }
      try {
        db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notification_preferences_user_source ON user_notification_preferences(user_id, source_id)`
        );
      } catch (e: any) {
        logger.debug(`Could not create prefs composite unique: ${e.message}`);
      }
      try {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_source_idx ON user_notification_preferences(user_id, source_id)`
        );
      } catch (e: any) {
        logger.debug(`Could not create prefs user/source index: ${e.message}`);
      }
    } else {
      logger.debug('user_notification_preferences table does not exist yet, skipping');
    }

    logger.info('Migration 028 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 028 down: Not implemented (column drops are destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration028Postgres(client: any): Promise<void> {
  logger.info('Running migration 028 (PostgreSQL): Adding sourceId to notification tables...');

  // --- push_subscriptions ---
  const pushTable = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'push_subscriptions'"
  );
  if (pushTable.rows.length > 0) {
    await client.query(
      `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
    );

    // Backfill: delete rows with NULL sourceId (user-recoverable)
    const delRes = await client.query(
      `DELETE FROM push_subscriptions WHERE "sourceId" IS NULL`
    );
    if (delRes.rowCount && delRes.rowCount > 0) {
      logger.info(`Deleted ${delRes.rowCount} legacy push_subscriptions rows with NULL sourceId`);
    }

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'idx_push_subscriptions_user_endpoint_source'
        ) THEN
          CREATE UNIQUE INDEX idx_push_subscriptions_user_endpoint_source
            ON push_subscriptions ("userId", endpoint, "sourceId");
        END IF;
      END $$;
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_source ON push_subscriptions ("userId", "sourceId")`
    );
  } else {
    logger.debug('push_subscriptions table does not exist yet, skipping');
  }

  // --- user_notification_preferences ---
  const prefsTable = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_notification_preferences'"
  );
  if (prefsTable.rows.length > 0) {
    await client.query(
      `ALTER TABLE user_notification_preferences ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
    );

    const delRes = await client.query(
      `DELETE FROM user_notification_preferences WHERE "sourceId" IS NULL`
    );
    if (delRes.rowCount && delRes.rowCount > 0) {
      logger.info(`Deleted ${delRes.rowCount} legacy user_notification_preferences rows with NULL sourceId`);
    }

    // Drop the old single-column unique constraint from migration 015
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'user_notification_preferences_userId_unique'
        ) THEN
          ALTER TABLE user_notification_preferences DROP CONSTRAINT "user_notification_preferences_userId_unique";
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'idx_user_notification_preferences_user_source'
        ) THEN
          CREATE UNIQUE INDEX idx_user_notification_preferences_user_source
            ON user_notification_preferences ("userId", "sourceId");
        END IF;
      END $$;
    `);
  } else {
    logger.debug('user_notification_preferences table does not exist yet, skipping');
  }

  logger.info('Migration 028 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration028Mysql(pool: any): Promise<void> {
  logger.info('Running migration 028 (MySQL): Adding sourceId to notification tables...');

  const conn = await pool.getConnection();
  try {
    // --- push_subscriptions ---
    const [pushTableRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'push_subscriptions'`
    );
    if (Array.isArray(pushTableRows) && pushTableRows.length > 0) {
      const [pushColRows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'push_subscriptions' AND COLUMN_NAME = 'sourceId'`
      );
      if (!Array.isArray(pushColRows) || pushColRows.length === 0) {
        await conn.query(`ALTER TABLE push_subscriptions ADD COLUMN sourceId VARCHAR(64)`);
        logger.debug('Added sourceId to push_subscriptions');
      }

      const [delRes]: any = await conn.query(
        `DELETE FROM push_subscriptions WHERE sourceId IS NULL`
      );
      if (delRes?.affectedRows > 0) {
        logger.info(`Deleted ${delRes.affectedRows} legacy push_subscriptions rows with NULL sourceId`);
      }

      const [pushIdxRows] = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        ['push_subscriptions', 'idx_push_subscriptions_user_endpoint_source']
      );
      if (!(pushIdxRows as any)[0]?.cnt) {
        await conn.query(
          `CREATE UNIQUE INDEX idx_push_subscriptions_user_endpoint_source ON push_subscriptions(userId, endpoint(255), sourceId)`
        );
      }
      const [pushIdxRows2] = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        ['push_subscriptions', 'idx_push_subscriptions_user_source']
      );
      if (!(pushIdxRows2 as any)[0]?.cnt) {
        await conn.query(
          `CREATE INDEX idx_push_subscriptions_user_source ON push_subscriptions(userId, sourceId)`
        );
      }
    }

    // --- user_notification_preferences ---
    const [prefsTableRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences'`
    );
    if (Array.isArray(prefsTableRows) && prefsTableRows.length > 0) {
      const [prefsColRows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences' AND COLUMN_NAME = 'sourceId'`
      );
      if (!Array.isArray(prefsColRows) || prefsColRows.length === 0) {
        await conn.query(`ALTER TABLE user_notification_preferences ADD COLUMN sourceId VARCHAR(64)`);
        logger.debug('Added sourceId to user_notification_preferences');
      }

      const [delRes]: any = await conn.query(
        `DELETE FROM user_notification_preferences WHERE sourceId IS NULL`
      );
      if (delRes?.affectedRows > 0) {
        logger.info(`Deleted ${delRes.affectedRows} legacy user_notification_preferences rows with NULL sourceId`);
      }

      // Drop old single-column unique index from migration 015 if present
      const [oldIdxRows] = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        ['user_notification_preferences', 'idx_user_notification_preferences_userId']
      );
      if ((oldIdxRows as any)[0]?.cnt) {
        try {
          await conn.query(`DROP INDEX idx_user_notification_preferences_userId ON user_notification_preferences`);
        } catch (e: any) {
          logger.debug(`Could not drop old prefs unique index: ${e.message}`);
        }
      }
      // MySQL sometimes auto-creates a unique from the schema's .unique() — try dropping by the drizzle default name as well
      const [autoIdxRows] = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        ['user_notification_preferences', 'userId']
      );
      if ((autoIdxRows as any)[0]?.cnt) {
        try {
          await conn.query(`DROP INDEX userId ON user_notification_preferences`);
        } catch (e: any) {
          logger.debug(`Could not drop auto prefs unique: ${e.message}`);
        }
      }

      const [prefsIdxRows] = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        ['user_notification_preferences', 'idx_user_notification_preferences_user_source']
      );
      if (!(prefsIdxRows as any)[0]?.cnt) {
        await conn.query(
          `CREATE UNIQUE INDEX idx_user_notification_preferences_user_source ON user_notification_preferences(userId, sourceId)`
        );
      }
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 028 complete (MySQL)');
}
