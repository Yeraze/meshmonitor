/**
 * Migration: Recalculate estimated positions (fix)
 *
 * This migration clears all existing estimated positions and triggers
 * recalculation to fix an issue where the route order was reversed
 * in the initial implementation.
 */
import Database from 'better-sqlite3';

export const migration = {
  up: (db: Database.Database): void => {
    // Delete all existing estimated position telemetry records
    // These were calculated with reversed route order
    const deleteStmt = db.prepare(`
      DELETE FROM telemetry
      WHERE telemetryType IN ('estimated_latitude', 'estimated_longitude')
    `);
    const result = deleteStmt.run();

    console.log(`Migration 039: Deleted ${result.changes} estimated position telemetry records (fix)`);

    // Set the recalculation flag to pending to trigger recalculation
    const now = Date.now();
    const flagStmt = db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, createdAt, updatedAt)
      VALUES ('recalculate_estimated_positions', 'pending', ?, ?)
    `);
    flagStmt.run(now, now);
  },

  down: (db: Database.Database): void => {
    // Note: Deleted telemetry records cannot be recovered
    const stmt = db.prepare(`
      DELETE FROM settings WHERE key = 'recalculate_estimated_positions'
    `);
    stmt.run();
  }
};
