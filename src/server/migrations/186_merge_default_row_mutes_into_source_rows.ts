/**
 * Migration 186: copy each user's default-row mutes onto their per-source rows
 * (#5487).
 *
 * Before #5487 the Channels tab loaded and saved mutes WITHOUT a sourceId, so
 * every mute landed on the user's '' (default) row of
 * `user_notification_preferences`. Push/Apprise filtering reads the per-source
 * row and only falls back to '' when the source has no row at all. So once a
 * user saved per-source notification settings, every mute they set afterwards
 * stopped blocking push and Apprise. The client now saves mutes on the
 * per-source row; this migration carries the mutes that were stranded on the
 * '' row across so nothing a user muted comes back on upgrade.
 *
 * Behaviour, per user who has a '' row with any active mute:
 *   - Each of that user's EXISTING per-source rows gets the '' row's active
 *     mutes merged in: union by key (`channelId` for channels, `nodeUuid` for
 *     DMs), and where both rows mute the same key the later `muteUntil` wins
 *     (null = indefinite beats any timestamp). The two lists merge separately,
 *     so neither can overwrite the other.
 *   - Expired '' mutes are not copied. Mutes already on the per-source row are
 *     never dropped or shortened.
 *   - Rows for MeshCore / MeshCore-MQTT / Reticulum sources are skipped: the ''
 *     row's mutes were set from the Meshtastic Channels tab and are keyed by
 *     Meshtastic channel number, which would mute an unrelated MeshCore channel
 *     with the same index.
 *   - No rows are created. A source with no row of its own still reads the ''
 *     row (getUserNotificationPreferencesAsync's fallback), so its mutes are
 *     already in force there. Creating rows would also freeze a copy of the
 *     '' row's other settings onto every source.
 *   - The '' row is left untouched: it remains the fallback for sources with
 *     no row and for cross-source views.
 *
 * Idempotent on every backend: the merge is a union with max(muteUntil), so a
 * re-run computes the same lists and skips the UPDATE.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 186';

/** Source types whose channel numbering is NOT Meshtastic's. */
const NON_MESHTASTIC_SOURCE_TYPES = new Set(['meshcore', 'meshcore_mqtt', 'reticulum']);

interface MuteRule {
  muteUntil: number | null;
  [key: string]: unknown;
}

function parseRules(raw: unknown, key: 'channelId' | 'nodeUuid'): MuteRule[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is MuteRule =>
      r !== null && typeof r === 'object'
      && (key === 'channelId' ? typeof r.channelId === 'number' : typeof r.nodeUuid === 'string')
      && (r.muteUntil === null || typeof r.muteUntil === 'number'));
  } catch {
    return [];
  }
}

function isActive(rule: MuteRule, now: number): boolean {
  return rule.muteUntil === null || rule.muteUntil > now;
}

/** The later of two muteUntil values; null (indefinite) wins. */
function laterMuteUntil(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.max(a, b);
}

/**
 * Merge the default row's ACTIVE rules into a per-source row's rules. Returns
 * null when the merge changes nothing (so the caller can skip the write).
 * Exported for unit tests.
 */
export function mergeMuteRules(
  target: MuteRule[],
  incoming: MuteRule[],
  key: 'channelId' | 'nodeUuid',
  now: number,
): MuteRule[] | null {
  const merged = target.map((r) => ({ ...r }));
  let changed = false;
  for (const rule of incoming) {
    if (!isActive(rule, now)) continue;
    const existing = merged.find((r) => r[key] === rule[key]);
    if (!existing) {
      merged.push({ [key]: rule[key], muteUntil: rule.muteUntil });
      changed = true;
      continue;
    }
    const later = laterMuteUntil(existing.muteUntil, rule.muteUntil);
    if (later !== existing.muteUntil) {
      existing.muteUntil = later;
      changed = true;
    }
  }
  return changed ? merged : null;
}

interface PrefRow {
  id: number;
  userId: number;
  sourceId: string;
  mutedChannels: unknown;
  mutedDMs: unknown;
}

interface PlannedUpdate {
  id: number;
  mutedChannels: string;
  mutedDMs: string;
}

/**
 * Backend-agnostic core: given every preferences row and the set of
 * non-Meshtastic source ids, return the per-source rows that need new lists.
 */
