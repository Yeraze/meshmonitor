/**
 * Migration 034: Add viaStoreForward column to messages table
 *
 * Adds a boolean column to track messages received via Store & Forward replay,
 * following the same pattern as the existing viaMqtt column.
 */
import type { Database } from 'better-sqlite3';

// SQLite migration
export const migration = {
  up(db: Database) {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN "viaStoreForward" INTEGER`);
    } catch (e: any) {
      if (!e.message?.includes('duplicate column')) throw e;
    }
  },
};

// PostgreSQL migration
export async function runMigration034Postgres(client: any): Promise<void> {
  await client.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS "viaStoreForward" BOOLEAN
  `);
}

// MySQL migration
export async function runMigration034Mysql(pool: any): Promise<void> {
  const [rows] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'viaStoreForward'
  `);
  if ((rows as any[]).length === 0) {
    await pool.query(`ALTER TABLE messages ADD COLUMN \`viaStoreForward\` BOOLEAN`);
  }
}
