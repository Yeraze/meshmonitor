/**
 * Shared helper used by data-migration backfills (029, 039, 040, ...) that
 * need to assign legacy NULL-sourceId rows to a "default" source on upgrade
 * from pre-multi-source databases (v3.x → v4.0).
 *
 * Strategy:
 *  - If the sources table already has at least one row, use the oldest as
 *    the default (matches server.ts startup `assignNullSourceIds`).
 *  - Otherwise, synthesize a `meshtastic_tcp` source from environment vars.
 *    The app will reuse / update / replace it on the next boot.
 *
 * Each migration owns its own UPDATE — only the default-source resolution
 * is shared here.
 */
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';

interface LegacyDefaultSource {
  id: string;
  name: string;
  type: string;
  config: string;
  createdAt: number;
  updatedAt: number;
}

export function buildLegacyDefaultSource(): LegacyDefaultSource {
  const now = Date.now();
  const host = process.env.MESHTASTIC_NODE_IP || 'meshtastic.local';
  const port = parseInt(process.env.MESHTASTIC_TCP_PORT || '4403', 10) || 4403;
  return {
    id: randomUUID(),
    name: 'Default',
    type: 'meshtastic_tcp',
    config: JSON.stringify({ host, port }),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Resolve the default sourceId for a SQLite migration. Synthesizes one if
 * the sources table is empty. Returns null if the sources table does not
 * exist (older databases that haven't yet run migration 020).
 */
export function ensureDefaultSourceIdSqlite(
  db: Database,
  migrationLabel: string,
): string | null {
  const sourcesExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sources'`)
    .get();
  if (!sourcesExists) {
    return null;
  }

  const existing = db
    .prepare(`SELECT id FROM sources ORDER BY createdAt ASC, rowid ASC LIMIT 1`)
    .get() as { id: string } | undefined;
  if (existing?.id) {
    return existing.id;
  }

  const legacy = buildLegacyDefaultSource();
  logger.info(`${migrationLabel}: sources table empty; creating default source '${legacy.id}'`);
  db.prepare(`
    INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(legacy.id, legacy.name, legacy.type, legacy.config, legacy.createdAt, legacy.updatedAt);
  return legacy.id;
}

export async function ensureDefaultSourceIdPostgres(
  client: any,
  migrationLabel: string,
): Promise<string | null> {
  const tableCheck = await client.query(
    `SELECT to_regclass('public.sources') AS reg`
  );
  if (!tableCheck.rows[0]?.reg) {
    return null;
  }

  const existing = await client.query(
    `SELECT id FROM sources ORDER BY "createdAt" ASC, id ASC LIMIT 1`
  );
  if (existing.rows[0]?.id) {
    return existing.rows[0].id;
  }

  const legacy = buildLegacyDefaultSource();
  logger.info(`${migrationLabel}: sources table empty; creating default source '${legacy.id}' (PG)`);
  await client.query(
    `INSERT INTO sources (id, name, type, config, enabled, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, true, $5, $6)`,
    [legacy.id, legacy.name, legacy.type, legacy.config, legacy.createdAt, legacy.updatedAt],
  );
  return legacy.id;
}

export async function ensureDefaultSourceIdMysql(
  pool: any,
  migrationLabel: string,
): Promise<string | null> {
  const conn = await pool.getConnection();
  try {
    const [tableRows] = await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'sources'`
    );
    if (!Number((tableRows as any[])[0]?.c ?? 0)) {
      return null;
    }

    const [existingRows] = await conn.query(
      `SELECT id FROM sources ORDER BY createdAt ASC, id ASC LIMIT 1`
    );
    const existing = (existingRows as any[])[0];
    if (existing?.id) {
      return existing.id;
    }

    const legacy = buildLegacyDefaultSource();
    logger.info(`${migrationLabel}: sources table empty; creating default source '${legacy.id}' (MySQL)`);
    await conn.query(
      `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [legacy.id, legacy.name, legacy.type, legacy.config, legacy.createdAt, legacy.updatedAt],
    );
    return legacy.id;
  } finally {
    conn.release();
  }
}