export function planMuteMerge(rows: PrefRow[], nonMeshtasticSourceIds: Set<string>, now: number): PlannedUpdate[] {
  const defaults = new Map<number, PrefRow>();
  for (const row of rows) {
    if (row.sourceId === '') defaults.set(Number(row.userId), row);
  }
  const updates: PlannedUpdate[] = [];
  for (const row of rows) {
    if (row.sourceId === '') continue;
    if (nonMeshtasticSourceIds.has(row.sourceId)) continue;
    const def = defaults.get(Number(row.userId));
    if (!def) continue;

    const targetChannels = parseRules(row.mutedChannels, 'channelId');
    const targetDMs = parseRules(row.mutedDMs, 'nodeUuid');
    const channels = mergeMuteRules(targetChannels, parseRules(def.mutedChannels, 'channelId'), 'channelId', now);
    const dms = mergeMuteRules(targetDMs, parseRules(def.mutedDMs, 'nodeUuid'), 'nodeUuid', now);
    if (!channels && !dms) continue;

    // Only the list that changed is rebuilt; the other keeps its stored value
    // (re-serialised from the parsed list only when that list changed).
    updates.push({
      id: Number(row.id),
      mutedChannels: channels ? JSON.stringify(channels) : (typeof row.mutedChannels === 'string' ? row.mutedChannels : JSON.stringify(targetChannels)),
      mutedDMs: dms ? JSON.stringify(dms) : (typeof row.mutedDMs === 'string' ? row.mutedDMs : JSON.stringify(targetDMs)),
    });
  }
  return updates;
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const rows = db.prepare(
      `SELECT id, user_id AS userId, source_id AS sourceId, muted_channels AS mutedChannels, muted_dms AS mutedDMs
         FROM user_notification_preferences`,
    ).all() as PrefRow[];
    let nonMeshtastic = new Set<string>();
    try {
      const sources = db.prepare('SELECT id, type FROM sources').all() as Array<{ id: string; type: string }>;
      nonMeshtastic = new Set(sources.filter((s) => NON_MESHTASTIC_SOURCE_TYPES.has(s.type)).map((s) => s.id));
    } catch {
      /* no sources table (fresh/test DB) — nothing to exclude */
    }
    const updates = planMuteMerge(rows, nonMeshtastic, Date.now());
    const stmt = db.prepare('UPDATE user_notification_preferences SET muted_channels = ?, muted_dms = ? WHERE id = ?');
    const apply = db.transaction((list: PlannedUpdate[]) => {
      for (const u of list) stmt.run(u.mutedChannels, u.mutedDMs, u.id);
    });
    apply(updates);
    logger.info(`${LABEL} (SQLite): merged default-row mutes into ${updates.length} per-source row(s)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (data merge)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration186Postgres(client: import('pg').PoolClient): Promise<void> {
  const { rows } = await client.query(
    `SELECT id, "userId", "sourceId", "mutedChannels", "mutedDMs" FROM user_notification_preferences`,
  );
  let nonMeshtastic = new Set<string>();
  const { rows: hasSources } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'sources'`,
  );
  if (hasSources.length > 0) {
    const { rows: sources } = await client.query('SELECT id, type FROM sources');
    nonMeshtastic = new Set(
      (sources as Array<{ id: string; type: string }>)
        .filter((s) => NON_MESHTASTIC_SOURCE_TYPES.has(s.type)).map((s) => s.id),
    );
  }
  const updates = planMuteMerge(rows as PrefRow[], nonMeshtastic, Date.now());
  for (const u of updates) {
    await client.query(
      `UPDATE user_notification_preferences SET "mutedChannels" = $1, "mutedDMs" = $2 WHERE id = $3`,
      [u.mutedChannels, u.mutedDMs, u.id],
    );
  }
  logger.info(`${LABEL} (PostgreSQL): merged default-row mutes into ${updates.length} per-source row(s)`);
}

// ============ MySQL ============

export async function runMigration186Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  const [rows] = await pool.query(
    'SELECT id, userId, sourceId, mutedChannels, mutedDMs FROM user_notification_preferences',
  );
  let nonMeshtastic = new Set<string>();
  const [hasSources] = await pool.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sources'`,
  );
  if ((hasSources as unknown[]).length > 0) {
    const [sources] = await pool.query('SELECT id, type FROM sources');
    nonMeshtastic = new Set(
      (sources as Array<{ id: string; type: string }>)
        .filter((s) => NON_MESHTASTIC_SOURCE_TYPES.has(s.type)).map((s) => s.id),
    );
  }
  const updates = planMuteMerge(rows as PrefRow[], nonMeshtastic, Date.now());
  for (const u of updates) {
    await pool.query(
      'UPDATE user_notification_preferences SET mutedChannels = ?, mutedDMs = ? WHERE id = ?',
      [u.mutedChannels, u.mutedDMs, u.id],
    );
  }
  logger.info(`${LABEL} (MySQL): merged default-row mutes into ${updates.length} per-source row(s)`);
}
