/**
 * Migration 093: fold the legacy hop-only auto-ack config into the new
 * {Channel,Direct} × {ZeroHop,MultiHop} matrix (discussion #3564).
 *
 * The old scheme tangled message type and hop distance: `autoAckDirect*` keys
 * actually meant "0 hops" (not "direct message"), tapback/reply toggles were
 * keyed only on hop distance (shared across channel & DM), DMs were gated by
 * `autoAckDirectMessages`, and channel replies were re-routed to DM by a single
 * global `autoAckUseDM`. The new scheme gives each of the four cells its own
 * Reply / Tapback / Respond-via-DM toggles.
 *
 * This migration translates every prefix (global keys and each
 * `source:<id>:` namespace) so existing behavior is preserved, then leaves the
 * legacy keys in place (ignored by the new code). Idempotent: new keys are only
 * inserted when absent, so user edits made after upgrade are never clobbered and
 * re-running is a no-op. Settings rows are a plain (key, value) table, so the
 * logic is identical across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 093';

interface SettingRow { key: string; value: string }

/** Legacy auto-ack key suffixes we read (everything after the optional `source:<id>:` prefix). */
const LEGACY_SUFFIXES = [
  'autoAckEnabled',
  'autoAckDirectMessages',
  'autoAckUseDM',
  'autoAckDirectEnabled',
  'autoAckDirectTapbackEnabled',
  'autoAckDirectReplyEnabled',
  'autoAckMultihopEnabled',
  'autoAckMultihopTapbackEnabled',
  'autoAckMultihopReplyEnabled',
] as const;
type LegacySuffix = typeof LEGACY_SUFFIXES[number];

/**
 * Given all settings rows whose key contains "autoAck", compute the new
 * matrix rows to insert (idempotency is handled by the caller's INSERT-if-absent).
 * Pure and total — exported for unit testing.
 */
export function computeMigrationInserts(rows: SettingRow[]): SettingRow[] {
  // Group legacy values by prefix ('' for global, or 'source:<id>:').
  const byPrefix = new Map<string, Partial<Record<LegacySuffix, string>>>();
  for (const row of rows) {
    if (!row || typeof row.key !== 'string') continue;
    for (const suffix of LEGACY_SUFFIXES) {
      if (row.key === suffix || row.key.endsWith(`:${suffix}`)) {
        const prefix = row.key.slice(0, row.key.length - suffix.length);
        // Only treat `prefix + suffix` as legacy when prefix is empty or a `:`-terminated namespace.
        if (prefix !== '' && !prefix.endsWith(':')) break;
        const bucket = byPrefix.get(prefix) ?? {};
        bucket[suffix] = row.value;
        byPrefix.set(prefix, bucket);
        break;
      }
    }
  }

  const out: SettingRow[] = [];
  for (const [prefix, legacy] of byPrefix) {
    // Only migrate prefixes that actually used auto-ack: either the feature was
    // enabled, or the user customized a behavior toggle. Skip sources that never
    // touched it (they fall through to the all-off matrix defaults).
    const hasBehaviorKey = LEGACY_SUFFIXES.some(
      (s) => s !== 'autoAckEnabled' && legacy[s] !== undefined,
    );
    if (legacy.autoAckEnabled !== 'true' && !hasBehaviorKey) continue;

    const values = computeMatrixValues(legacy);
    for (const [suffix, value] of Object.entries(values)) {
      out.push({ key: `${prefix}${suffix}`, value });
    }
  }
  return out;
}

/**
 * Map one prefix's legacy values to the 12 new cell toggles, preserving the old
 * runtime semantics (legacy behavior toggles defaulted ON via `!== 'false'`;
 * the DM-type and DM-routing gates defaulted OFF).
 */
