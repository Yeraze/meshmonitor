/**
 * Migration: Recalculate estimated positions
 *
 * This migration clears all existing estimated positions and sets a flag
 * to trigger recalculation from historical traceroutes on next startup.
 * The new algorithm aggregates multiple traceroutes with time-weighted averaging
 * for more accurate position estimation.
 */
import Database from 'better-sqlite3';

export const migration = {
  up: (db: Database.Database): void => {
    // Delete all existing estimated position telemetry records
    // This forces a clean recalculation with the new algorithm
    const deleteStmt = db.prepare(`
      DELETE FROM telemetry
      WHERE telemetryType IN ('estimated_latitude', 'estimated_longitude')
    `);
    const result = deleteStmt.run();

    // Log how many records were deleted (available in console if debug enabled)
    console.log(`Migration 038: Deleted ${result.changes} estimated position telemetry records`);

    // Set a flag to indicate that historical positions need to be recalculated
    // This will be checked on startup by the MeshtasticManager
    const now = Date.now();
    const flagStmt = db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, createdAt, updatedAt)
      VALUES ('recalculate_estimated_positions', 'pending', ?, ?)
    `);
    flagStmt.run(now, now);
  },

  down: (db: Database.Database): void => {
    // Remove the recalculation flag
    // Note: Deleted telemetry records cannot be recovered
    const stmt = db.prepare(`
      DELETE FROM settings WHERE key = 'recalculate_estimated_positions'
    `);
    stmt.run();
  }
};
