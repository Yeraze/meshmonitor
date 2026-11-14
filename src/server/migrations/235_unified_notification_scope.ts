/**
 * Migration 235: mesh-wide notification settings and one Web Push
 * subscription per browser (#5729, the "unified config" half).
 *
 * Two columns on `user_notification_preferences`, used only on a user's
 * mesh-wide row (sourceId `__mesh__`, MESH_PREFERENCES_SOURCE_ID):
 *
 *   SQLite              push_source_ids / mesh_defaults_saved
 *   PostgreSQL / MySQL  pushSourceIds   / meshDefaultsSaved
 *
 * `pushSourceIds` is a JSON array of the sources Web Push may notify from
 * (NULL = every source the user can read). `meshDefaultsSaved` stays false
 * until the user saves mesh-wide settings; until then the row's other columns
 * are ignored and a source with no row of its own resolves exactly as before
 * (pre-4.0 blob, else the built-in defaults).
 *
 * Existing per-source preference rows are NOT touched: they become per-source
 * overrides as they are, so every user's effective settings stay the same.
 *
 * Push subscriptions collapse to ONE row per (user, browser endpoint), with
 * sourceId `__mesh__`. The row kept is the most recently updated one (its keys
 * are the freshest), the others are deleted. So that no browser starts getting
 * pushes from sources it was never subscribed on, each user's mesh row records
 * the union of the sources their browsers were subscribed on as
 * `pushSourceIds`. Nobody loses a source: every subscribed source is in the
 * list, and every endpoint keeps a row. A row with no user (subscribed before
 * the anonymous account existed) has no preferences to hold a list; it keeps
 * its endpoint and is then gated per source by the anonymous account's
 * permissions at send time.
 *
 * Order makes a crash part way safe to re-run: the preference rows are written
 * first, then the extra subscription rows are deleted, then the kept rows are
 * relabelled. A re-run finds the work done and changes nothing.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { MESH_PREFERENCES_SOURCE_ID } from '../../utils/notificationDefaults.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 235';
const MESH = MESH_PREFERENCES_SOURCE_ID;

/** One push_subscriptions row, as much as the plan needs. */
export interface PushRowLite {
  id: number;
  userId: number | null;
  sourceId: string;
  endpoint: string;
  updatedAt: number;
}

export interface PushCollapsePlan {
  /** Rows to delete: every row of a (user, endpoint) group but the kept one. */
  deleteIds: number[];
  /** Kept rows whose sourceId is not yet `__mesh__`. */
  relabelIds: number[];
  /** userId → the real sources their browsers were subscribed on. */
  sourcesByUser: Map<number, string[]>;
}

/**
 * Decide what to keep, delete and relabel. Pure, so all three backends share
 * one rule and a test can check it without a database.
 */
export function planPushCollapse(rows: PushRowLite[]): PushCollapsePlan {
  const groups = new Map<string, PushRowLite[]>();
  const sources = new Map<number, Set<string>>();
  for (const raw of rows) {
    const row = {
      ...raw,
      id: Number(raw.id),
      userId: raw.userId == null ? null : Number(raw.userId),
      updatedAt: Number(raw.updatedAt) || 0,
    };
    const key = `${row.userId ?? 'anon'}\n${row.endpoint}`;
    const list = groups.get(key);
    if (list) list.push(row); else groups.set(key, [row]);
    if (row.userId !== null && row.sourceId && row.sourceId !== MESH) {
      const set = sources.get(row.userId) ?? new Set<string>();
      set.add(row.sourceId);
      sources.set(row.userId, set);
    }
  }

  const deleteIds: number[] = [];
  const relabelIds: number[] = [];
  for (const list of groups.values()) {
    // A row already relabelled (an earlier, interrupted run) wins; otherwise
    // the newest keys, ties broken by the higher id.
    const keep = list.find(r => r.sourceId === MESH)
      ?? [...list].sort((a, b) => (b.updatedAt - a.updatedAt) || (b.id - a.id))[0];
    for (const r of list) {
      if (r.id !== keep.id) deleteIds.push(r.id);
    }
    if (keep.sourceId !== MESH) relabelIds.push(keep.id);
  }

  const sourcesByUser = new Map<number, string[]>();
  for (const [userId, set] of sources) sourcesByUser.set(userId, [...set].sort());
  return { deleteIds, relabelIds, sourcesByUser };
}

