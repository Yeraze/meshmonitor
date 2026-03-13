import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool } from 'mysql2/promise';

export function runMigration084Sqlite(db: Database): void {
  const hasLastMeshReceivedKey = db.prepare(
    "SELECT COUNT(*) as count FROM pragma_table_info('nodes') WHERE name='lastMeshReceivedKey'"
  ).get() as { count: number };
  if (hasLastMeshReceivedKey.count === 0) {
    db.exec("ALTER TABLE nodes ADD COLUMN lastMeshReceivedKey TEXT");
  }

  const hasOldKeyFragment = db.prepare(
    "SELECT COUNT(*) as count FROM pragma_table_info('auto_key_repair_log') WHERE name='oldKeyFragment'"
  ).get() as { count: number };
  if (hasOldKeyFragment.count === 0) {
    db.exec("ALTER TABLE auto_key_repair_log ADD COLUMN oldKeyFragment TEXT");
  }

  const hasNewKeyFragment = db.prepare(
    "SELECT COUNT(*) as count FROM pragma_table_info('auto_key_repair_log') WHERE name='newKeyFragment'"
  ).get() as { count: number };
  if (hasNewKeyFragment.count === 0) {
    db.exec("ALTER TABLE auto_key_repair_log ADD COLUMN newKeyFragment TEXT");
  }
}

export async function runMigration084Postgres(client: PoolClient): Promise<void> {
  const nodesCheck = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes' AND column_name = 'lastMeshReceivedKey'"
  );
  if (nodesCheck.rows.length === 0) {
    await client.query('ALTER TABLE nodes ADD COLUMN "lastMeshReceivedKey" TEXT');
  }

  const oldKeyCheck = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'auto_key_repair_log' AND column_name = 'oldKeyFragment'"
  );
  if (oldKeyCheck.rows.length === 0) {
    await client.query('ALTER TABLE auto_key_repair_log ADD COLUMN "oldKeyFragment" VARCHAR(8)');
  }

  const newKeyCheck = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'auto_key_repair_log' AND column_name = 'newKeyFragment'"
  );
  if (newKeyCheck.rows.length === 0) {
    await client.query('ALTER TABLE auto_key_repair_log ADD COLUMN "newKeyFragment" VARCHAR(8)');
  }
}

export async function runMigration084Mysql(pool: Pool): Promise<void> {
  const [nodesRows] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'nodes' AND column_name = 'lastMeshReceivedKey'"
  );
  if ((nodesRows as any[]).length === 0) {
    await pool.query('ALTER TABLE nodes ADD COLUMN lastMeshReceivedKey VARCHAR(128)');
  }

  const [oldKeyRows] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'auto_key_repair_log' AND column_name = 'oldKeyFragment'"
  );
  if ((oldKeyRows as any[]).length === 0) {
    await pool.query('ALTER TABLE auto_key_repair_log ADD COLUMN oldKeyFragment VARCHAR(8)');
  }

  const [newKeyRows] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'auto_key_repair_log' AND column_name = 'newKeyFragment'"
  );
  if ((newKeyRows as any[]).length === 0) {
    await pool.query('ALTER TABLE auto_key_repair_log ADD COLUMN newKeyFragment VARCHAR(8)');
  }
}
