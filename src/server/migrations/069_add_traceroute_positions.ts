/**
 * Migration 069: Add position snapshot columns to traceroutes and route_segments tables
 *
 * Fixes issue #1862: Traceroutes through moving nodes show incorrect positions
 *
 * traceroutes table:
 * - routePositions (TEXT) - JSON object mapping nodeNum to {lat, lng, alt?} at traceroute time
 *
 * route_segments table:
 * - fromLatitude (REAL) - latitude of fromNode at recording time
 * - fromLongitude (REAL) - longitude of fromNode at recording time
 * - toLatitude (REAL) - latitude of toNode at recording time
 * - toLongitude (REAL) - longitude of toNode at recording time
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 069: Add position snapshot columns to traceroutes and route_segments');

    try {
      // Check traceroutes columns
      const tracerouteColumns = db.pragma("table_info('traceroutes')") as Array<{ name: string }>;
      const tracerouteColumnNames = new Set(tracerouteColumns.map((col) => col.name));

      if (!tracerouteColumnNames.has('routePositions')) {
        db.exec(`ALTER TABLE traceroutes ADD COLUMN routePositions TEXT`);
        logger.debug('Added routePositions column to traceroutes table');
      } else {
        logger.debug('routePositions column already exists, skipping');
      }

      // Check route_segments columns
      const segmentColumns = db.pragma("table_info('route_segments')") as Array<{ name: string }>;
      const segmentColumnNames = new Set(segmentColumns.map((col) => col.name));

      if (!segmentColumnNames.has('fromLatitude')) {
        db.exec(`ALTER TABLE route_segments ADD COLUMN fromLatitude REAL`);
        logger.debug('Added fromLatitude column to route_segments table');
      } else {
        logger.debug('fromLatitude column already exists, skipping');
      }

      if (!segmentColumnNames.has('fromLongitude')) {
        db.exec(`ALTER TABLE route_segments ADD COLUMN fromLongitude REAL`);
        logger.debug('Added fromLongitude column to route_segments table');
      } else {
        logger.debug('fromLongitude column already exists, skipping');
      }

      if (!segmentColumnNames.has('toLatitude')) {
        db.exec(`ALTER TABLE route_segments ADD COLUMN toLatitude REAL`);
        logger.debug('Added toLatitude column to route_segments table');
      } else {
        logger.debug('toLatitude column already exists, skipping');
      }

      if (!segmentColumnNames.has('toLongitude')) {
        db.exec(`ALTER TABLE route_segments ADD COLUMN toLongitude REAL`);
        logger.debug('Added toLongitude column to route_segments table');
      } else {
        logger.debug('toLongitude column already exists, skipping');
      }

      logger.debug('Migration 069 completed: Position snapshot columns added');
    } catch (error) {
      logger.error('Migration 069 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 069 down: Remove position snapshot columns');

    try {
      logger.debug('Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('The position snapshot columns will remain but will not be used');

      logger.debug('Migration 069 rollback completed');
    } catch (error) {
      logger.error('Migration 069 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add position snapshot columns
 */