/**
 * The `pushSourceIds` value to store, given what the row already holds.
 * NULL already means "every source", so it stays NULL; a list gains the new
 * sources. Returns undefined when nothing changes.
 */
export function mergePushSourceIds(existing: string | null, add: string[]): string | null | undefined {
  if (existing === null) return undefined;
  let current: string[] = [];
  try {
    const parsed = JSON.parse(existing);
    if (Array.isArray(parsed)) current = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    current = [];
  }
  const before = new Set(current);
  const merged = [...new Set([...current, ...add])].sort();
  // `merged` holds every old entry, so the same size means nothing was added.
  if (merged.length === before.size) return undefined;
  return JSON.stringify(merged);
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): mesh-wide notification settings...`);
    addColumnIfMissing(db, 'user_notification_preferences', 'push_source_ids', 'push_source_ids TEXT');
    addColumnIfMissing(db, 'user_notification_preferences', 'mesh_defaults_saved', 'mesh_defaults_saved INTEGER DEFAULT 0');

    const rows = db.prepare(
      `SELECT id, user_id AS userId, source_id AS sourceId, endpoint, updated_at AS updatedAt FROM push_subscriptions`,
    ).all() as PushRowLite[];
    const plan = planPushCollapse(rows);
    const now = Date.now();

    const findMesh = db.prepare(
      `SELECT push_source_ids AS pushSourceIds FROM user_notification_preferences WHERE user_id = ? AND source_id = ?`,
    );
    const updateMesh = db.prepare(
      `UPDATE user_notification_preferences SET push_source_ids = ?, updated_at = ? WHERE user_id = ? AND source_id = ?`,
    );
    // Every switch that a raw "who has X on" query reads is written OFF, so a
    // row that only holds the source list is never counted as an opt-in.
    const insertMesh = db.prepare(
      `INSERT INTO user_notification_preferences
        (user_id, source_id, enable_web_push, enable_direct_messages, enable_apprise, notify_on_new_node,
         notify_on_traceroute, notify_on_inactive_node, notify_on_low_battery, notify_on_waypoint,
         push_source_ids, mesh_defaults_saved, created_at, updated_at)
       VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, 0, ?, ?)`,
    );
    const deleteRow = db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`);
    const relabelRow = db.prepare(`UPDATE push_subscriptions SET source_id = ? WHERE id = ?`);

    db.transaction(() => {
      for (const [userId, sourceIds] of plan.sourcesByUser) {
        const existing = findMesh.get(userId, MESH) as { pushSourceIds: string | null } | undefined;
        if (existing) {
          const merged = mergePushSourceIds(existing.pushSourceIds, sourceIds);
          if (merged !== undefined) updateMesh.run(merged, now, userId, MESH);
        } else {
          insertMesh.run(userId, MESH, JSON.stringify(sourceIds), now, now);
        }
      }
      for (const id of plan.deleteIds) deleteRow.run(id);
      for (const id of plan.relabelIds) relabelRow.run(MESH, id);
    })();

    logger.info(
      `${LABEL} complete (SQLite): ${plan.sourcesByUser.size} user(s) given a push source list, ` +
      `${plan.deleteIds.length} duplicate subscription row(s) removed, ${plan.relabelIds.length} relabelled`,
    );
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (the per-source subscription rows are gone)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration235Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): mesh-wide notification settings...`);
  await addColumnIfMissingPostgres(client, 'user_notification_preferences', 'pushSourceIds', '"pushSourceIds" TEXT');
  await addColumnIfMissingPostgres(client, 'user_notification_preferences', 'meshDefaultsSaved', '"meshDefaultsSaved" BOOLEAN DEFAULT FALSE');

  const { rows } = await client.query(
    `SELECT id, "userId", "sourceId", endpoint, "updatedAt" FROM push_subscriptions`,
  );
  const plan = planPushCollapse(rows as PushRowLite[]);
  const now = Date.now();

  for (const [userId, sourceIds] of plan.sourcesByUser) {
    const found = await client.query(
      `SELECT "pushSourceIds" FROM user_notification_preferences WHERE "userId" = $1 AND "sourceId" = $2`,
      [userId, MESH],
    );
    if (found.rows.length > 0) {
      const merged = mergePushSourceIds(found.rows[0].pushSourceIds ?? null, sourceIds);
      if (merged !== undefined) {
        await client.query(
          `UPDATE user_notification_preferences SET "pushSourceIds" = $1, "updatedAt" = $2 WHERE "userId" = $3 AND "sourceId" = $4`,
          [merged, now, userId, MESH],
        );
      }
    } else {
      await client.query(
        `INSERT INTO user_notification_preferences
          ("userId", "sourceId", "notifyOnMessage", "notifyOnDirectMessage", "notifyOnChannelMessage", "appriseEnabled",
           "notifyOnNewNode", "notifyOnTraceroute", "notifyOnInactiveNode", "notifyOnLowBattery", "notifyOnWaypoint",
           "pushSourceIds", "meshDefaultsSaved", "createdAt", "updatedAt")
         VALUES ($1, $2, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, $3, FALSE, $4, $5)`,
        [userId, MESH, JSON.stringify(sourceIds), now, now],
      );
    }
  }
  if (plan.deleteIds.length > 0) {
    await client.query(`DELETE FROM push_subscriptions WHERE id = ANY($1::int[])`, [plan.deleteIds]);
  }
  if (plan.relabelIds.length > 0) {
    await client.query(`UPDATE push_subscriptions SET "sourceId" = $1 WHERE id = ANY($2::int[])`, [MESH, plan.relabelIds]);
  }
  logger.info(
    `${LABEL} complete (PostgreSQL): ${plan.sourcesByUser.size} user(s), ` +
    `${plan.deleteIds.length} removed, ${plan.relabelIds.length} relabelled`,
  );
}

// ============ MySQL ============

export async function runMigration235Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): mesh-wide notification settings...`);
  await addColumnIfMissingMysql(pool, 'user_notification_preferences', 'pushSourceIds', 'pushSourceIds TEXT NULL');
  await addColumnIfMissingMysql(pool, 'user_notification_preferences', 'meshDefaultsSaved', 'meshDefaultsSaved BOOLEAN DEFAULT FALSE');

  const [rows] = await pool.query(`SELECT id, userId, sourceId, endpoint, updatedAt FROM push_subscriptions`);
  const plan = planPushCollapse(rows as PushRowLite[]);
  const now = Date.now();

  for (const [userId, sourceIds] of plan.sourcesByUser) {
    const [found] = await pool.query(
      `SELECT pushSourceIds FROM user_notification_preferences WHERE userId = ? AND sourceId = ?`,
      [userId, MESH],
    );
    const list = found as Array<{ pushSourceIds: string | null }>;
    if (list.length > 0) {
      const merged = mergePushSourceIds(list[0].pushSourceIds ?? null, sourceIds);
      if (merged !== undefined) {
        await pool.query(
          `UPDATE user_notification_preferences SET pushSourceIds = ?, updatedAt = ? WHERE userId = ? AND sourceId = ?`,
          [merged, now, userId, MESH],
        );
      }
    } else {
      await pool.query(
        `INSERT INTO user_notification_preferences
          (userId, sourceId, notifyOnMessage, notifyOnDirectMessage, notifyOnChannelMessage, appriseEnabled,
           notifyOnNewNode, notifyOnTraceroute, notifyOnInactiveNode, notifyOnLowBattery, notifyOnWaypoint,
           pushSourceIds, meshDefaultsSaved, createdAt, updatedAt)
         VALUES (?, ?, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, ?, FALSE, ?, ?)`,
        [userId, MESH, JSON.stringify(sourceIds), now, now],
      );
    }
  }
  if (plan.deleteIds.length > 0) {
    await pool.query(`DELETE FROM push_subscriptions WHERE id IN (?)`, [plan.deleteIds]);
  }
  if (plan.relabelIds.length > 0) {
    await pool.query(`UPDATE push_subscriptions SET sourceId = ? WHERE id IN (?)`, [MESH, plan.relabelIds]);
  }
  logger.info(
    `${LABEL} complete (MySQL): ${plan.sourcesByUser.size} user(s), ` +
    `${plan.deleteIds.length} removed, ${plan.relabelIds.length} relabelled`,
  );
}
