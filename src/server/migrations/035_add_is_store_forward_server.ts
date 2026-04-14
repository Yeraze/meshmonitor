/**
 * Migration 035: Add isStoreForwardServer column to nodes table
 *
 * Adds a boolean column to track nodes that are acting as Store & Forward servers,
 * detected via ROUTER_HEARTBEAT packets on PortNum 65.
 */
import type { Database } from 'better-sqlite3';

// SQLite migration
export const migration = {
  up(db: Database) {
    try {
      db.exec(`ALTER TABLE nodes ADD COLUMN "isStoreForwardServer" INTEGER`);
    } catch (e: any) {
      if (!e.message?.includes('duplicate column')) throw e;
    }
  },
};

// PostgreSQL migration
export async function runMigration035Postgres(client: any): Promise<void> {
  await client.query(`
    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS "isStoreForwardServer" BOOLEAN
  `);
}

// MySQL migration
export async function runMigration035Mysql(pool: any): Promise<void> {
  const [rows] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_NAME = 'nodes' AND COLUMN_NAME = 'isStoreForwardServer'
  `);
  if ((rows as any[]).length === 0) {
    await pool.query(`ALTER TABLE nodes ADD COLUMN \`isStoreForwardServer\` BOOLEAN`);
  }
}
