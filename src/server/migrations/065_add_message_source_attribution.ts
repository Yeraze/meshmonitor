/**
 * Migration 065: Add source_ip and source_path columns to messages table.
 *
 * Adds two nullable text columns so operators can trace WHICH client/API caller
 * injected a given message via MeshMonitor's send endpoint:
 *
 *   - source_ip   TEXT NULL   — client IP for HTTP-injected sends (honors
 *                               X-Forwarded-For when trust proxy is configured);
 *                               NULL for radio-received, MQTT-bridged, and
 *                               internally-generated messages.
 *   - source_path TEXT NULL   — categorical source: 'http_api' | 'tcp_radio'
 *                               | 'mqtt_bridge' | 'system'.
 *
 * Backward compatible: existing rows get NULL for both columns (no breaking
 * change for existing deployments / API consumers).
 */
import type { Database } from 'better-sqlite3';

// SQLite migration
export const migration = {
  up(db: Database) {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN source_ip TEXT`);
    } catch (e: any) {
      if (!e.message?.includes('duplicate column')) throw e;
    }
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN source_path TEXT`);
    } catch (e: any) {
      if (!e.message?.includes('duplicate column')) throw e;
    }
  },
};

// PostgreSQL migration
export async function runMigration065Postgres(client: any): Promise<void> {
  await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_ip TEXT`);
  await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_path TEXT`);
}

// MySQL migration
export async function runMigration065Mysql(pool: any): Promise<void> {
  const [ipRows] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'source_ip'
  `);
  if ((ipRows as any[]).length === 0) {
    await pool.query(`ALTER TABLE messages ADD COLUMN source_ip VARCHAR(64)`);
  }

  const [pathRows] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'source_path'
  `);
  if ((pathRows as any[]).length === 0) {
    await pool.query(`ALTER TABLE messages ADD COLUMN source_path VARCHAR(16)`);
  }
}
