/**
 * Migration 194: `meshcore_nodes.lastAdvertHadPosition` (#5578). PER-SOURCE,
 * like the table.
 *
 * A nullable boolean: did the most recent ADVERT this source heard from the
 * node carry a position?
 *
 *   TRUE  — the latest advert had usable coordinates.
 *   FALSE — the latest advert had none (or 0/0). `upsertNode` still keeps the
 *           last stored coordinates (#3504), so this is the only record that
 *           the node stopped sharing its position.
 *   NULL  — unknown: the row predates this migration, or no advert has been
 *           seen since. The map treats NULL as "show".
 *
 * No backfill: the stored coordinates cannot say which kind the last advert
 * was. Additive and nullable. Idempotent `ADD COLUMN` on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 194';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding meshcore_nodes.lastAdvertHadPosition...`);
    addColumnIfMissing(db, 'meshcore_nodes', 'lastAdvertHadPosition', 'lastAdvertHadPosition INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration194Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding meshcore_nodes.lastAdvertHadPosition...`);
  await addColumnIfMissingPostgres(client, 'meshcore_nodes', 'lastAdvertHadPosition', '"lastAdvertHadPosition" BOOLEAN');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration194Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding meshcore_nodes.lastAdvertHadPosition...`);
  await addColumnIfMissingMysql(pool, 'meshcore_nodes', 'lastAdvertHadPosition', 'lastAdvertHadPosition BOOLEAN NULL');
  logger.info(`${LABEL} complete (MySQL)`);
}