export async function runMigration069Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 069 (PostgreSQL): Add position snapshot columns');

  try {
    // Check and add routePositions column to traceroutes
    const routePositionsExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'traceroutes'
          AND column_name = 'routePositions'
      )
    `);

    if (!routePositionsExists.rows[0].exists) {
      await client.query(`ALTER TABLE traceroutes ADD COLUMN "routePositions" TEXT`);
      logger.debug('Added routePositions column to traceroutes table');
    } else {
      logger.debug('routePositions column already exists, skipping');
    }

    // Check and add fromLatitude column to route_segments
    const fromLatitudeExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'route_segments'
          AND column_name = 'fromLatitude'
      )
    `);

    if (!fromLatitudeExists.rows[0].exists) {
      await client.query(`ALTER TABLE route_segments ADD COLUMN "fromLatitude" DOUBLE PRECISION`);
      logger.debug('Added fromLatitude column to route_segments table');
    } else {
      logger.debug('fromLatitude column already exists, skipping');
    }

    // Check and add fromLongitude column to route_segments
    const fromLongitudeExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'route_segments'
          AND column_name = 'fromLongitude'
      )
    `);

    if (!fromLongitudeExists.rows[0].exists) {
      await client.query(`ALTER TABLE route_segments ADD COLUMN "fromLongitude" DOUBLE PRECISION`);
      logger.debug('Added fromLongitude column to route_segments table');
    } else {
      logger.debug('fromLongitude column already exists, skipping');
    }

    // Check and add toLatitude column to route_segments
    const toLatitudeExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'route_segments'
          AND column_name = 'toLatitude'
      )
    `);

    if (!toLatitudeExists.rows[0].exists) {
      await client.query(`ALTER TABLE route_segments ADD COLUMN "toLatitude" DOUBLE PRECISION`);
      logger.debug('Added toLatitude column to route_segments table');
    } else {
      logger.debug('toLatitude column already exists, skipping');
    }

    // Check and add toLongitude column to route_segments
    const toLongitudeExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'route_segments'
          AND column_name = 'toLongitude'
      )
    `);

    if (!toLongitudeExists.rows[0].exists) {
      await client.query(`ALTER TABLE route_segments ADD COLUMN "toLongitude" DOUBLE PRECISION`);
      logger.debug('Added toLongitude column to route_segments table');
    } else {
      logger.debug('toLongitude column already exists, skipping');
    }

    logger.debug('Migration 069 (PostgreSQL): Position snapshot columns added');
  } catch (error) {
    logger.error('Migration 069 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add position snapshot columns
 */
export async function runMigration069Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 069 (MySQL): Add position snapshot columns');

  try {
    const connection = await pool.getConnection();
    try {
      // Check and add routePositions column to traceroutes
      const [routePositionsCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'traceroutes'
          AND COLUMN_NAME = 'routePositions'
      `);

      if ((routePositionsCols as any[]).length === 0) {
        await connection.query(`ALTER TABLE traceroutes ADD COLUMN routePositions TEXT`);
        logger.debug('Added routePositions column to traceroutes table');
      } else {
        logger.debug('routePositions column already exists, skipping');
      }

      // Check and add fromLatitude column to route_segments
      const [fromLatCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'route_segments'
          AND COLUMN_NAME = 'fromLatitude'
      `);

      if ((fromLatCols as any[]).length === 0) {
        await connection.query(`ALTER TABLE route_segments ADD COLUMN fromLatitude DOUBLE`);
        logger.debug('Added fromLatitude column to route_segments table');
      } else {
        logger.debug('fromLatitude column already exists, skipping');
      }

      // Check and add fromLongitude column to route_segments
      const [fromLngCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'route_segments'
          AND COLUMN_NAME = 'fromLongitude'
      `);

      if ((fromLngCols as any[]).length === 0) {
        await connection.query(`ALTER TABLE route_segments ADD COLUMN fromLongitude DOUBLE`);
        logger.debug('Added fromLongitude column to route_segments table');
      } else {
        logger.debug('fromLongitude column already exists, skipping');
      }

      // Check and add toLatitude column to route_segments
      const [toLatCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'route_segments'
          AND COLUMN_NAME = 'toLatitude'
      `);

      if ((toLatCols as any[]).length === 0) {
        await connection.query(`ALTER TABLE route_segments ADD COLUMN toLatitude DOUBLE`);
        logger.debug('Added toLatitude column to route_segments table');
      } else {
        logger.debug('toLatitude column already exists, skipping');
      }

      // Check and add toLongitude column to route_segments
      const [toLngCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'route_segments'
          AND COLUMN_NAME = 'toLongitude'
      `);

      if ((toLngCols as any[]).length === 0) {
        await connection.query(`ALTER TABLE route_segments ADD COLUMN toLongitude DOUBLE`);
        logger.debug('Added toLongitude column to route_segments table');
      } else {
        logger.debug('toLongitude column already exists, skipping');
      }

      logger.debug('Migration 069 (MySQL): Position snapshot columns added');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 069 (MySQL) failed:', error);
    throw error;
  }
}
