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
 *
 * First boot (#5874 follow-up): migration 050 is the call that fires on a
 * fresh install, and it alone passes `{ firstBoot: true }`. That path also
 * creates the "Default MeshCore" source from the MESHCORE_* vars, and skips
 * the disabled Meshtastic placeholder when only MeshCore is configured. The
 * v3-upgrade backfills (029/039/040) leave it off: their legacy rows are
 * Meshtastic data and belong to a Meshtastic source.
 */
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import {
  buildDefaultMeshtasticSourceConfigFromEnv,
  planDefaultSourcesFromEnv,
} from '../config/defaultSourceConfig.js';

interface LegacyDefaultSource {
  id: string;
  name: string;
  type: string;
  config: string;
  /**
   * 1 when MESHTASTIC_NODE_IP was explicitly set (Docker users with the env
   * configured, etc.); 0 when we fell through to the `meshtastic.local`
   * placeholder. The disabled-by-default branch prevents the auto-source
   * from flapping in a forever reconnect loop against an unreachable
   * address for users who never configured a Meshtastic node — most
   * commonly MeshCore-only macOS desktop installs (discussion #2604).
   */
  enabled: 0 | 1;
  createdAt: number;
  updatedAt: number;
}

export function buildLegacyDefaultSource(): LegacyDefaultSource {
  const now = Date.now();
  // Shared with bootstrapSources.ts so the two Default-source paths match,
  // including the first-boot Virtual Node env vars (#5874).
  const { config, hostProvided } = buildDefaultMeshtasticSourceConfigFromEnv(
    process.env,
    (msg) => logger.warn(msg),
  );
  if (config.virtualNode) {
    logger.info(`📡 Default source gets a Virtual Node on port ${config.virtualNode.port} (ENABLE_VIRTUAL_NODE, first boot)`);
  }
  return {
    id: randomUUID(),
    name: 'Default',
    type: 'meshtastic_tcp',
    config: JSON.stringify(config),
    enabled: hostProvided ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
}

export interface EnsureDefaultSourceOptions {
  /** Plan every first-boot default source, MeshCore included. Migration 050 only. */
  firstBoot?: boolean;
}

/**
 * The rows to insert into an empty sources table. The first row is the one
 * the caller assigns legacy data to (Meshtastic when there is one).
 */
export function buildLegacyDefaultSources(opts: EnsureDefaultSourceOptions = {}): LegacyDefaultSource[] {
  if (!opts.firstBoot) return [buildLegacyDefaultSource()];
  const now = Date.now();
  const plan = planDefaultSourcesFromEnv(process.env, (msg) => logger.warn(msg));
  return plan.map((row, i) => {
    if (row.type === 'meshtastic_tcp' && 'virtualNode' in row.config && row.config.virtualNode) {
      logger.info(`📡 Default source gets a Virtual Node on port ${row.config.virtualNode.port} (ENABLE_VIRTUAL_NODE, first boot)`);
    }
    if (row.type === 'meshcore') {
      const vn = 'virtualNode' in row.config ? row.config.virtualNode : undefined;
      logger.info(
        `📡 Creating "${row.name}" source from MESHCORE_* env vars (first boot)` +
          (vn ? `, Virtual Node on port ${vn.port}` : ''),
      );
    }
    // +i keeps ORDER BY createdAt stable: row 0 stays the oldest.
    return {
      id: randomUUID(),
      name: row.name,
      type: row.type,
      config: JSON.stringify(row.config),
      enabled: row.enabled ? 1 : 0,
      createdAt: now + i,
      updatedAt: now + i,
    };
  });
}

/**
 * Resolve the default sourceId for a SQLite migration. Synthesizes one if
 * the sources table is empty. Returns null if the sources table does not
 * exist (older databases that haven't yet run migration 020).
 */
export function ensureDefaultSourceIdSqlite(
  db: Database,
  migrationLabel: string,
  opts: EnsureDefaultSourceOptions = {},
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

  const rows = buildLegacyDefaultSources(opts);
  const insert = db.prepare(`
    INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const legacy of rows) {
    logger.info(
      `${migrationLabel}: sources table empty; creating ${legacy.type} source '${legacy.name}' '${legacy.id}' (enabled=${legacy.enabled})`,
    );
    insert.run(
      legacy.id,
      legacy.name,
      legacy.type,
      legacy.config,
      legacy.enabled,
      legacy.createdAt,
      legacy.updatedAt,
    );
  }
  return rows[0].id;
}

export async function ensureDefaultSourceIdPostgres(
  client: any,
  migrationLabel: string,
  opts: EnsureDefaultSourceOptions = {},
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

  const rows = buildLegacyDefaultSources(opts);
  for (const legacy of rows) {
    logger.info(
      `${migrationLabel}: sources table empty; creating ${legacy.type} source '${legacy.name}' '${legacy.id}' (enabled=${legacy.enabled}) (PG)`,
    );
    await client.query(
      `INSERT INTO sources (id, name, type, config, enabled, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [legacy.id, legacy.name, legacy.type, legacy.config, legacy.enabled === 1, legacy.createdAt, legacy.updatedAt],
    );
  }
  return rows[0].id;
}

export async function ensureDefaultSourceIdMysql(
  pool: any,
  migrationLabel: string,
  opts: EnsureDefaultSourceOptions = {},
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

    const rows = buildLegacyDefaultSources(opts);
    for (const legacy of rows) {
      logger.info(
        `${migrationLabel}: sources table empty; creating ${legacy.type} source '${legacy.name}' '${legacy.id}' (enabled=${legacy.enabled}) (MySQL)`,
      );
      await conn.query(
        `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [legacy.id, legacy.name, legacy.type, legacy.config, legacy.enabled, legacy.createdAt, legacy.updatedAt],
      );
    }
    return rows[0].id;
  } finally {
    conn.release();
  }
}
