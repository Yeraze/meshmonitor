import type Database from 'better-sqlite3';

export const migration = {
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        createdBy INTEGER
      )
    `);
  }
};

export async function runMigration020Postgres(client: any): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL,
      "createdBy" INTEGER
    )
  `);
}

export async function runMigration020Mysql(pool: any): Promise<void> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'sources'`
    );
    if (rows[0].cnt === 0) {
      await conn.query(`
        CREATE TABLE sources (
          id VARCHAR(36) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          type VARCHAR(32) NOT NULL,
          config VARCHAR(4096) NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT true,
          createdAt BIGINT NOT NULL,
          updatedAt BIGINT NOT NULL,
          createdBy INTEGER
        )
      `);
    }
  } finally {
    conn.release();
  }
}