export function computeMatrixValues(legacy: Partial<Record<LegacySuffix, string>>): Record<string, string> {
  const onDefaultTrue = (v: string | undefined) => v === undefined ? true : v !== 'false';
  const isTrue = (v: string | undefined) => v === 'true';

  const dmGate = isTrue(legacy.autoAckDirectMessages);     // DM type was off by default
  const useDm = isTrue(legacy.autoAckUseDM);               // channel→DM routing off by default
  const zeroEnabled = onDefaultTrue(legacy.autoAckDirectEnabled);
  const zeroTap = onDefaultTrue(legacy.autoAckDirectTapbackEnabled);
  const zeroReply = onDefaultTrue(legacy.autoAckDirectReplyEnabled);
  const multiEnabled = onDefaultTrue(legacy.autoAckMultihopEnabled);
  const multiTap = onDefaultTrue(legacy.autoAckMultihopTapbackEnabled);
  const multiReply = onDefaultTrue(legacy.autoAckMultihopReplyEnabled);

  const b = (x: boolean) => (x ? 'true' : 'false');
  return {
    // Channel column — gated at runtime by the autoAckChannels allowlist.
    autoAckChannelZeroHopReplyEnabled: b(zeroEnabled && zeroReply),
    autoAckChannelZeroHopTapbackEnabled: b(zeroEnabled && zeroTap),
    autoAckChannelZeroHopReplyDmEnabled: b(useDm),
    autoAckChannelMultiHopReplyEnabled: b(multiEnabled && multiReply),
    autoAckChannelMultiHopTapbackEnabled: b(multiEnabled && multiTap),
    autoAckChannelMultiHopReplyDmEnabled: b(useDm),
    // Direct column — whole column was off unless DMs were enabled.
    autoAckDirectZeroHopReplyEnabled: b(dmGate && zeroEnabled && zeroReply),
    autoAckDirectZeroHopTapbackEnabled: b(dmGate && zeroEnabled && zeroTap),
    autoAckDirectZeroHopReplyDmEnabled: 'true', // DM replies are inherently DMs
    autoAckDirectMultiHopReplyEnabled: b(dmGate && multiEnabled && multiReply),
    autoAckDirectMultiHopTapbackEnabled: b(dmGate && multiEnabled && multiTap),
    autoAckDirectMultiHopReplyDmEnabled: 'true',
  };
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): folding legacy auto-ack settings into the 2x2 matrix...`);
    // eslint-disable-next-line no-restricted-syntax -- migrations require raw SQL
    const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE '%autoAck%'`).all() as SettingRow[];
    const inserts = computeMigrationInserts(rows);
    if (inserts.length === 0) {
      logger.debug(`${LABEL} (SQLite): no legacy auto-ack config to migrate`);
      return;
    }
    // eslint-disable-next-line no-restricted-syntax -- migrations require raw SQL
    const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
    const tx = db.transaction((items: SettingRow[]) => {
      for (const it of items) stmt.run(it.key, it.value);
    });
    tx(inserts);
    logger.info(`${LABEL} (SQLite): wrote ${inserts.length} matrix setting(s)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (legacy keys are retained, so this is reversible by ignoring the new keys)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration093Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): folding legacy auto-ack settings into the 2x2 matrix...`);
  const res = await client.query(`SELECT key, value FROM settings WHERE key LIKE '%autoAck%'`);
  const inserts = computeMigrationInserts(res.rows as SettingRow[]);
  for (const it of inserts) {
    await client.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [it.key, it.value],
    );
  }
  logger.info(`${LABEL} (PostgreSQL): wrote up to ${inserts.length} matrix setting(s)`);
}

// ============ MySQL ============

export async function runMigration093Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): folding legacy auto-ack settings into the 2x2 matrix...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query("SELECT `key`, value FROM settings WHERE `key` LIKE '%autoAck%'");
    const inserts = computeMigrationInserts(rows as SettingRow[]);
    for (const it of inserts) {
      await conn.query('INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)', [it.key, it.value]);
    }
    logger.info(`${LABEL} (MySQL): wrote up to ${inserts.length} matrix setting(s)`);
  } finally {
    conn.release();
  }
}
