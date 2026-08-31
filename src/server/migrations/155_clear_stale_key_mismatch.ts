/**
 * Migration 155: clear stale `keyMismatchDetected` flags left over from the
 * source-blind read bug fixed in this branch.
 *
 * Before the fix, three call sites in `meshtasticManager.ts` read the
 * "existing node" row without scoping to `sourceId`, so a NodeInfo or PKI
 * error observed on one source (e.g. `meshtastic_tcp`) could compare against
 * a different source's stored key. That produced both false-positive
 * `keyMismatchDetected=1` writes AND stuck flags whose clear-branch was
 * blocked by looking at another source's row.
 *
 * We clear the flag only on rows that fit the "PKI-error-path" fingerprint:
 * `lastMeshReceivedKey IS NULL`. The NodeInfo-mismatch path always writes
 * `lastMeshReceivedKey = <the newly received key>` alongside the flag, so a
 * non-null value there is genuine evidence we heard a different key over the
 * air. Rows without that value came from the PKI-error paths (routing error
 * NO_KEY / PKI_FAILED / NO_CHANNEL) which set the flag but no evidence key.
 * Those are advisory — a legitimate current failure re-sets the flag on the
 * next failed DM.
 *
 * `keySecurityIssueDetails` is cleared only when the row has NO other reason
 * to carry a details string (not low-entropy, not duplicate).
 *
 * Idempotent across all three backends — a re-run flips nothing since we
 * gate on `keyMismatchDetected = 1` (SQLite/MySQL) / `TRUE` (PostgreSQL).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 155';

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): clearing stale keyMismatchDetected flags…`);

    const info = db.prepare(`
      UPDATE nodes
      SET keyMismatchDetected = 0,
          keySecurityIssueDetails = CASE
            WHEN (keyIsLowEntropy = 1 OR duplicateKeyDetected = 1) THEN keySecurityIssueDetails
            ELSE NULL
          END
      WHERE keyMismatchDetected = 1
        AND lastMeshReceivedKey IS NULL
    `).run();

    logger.info(`${LABEL} complete (SQLite): cleared ${info.changes} row(s)`);
  },
};

export async function runMigration155Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): clearing stale keyMismatchDetected flags…`);

  const result = await client.query(`
    UPDATE nodes
    SET "keyMismatchDetected" = FALSE,
        "keySecurityIssueDetails" = CASE
          WHEN ("keyIsLowEntropy" = TRUE OR "duplicateKeyDetected" = TRUE) THEN "keySecurityIssueDetails"
          ELSE NULL
        END
    WHERE "keyMismatchDetected" = TRUE
      AND "lastMeshReceivedKey" IS NULL
  `);

  logger.info(`${LABEL} complete (PostgreSQL): cleared ${result.rowCount ?? 0} row(s)`);
}

export async function runMigration155Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): clearing stale keyMismatchDetected flags…`);

  const [result] = await pool.query(`
    UPDATE nodes
    SET keyMismatchDetected = 0,
        keySecurityIssueDetails = CASE
          WHEN (keyIsLowEntropy = 1 OR duplicateKeyDetected = 1) THEN keySecurityIssueDetails
          ELSE NULL
        END
    WHERE keyMismatchDetected = 1
      AND lastMeshReceivedKey IS NULL
  `);

  const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
  logger.info(`${LABEL} complete (MySQL): cleared ${affected} row(s)`);
}
