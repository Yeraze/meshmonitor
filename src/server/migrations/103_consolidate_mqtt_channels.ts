/**
 * Migration 103: Consolidate MQTT channels by name (issue: channels split by
 * sending slot/hash).
 *
 * For MQTT sources the same logical channel was stored under multiple
 * identities, fragmenting the per-source Channels tab and Unified Messages:
 *
 *   A. `channel_database` accumulated byte-identical duplicate rows for the same
 *      name (a non-atomic find-then-create race during concurrent MQTT ingest,
 *      with no unique constraint). Messages then split across
 *      `CHANNEL_DB_OFFSET + dupId`.
 *   B. `recordChannelFromEnvelope` wrote a `channels` row keyed by the per-packet
 *      `channel` byte — a channel *hash* on MQTT, not a stable 0-7 slot — so one
 *      named channel produced many rows (LongFast at 0/1/8/40, …). Some messages
 *      were also stranded on the raw hash when name resolution missed at ingest.
 *
 * This migration consolidates everything onto the canonical
 * `CHANNEL_DB_OFFSET + channel_database.id` identity:
 *
 *   Part A — merge `channel_database` rows identical in (lower(name), psk):
 *            keep the lowest id, repoint messages + channel_database_permissions,
 *            delete the duplicates.
 *   Part B — for MQTT/bridge sources only (never TCP device slots 0-7): for each
 *            hash-keyed `channels` row (id < OFFSET, named), resolve the name to a
 *            channel_database id (creating a passive row if missing), repoint that
 *            source's messages from the raw id to `OFFSET + dbId`, and delete the
 *            hash `channels` row.
 *
 * Going forward `recordChannelFromEnvelope` no longer writes hash-keyed rows and
 * `findOrCreatePassiveByNameAsync` serializes concurrent creates, so neither
 * splitter recurs.
 *
 * Idempotent: after one run there are no duplicate channel_database rows and no
 * sub-OFFSET MQTT-source channels rows, so re-running is a no-op.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const OFFSET = 100;
const MQTT_TYPES = ['mqtt_bridge', 'mqtt_broker'];
const PASSIVE_DESC = 'Auto-registered for MQTT channel permissions (no PSK)';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 103 (SQLite): consolidating MQTT channels by name...');

    // Part A — merge duplicate channel_database rows by (lower(name), psk).
    const dupGroups = db.prepare(`
      SELECT lower(name) AS lname, psk, MIN(id) AS keepId
      FROM channel_database
      GROUP BY lower(name), psk
      HAVING COUNT(*) > 1
    `).all() as Array<{ lname: string; psk: string; keepId: number }>;

    let mergedDbRows = 0;
    for (const g of dupGroups) {
      const ids = (db.prepare(
        `SELECT id FROM channel_database WHERE lower(name) = ? AND psk = ? ORDER BY id`,
      ).all(g.lname, g.psk) as Array<{ id: number }>).map((r) => r.id);
      const keep = g.keepId;
      for (const dup of ids) {
        if (dup === keep) continue;
        db.prepare(`UPDATE messages SET channel = ? WHERE channel = ?`).run(OFFSET + keep, OFFSET + dup);
        // Drop conflicting permission rows before reassigning — a user may already
        // have a row on `keep`, which would cause a UNIQUE(user_id,channel_database_id) violation.
        db.prepare(
          `DELETE FROM channel_database_permissions
           WHERE channel_database_id = ?
           AND user_id IN (SELECT user_id FROM channel_database_permissions WHERE channel_database_id = ?)`,
        ).run(dup, keep);
        db.prepare(`UPDATE channel_database_permissions SET channel_database_id = ? WHERE channel_database_id = ?`).run(keep, dup);
        db.prepare(`DELETE FROM channel_database WHERE id = ?`).run(dup);
        mergedDbRows++;
      }
    }

    // Part B — collapse hash-keyed channels rows for MQTT sources.
    const placeholders = MQTT_TYPES.map(() => '?').join(', ');
    const mqttSources = (db.prepare(
      `SELECT id FROM sources WHERE type IN (${placeholders})`,
    ).all(...MQTT_TYPES) as Array<{ id: string }>).map((r) => r.id);

    const resolveDbId = (name: string): number => {
      const lower = name.trim().toLowerCase();
      const row = db.prepare(
        `SELECT id FROM channel_database WHERE lower(name) = ? ORDER BY id LIMIT 1`,
      ).get(lower) as { id: number } | undefined;
      if (row) return row.id;
      const now = Date.now();
      const res = db.prepare(`
        INSERT INTO channel_database
          (name, psk, psk_length, description, is_enabled, enforce_name_validation,
           sort_order, decrypted_packet_count, created_at, updated_at)
        VALUES (?, '', 0, ?, 0, 0, 0, 0, ?, ?)
      `).run(name.trim(), PASSIVE_DESC, now, now);
      return Number(res.lastInsertRowid);
    };

    // MQTT sources never sync real device channels, so every `channels` row on
    // them is hash junk — collapse them all (a hash can be 0-255, so we cannot
    // filter on `id < OFFSET`). Messages are only repointed for unambiguous raw
    // hashes (`< OFFSET`); a raw hash >= OFFSET is indistinguishable from a
    // legitimate CHANNEL_DB_OFFSET+dbId message, so we leave those untouched.
    let collapsedChannelRows = 0;
    let repointedMessages = 0;
    for (const sourceId of mqttSources) {
      const rows = db.prepare(`
        SELECT id, name FROM channels
        WHERE sourceId = ? AND name IS NOT NULL AND trim(name) <> ''
      `).all(sourceId) as Array<{ id: number; name: string }>;
      for (const r of rows) {
        const dbId = resolveDbId(r.name);
        if (r.id < OFFSET) {
          const upd = db.prepare(
            `UPDATE messages SET channel = ? WHERE sourceId = ? AND channel = ?`,
          ).run(OFFSET + dbId, sourceId, r.id);
          repointedMessages += upd.changes;
        }
        db.prepare(`DELETE FROM channels WHERE sourceId = ? AND id = ?`).run(sourceId, r.id);
        collapsedChannelRows++;
      }
    }

    logger.info(
      `Migration 103 complete (SQLite): merged ${mergedDbRows} duplicate channel_database row(s), ` +
      `collapsed ${collapsedChannelRows} MQTT channel row(s), repointed ${repointedMessages} message(s).`,
    );
  },

  down: (_db: Database): void => {
    logger.debug('Migration 103 down: not implemented (data consolidation is not reversible)');
  },
};

// ============ PostgreSQL ============

export async function runMigration103Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 103 (PostgreSQL): consolidating MQTT channels by name...');

  let mergedDbRows = 0;
  let collapsedChannelRows = 0;
  let repointedMessages = 0;

  // Part A — merge duplicate channel_database rows by (lower(name), psk).
  const dupGroups = await client.query(`
    SELECT lower(name) AS lname, psk, MIN(id) AS "keepId"
    FROM channel_database
    GROUP BY lower(name), psk
    HAVING COUNT(*) > 1
  `);
  for (const g of dupGroups.rows) {
    const ids = (await client.query(
      `SELECT id FROM channel_database WHERE lower(name) = $1 AND psk = $2 ORDER BY id`,
      [g.lname, g.psk],
    )).rows.map((r) => r.id as number);
    const keep = g.keepId as number;
    for (const dup of ids) {
      if (dup === keep) continue;
      await client.query(`UPDATE messages SET channel = $1 WHERE channel = $2`, [OFFSET + keep, OFFSET + dup]);
      // Drop conflicting permission rows before reassigning (same UNIQUE guard as SQLite).
      await client.query(
        `DELETE FROM channel_database_permissions WHERE "channelDatabaseId" = $1 AND "userId" IN (SELECT "userId" FROM channel_database_permissions WHERE "channelDatabaseId" = $2)`,
        [dup, keep],
      );
      await client.query(`UPDATE channel_database_permissions SET "channelDatabaseId" = $1 WHERE "channelDatabaseId" = $2`, [keep, dup]);
      await client.query(`DELETE FROM channel_database WHERE id = $1`, [dup]);
      mergedDbRows++;
    }
  }

  // Part B — collapse hash-keyed channels rows for MQTT sources.
  const mqttSources = (await client.query(
    `SELECT id FROM sources WHERE type = ANY($1)`,
    [MQTT_TYPES],
  )).rows.map((r) => r.id as string);

  const resolveDbId = async (name: string): Promise<number> => {
    const lower = name.trim().toLowerCase();
    const found = await client.query(
      `SELECT id FROM channel_database WHERE lower(name) = $1 ORDER BY id LIMIT 1`,
      [lower],
    );
    if (found.rows[0]) return found.rows[0].id as number;
    const now = Date.now();
    const ins = await client.query(`
      INSERT INTO channel_database
        (name, psk, "pskLength", description, "isEnabled", "enforceNameValidation",
         "sortOrder", "decryptedPacketCount", "createdAt", "updatedAt")
      VALUES ($1, '', 0, $2, false, false, 0, 0, $3, $4)
      RETURNING id
    `, [name.trim(), PASSIVE_DESC, now, now]);
    return ins.rows[0].id as number;
  };

  for (const sourceId of mqttSources) {
    const rows = (await client.query(`
      SELECT id, name FROM channels
      WHERE "sourceId" = $1 AND name IS NOT NULL AND trim(name) <> ''
    `, [sourceId])).rows as Array<{ id: number; name: string }>;
    for (const r of rows) {
      const dbId = await resolveDbId(r.name);
      if (r.id < OFFSET) {
        const upd = await client.query(
          `UPDATE messages SET channel = $1 WHERE "sourceId" = $2 AND channel = $3`,
          [OFFSET + dbId, sourceId, r.id],
        );
        repointedMessages += upd.rowCount ?? 0;
      }
      await client.query(`DELETE FROM channels WHERE "sourceId" = $1 AND id = $2`, [sourceId, r.id]);
      collapsedChannelRows++;
    }
  }

  logger.info(
    `Migration 103 complete (PostgreSQL): merged ${mergedDbRows} duplicate channel_database row(s), ` +
    `collapsed ${collapsedChannelRows} MQTT channel row(s), repointed ${repointedMessages} message(s).`,
  );
}

// ============ MySQL ============

export async function runMigration103Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 103 (MySQL): consolidating MQTT channels by name...');

  let mergedDbRows = 0;
  let collapsedChannelRows = 0;
  let repointedMessages = 0;

  // Part A — merge duplicate channel_database rows by (lower(name), psk).
  const [dupRows] = await pool.query(`
    SELECT LOWER(name) AS lname, psk, MIN(id) AS keepId
    FROM channel_database
    GROUP BY LOWER(name), psk
    HAVING COUNT(*) > 1
  `);
  for (const g of dupRows as Array<{ lname: string; psk: string; keepId: number }>) {
    const [idRows] = await pool.query(
      `SELECT id FROM channel_database WHERE LOWER(name) = ? AND psk = ? ORDER BY id`,
      [g.lname, g.psk],
    );
    const keep = g.keepId;
    for (const { id: dup } of idRows as Array<{ id: number }>) {
      if (dup === keep) continue;
      await pool.query(`UPDATE messages SET channel = ? WHERE channel = ?`, [OFFSET + keep, OFFSET + dup]);
      // Drop conflicting permission rows before reassigning (same UNIQUE guard as SQLite).
      // MySQL forbids a DELETE that directly sub-selects the same table, so wrap in a derived table.
      await pool.query(
        `DELETE FROM channel_database_permissions WHERE channelDatabaseId = ? AND userId IN (SELECT userId FROM (SELECT userId FROM channel_database_permissions WHERE channelDatabaseId = ?) AS tmp)`,
        [dup, keep],
      );
      await pool.query(`UPDATE channel_database_permissions SET channelDatabaseId = ? WHERE channelDatabaseId = ?`, [keep, dup]);
      await pool.query(`DELETE FROM channel_database WHERE id = ?`, [dup]);
      mergedDbRows++;
    }
  }

  // Part B — collapse hash-keyed channels rows for MQTT sources. Use explicit
  // placeholders rather than relying on mysql2's nested-array `IN (?)` expansion.
  const typePlaceholders = MQTT_TYPES.map(() => '?').join(', ');
  const [srcRows] = await pool.query(
    `SELECT id FROM sources WHERE type IN (${typePlaceholders})`,
    [...MQTT_TYPES],
  );
  const mqttSources = (srcRows as Array<{ id: string }>).map((r) => r.id);

  const resolveDbId = async (name: string): Promise<number> => {
    const lower = name.trim().toLowerCase();
    const [found] = await pool.query(
      `SELECT id FROM channel_database WHERE LOWER(name) = ? ORDER BY id LIMIT 1`,
      [lower],
    );
    const existing = (found as Array<{ id: number }>)[0];
    if (existing) return existing.id;
    const now = Date.now();
    const [ins] = await pool.query(`
      INSERT INTO channel_database
        (name, psk, pskLength, description, isEnabled, enforceNameValidation,
         sortOrder, decryptedPacketCount, createdAt, updatedAt)
      VALUES (?, '', 0, ?, false, false, 0, 0, ?, ?)
    `, [name.trim(), PASSIVE_DESC, now, now]);
    return Number((ins as { insertId: number }).insertId);
  };

  for (const sourceId of mqttSources) {
    const [rows] = await pool.query(`
      SELECT id, name FROM channels
      WHERE sourceId = ? AND name IS NOT NULL AND TRIM(name) <> ''
    `, [sourceId]);
    for (const r of rows as Array<{ id: number; name: string }>) {
      const dbId = await resolveDbId(r.name);
      if (r.id < OFFSET) {
        const [upd] = await pool.query(
          `UPDATE messages SET channel = ? WHERE sourceId = ? AND channel = ?`,
          [OFFSET + dbId, sourceId, r.id],
        );
        repointedMessages += (upd as { affectedRows?: number }).affectedRows ?? 0;
      }
      await pool.query(`DELETE FROM channels WHERE sourceId = ? AND id = ?`, [sourceId, r.id]);
      collapsedChannelRows++;
    }
  }

  logger.info(
    `Migration 103 complete (MySQL): merged ${mergedDbRows} duplicate channel_database row(s), ` +
    `collapsed ${collapsedChannelRows} MQTT channel row(s), repointed ${repointedMessages} message(s).`,
  );
}
