/**
 * Migration 247: per-node Timezone Override (#6523).
 *
 * Adds a nullable `timezoneOverride` (IANA zone name) to `nodes` and
 * `meshcore_nodes`. Only the timezone override routes write it; packet-ingest
 * upserts never do. The automatic zone is derived from the node's position on
 * read and is never stored. Idempotent on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 247';
const TABLES = ['nodes', 'meshcore_nodes'] as const;
const COLUMN = 'timezoneOverride';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN}...`);
    for (const table of TABLES) addColumnIfMissing(db, table, COLUMN, `${COLUMN} TEXT`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration247Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN}...`);
  for (const table of TABLES) await addColumnIfMissingPostgres(client, table, COLUMN, `"${COLUMN}" TEXT`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration247Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN}...`);
  for (const table of TABLES) await addColumnIfMissingMysql(pool, table, COLUMN, `${COLUMN} VARCHAR(64)`);
  logger.info(`${LABEL} complete (MySQL)`);
}
