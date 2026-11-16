/**
 * Migration 238: turn the heartbeat on (60 s) for existing MeshCore Companion
 * sources that never stored a value (#6437).
 *
 * `sources.config` is JSON text. A Companion is a `type = 'meshcore'` source
 * whose config `deviceType` is not `'repeater'` (the form and the manager both
 * treat an absent deviceType as a Companion). Only a config with NO
 * `heartbeatIntervalSeconds` key gets 60; an explicit stored value (30, 0,
 * anything) is left alone, and so are Repeaters and every other source type.
 *
 * One-time. The probe is a local `get_device_time` read on the phone link, so
 * no radio airtime is involved. Re-running changes nothing: after the first run
 * every Companion row carries the key. Unparseable config is skipped.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 238';
const COMPANION_HEARTBEAT_SECONDS = 60;

/** Returns the updated config JSON, or null when the row must not change. */
export function withCompanionHeartbeat(configJson: string): string | null {
  let cfg: unknown;
  try {
    cfg = JSON.parse(configJson);
  } catch {
    return null;
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const obj = cfg as Record<string, unknown>;
  if (obj.deviceType === 'repeater') return null;
  if (Object.prototype.hasOwnProperty.call(obj, 'heartbeatIntervalSeconds')) return null;
  return JSON.stringify({ ...obj, heartbeatIntervalSeconds: COMPANION_HEARTBEAT_SECONDS });
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): default heartbeat for MeshCore Companion sources...`);
    const rows = db.prepare(`SELECT id, config FROM sources WHERE type = 'meshcore'`).all() as Array<{ id: string; config: string }>;
    const update = db.prepare('UPDATE sources SET config = ? WHERE id = ?');
    let changed = 0;
    db.transaction(() => {
      for (const row of rows) {
        const next = withCompanionHeartbeat(row.config);
        if (next === null) continue;
        update.run(next, row.id);
        changed++;
      }
    })();
    logger.info(`${LABEL} complete (SQLite): ${changed} source(s) updated`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (cannot tell which rows it changed)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration238Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): default heartbeat for MeshCore Companion sources...`);
  const { rows } = await client.query(`SELECT id, config FROM sources WHERE type = 'meshcore'`);
  let changed = 0;
  for (const row of rows as Array<{ id: string; config: string }>) {
    const next = withCompanionHeartbeat(row.config);
    if (next === null) continue;
    await client.query('UPDATE sources SET config = $1 WHERE id = $2', [next, row.id]);
    changed++;
  }
  logger.info(`${LABEL} complete (PostgreSQL): ${changed} source(s) updated`);
}

// ============ MySQL ============

export async function runMigration238Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): default heartbeat for MeshCore Companion sources...`);
  const [rows] = await pool.query(`SELECT id, config FROM sources WHERE type = 'meshcore'`);
  let changed = 0;
  for (const row of rows as Array<{ id: string; config: string }>) {
    const next = withCompanionHeartbeat(row.config);
    if (next === null) continue;
    await pool.query('UPDATE sources SET config = ? WHERE id = ?', [next, row.id]);
    changed++;
  }
  logger.info(`${LABEL} complete (MySQL): ${changed} source(s) updated`);
}
