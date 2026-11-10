/**
 * Migration 228: re-file MeshCore MQTT slot-decrypted channel rows under their
 * keyed index (#6308).
 *
 * Before #6308 an MQTT feed filed a frame decrypted with a device-slot key as
 * `channel-<slot>` with NO key fingerprint. Slot N of every source collapsed
 * into one channel, and the rows bypassed the key-access gate (anyone with
 * `messages:read` on the feed read plaintext opened with a key they could not
 * read). New traffic now files under `keyedChannelIndex(secret)` with a
 * fingerprint. This migration repairs history.
 *
 * Recovery. The stored row does not record which key opened it, but its id
 * does encode the channel hash: `mqtt_<src>_` + SHA-256(hash \0 ts \0 text)
 * [0..24] (`frameChannelMessageId`, unchanged since Phase 4). For a row at
 * `channel-N` the migration tests the hash of each distinct secret stored at
 * slot N. A match proves the frame's hash byte; when exactly ONE distinct
 * secret at slot N has that hash the row is re-filed exactly:
 *   fromPublicKey = channel-<1000 + fp[0..4]>, keyFingerprint = fp,
 *   keySourceId / keyChannelIdx = the key's source and slot.
 * The id never changes, so translations and reaction links stay intact.
 *
 * Unrecoverable rows (two secrets with one hash byte, the key was deleted or
 * moved, a sender-less reaction) keep `channel-N` and get the fingerprint
 * 'unresolved'. No read path ever grants that value, so only admins see them.
 *
 * Per-channel state keyed by the old slot number then fans out:
 *   - `user_notification_preferences` (enabled and muted channels) of MQTT
 *     sources gain every keyed index slot N maps to: the keyed targets actually
 *     re-filed from slot N, plus the keyed index of every secret now at slot N
 *     on a `meshcore` source. Originals stay; mutes merge, later muteUntil wins.
 *   - `conversation_read_state` rows (kind meshcore_channel) are copied.
 * Automations (global) and `channel_N` grants are not rewritten.
 *
 * Idempotent on every backend: step 3 touches only `keyFingerprint IS NULL`
 * rows; steps 4 and 5 are unions and insert-if-missing, derived from stored
 * rows plus the current `channels` table, so a crash between steps recovers.
 *
 * Self-contained: the crypto helpers are inlined (a test pins them to the live
 * functions) so later code changes cannot alter what this migration does.
 *
 * One flow, three drivers: `refileCore` is a generator that yields SQL requests
 * (`?` placeholders, logical column names) and receives rows back, so the
 * synchronous SQLite runner and the async PostgreSQL / MySQL runners share it.
 */
import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 228';

export const UNRESOLVED_FINGERPRINT = 'unresolved';
const KEYED_BASE = 1000;
const PAGE_SIZE = 1000;
const UPDATE_CHUNK = 500;

// ============ Inlined helpers (pinned to the live ones by a test) ============

/** Base64 or hex channel secret -> lowercase hex, or null when unusable. */
export function pskToHex(psk: string | null | undefined): string | null {
  if (!psk) return null;
  if (/^[0-9a-fA-F]+$/.test(psk) && psk.length % 2 === 0) return psk.toLowerCase();
  try {
    const buf = Buffer.from(psk, 'base64');
    return buf.length > 0 ? buf.toString('hex') : null;
  } catch {
    return null;
  }
}

/** Hex SHA-256(secret bytes)[0..8]. */
export function channelKeyFingerprint(secretHex: string): string {
  return createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex').slice(0, 16);
}

/** 1000 + the fingerprint's first 2 bytes. */
export function keyedChannelIndex(secretHex: string): number {
  return KEYED_BASE + parseInt(channelKeyFingerprint(secretHex).slice(0, 4), 16);
}

/** The on-air channel hash as `decodeMeshCorePacket` reports it: lowercase hex byte. */
function channelHashOf(fingerprint: string): string {
  return fingerprint.slice(0, 2).toLowerCase();
}

/** `mqtt_<src>_` + SHA-256(hash \0 ts \0 text)[0..24]. */
export function mqttMessageId(sourceId: string, channelHash: string, timestampSec: number, text: string): string {
  const digest = createHash('sha256')
    .update(`${channelHash}\u0000${timestampSec}\u0000${text}`)
    .digest('hex')
    .slice(0, 24);
  return `mqtt_${sourceId}_${digest}`;
}

// ============ Pure planners (exported for tests) ============

export interface SlotKey {
  fingerprint: string;
  sourceId: string;
  isMeshCore: boolean;
}

export interface ChannelKeyDbRow {
  id: number | string;
  sourceId: string | null;
  psk: string | null;
  type: string | null;
}

/**
 * Distinct keys per slot. MeshCore sources first, then by sourceId, so the
 * recorded provenance is deterministic when two sources hold one secret.
 */
export function buildSlotKeys(rows: ChannelKeyDbRow[]): Map<number, SlotKey[]> {
  const sorted = [...rows].sort((a, b) => {
    const am = a.type === 'meshcore' ? 0 : 1;
    const bm = b.type === 'meshcore' ? 0 : 1;
    if (am !== bm) return am - bm;
    return String(a.sourceId ?? '').localeCompare(String(b.sourceId ?? ''));
  });
  const bySlot = new Map<number, SlotKey[]>();
  for (const r of sorted) {
    const hex = pskToHex(r.psk);
    if (!hex || !r.sourceId) continue;
    const slot = Number(r.id);
    if (!Number.isInteger(slot)) continue;
    const fingerprint = channelKeyFingerprint(hex);
    const list = bySlot.get(slot) ?? [];
    if (list.some((k) => k.fingerprint === fingerprint)) continue;
    list.push({ fingerprint, sourceId: r.sourceId, isMeshCore: r.type === 'meshcore' });
    bySlot.set(slot, list);
  }
  return bySlot;
}

export interface MessageRow {
  id: string;
  fromPublicKey: string;
  text: string | null;
  timestamp: number | string | null;
  senderTimestamp: number | string | null;
  reactionRawText: string | null;
}

export type RefileTarget =
  | { resolved: true; fromPublicKey: string; keyFingerprint: string; keySourceId: string; keyChannelIdx: number }
  | { resolved: false };

/** Decide where one legacy MQTT slot row goes. */
export function planRefile(
  sourceId: string,
  row: MessageRow,
  bySlot: Map<number, SlotKey[]>,
): RefileTarget {
  const m = /^channel-(\d+)$/.exec(row.fromPublicKey);
  if (!m) return { resolved: false };
  const slot = parseInt(m[1], 10);
  const keys = bySlot.get(slot) ?? [];
  if (keys.length === 0) return { resolved: false };

  const tsCandidates = new Set<number>();
  const sender = Number(row.senderTimestamp);
  if (Number.isInteger(sender) && sender > 0) tsCandidates.add(sender);
  const wall = Number(row.timestamp);
  if (Number.isFinite(wall) && wall > 0 && wall % 1000 === 0) tsCandidates.add(wall / 1000);
  tsCandidates.add(0); // a clock-less sender: the id keeps the raw 0
  const texts = [...new Set([row.text, row.reactionRawText].filter((t): t is string => typeof t === 'string'))];

  const hashes = [...new Set(keys.map((k) => channelHashOf(k.fingerprint)))];
  const matched: string[] = [];
  for (const hash of hashes) {
    let hit = false;
    for (const ts of tsCandidates) {
      for (const text of texts) {
        if (mqttMessageId(sourceId, hash, ts, text) === row.id) hit = true;
      }
    }
    if (hit) matched.push(hash);
  }
  if (matched.length !== 1) return { resolved: false };
  const candidates = keys.filter((k) => channelHashOf(k.fingerprint) === matched[0]);
  // Two different secrets with one hash byte: the key cannot be told apart.
  if (candidates.length !== 1) return { resolved: false };
  const key = candidates[0];
  return {
    resolved: true,
    fromPublicKey: `channel-${KEYED_BASE + parseInt(key.fingerprint.slice(0, 4), 16)}`,
    keyFingerprint: key.fingerprint,
    keySourceId: key.sourceId,
    keyChannelIdx: slot,
  };
}

interface MuteRule {
  channelId: number;
  muteUntil: number | null;
  [key: string]: unknown;
}

function parseJson(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseEnabled(raw: unknown): number[] {
  return parseJson(raw).filter((n): n is number => typeof n === 'number');
}

function parseMutes(raw: unknown): MuteRule[] {
  return parseJson(raw).filter(
    (r): r is MuteRule =>
      r !== null && typeof r === 'object'
      && typeof (r as MuteRule).channelId === 'number'
      && ((r as MuteRule).muteUntil === null || typeof (r as MuteRule).muteUntil === 'number'),
  );
}

export interface PrefRow {
  id: number;
  sourceId: string;
  enabledChannels: unknown;
  mutedChannels: unknown;
}

export interface PrefUpdate {
  id: number;
  enabledChannels: string | null;
  mutedChannels: string | null;
}

/** Slot -> keyed indices, for one source. */
export type SlotMapping = Map<number, number[]>;

/**
 * Fan out each pref row's slot ids (< 1000) to their keyed indices. Original
 * entries stay. Returns only the rows that change.
 */
export function planPrefFanOut(
  rows: PrefRow[],
  mappingFor: (sourceId: string) => SlotMapping,
  now: number,
): PrefUpdate[] {
  const out: PrefUpdate[] = [];
  for (const row of rows) {
    const mapping = mappingFor(row.sourceId);
    const enabledRaw = typeof row.enabledChannels === 'string' ? row.enabledChannels : null;
    const mutedRaw = typeof row.mutedChannels === 'string' ? row.mutedChannels : null;

    const enabled = parseEnabled(enabledRaw);
    let enabledChanged = false;
    for (const n of [...enabled]) {
      if (n >= KEYED_BASE) continue;
      for (const k of mapping.get(n) ?? []) {
        if (!enabled.includes(k)) {
          enabled.push(k);
          enabledChanged = true;
        }
      }
    }

    const muted = parseMutes(mutedRaw).map((r) => ({ ...r }));
    let mutedChanged = false;
    for (const rule of [...muted]) {
      if (rule.channelId >= KEYED_BASE) continue;
      if (rule.muteUntil !== null && rule.muteUntil <= now) continue; // expired
      for (const k of mapping.get(rule.channelId) ?? []) {
        const existing = muted.find((r) => r.channelId === k);
        if (!existing) {
          muted.push({ ...rule, channelId: k });
          mutedChanged = true;
        } else if (existing.muteUntil !== null && (rule.muteUntil === null || rule.muteUntil > existing.muteUntil)) {
          existing.muteUntil = rule.muteUntil;
          mutedChanged = true;
        }
      }
    }

    if (!enabledChanged && !mutedChanged) continue;
    out.push({
      id: Number(row.id),
      enabledChannels: enabledChanged ? JSON.stringify(enabled) : enabledRaw,
      mutedChannels: mutedChanged ? JSON.stringify(muted) : mutedRaw,
    });
  }
  return out;
}

// ============ Shared flow ============

type Dialect = 'sqlite' | 'postgres' | 'mysql';
interface Req {
  sql: string;
  params: unknown[];
  /** true for INSERT / UPDATE (no rows come back). */
  write: boolean;
}
type Row = Record<string, unknown>;

export interface RefileCounts {
  refiled: number;
  unresolved: number;
  prefsUpdated: number;
  readMarkersCopied: number;
}

function* refileCore(dialect: Dialect): Generator<Req, RefileCounts, Row[]> {
  const q = (name: string): string => (dialect === 'mysql' ? `\`${name}\`` : `"${name}"`);
  // user_notification_preferences / conversation_read_state are snake_case on SQLite.
  const snake = (name: string): string =>
    dialect === 'sqlite' ? name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : name;
  const col = (name: string): string => q(snake(name));
  const counts: RefileCounts = { refiled: 0, unresolved: 0, prefsUpdated: 0, readMarkersCopied: 0 };
  const now = Date.now();

  // 1. MQTT sources.
  const sources = yield { sql: `SELECT id FROM sources WHERE type = 'meshcore_mqtt'`, params: [], write: false };
  const mqtt = sources.map((s) => String(s.id));
  if (mqtt.length === 0) return counts;

  // 2. Every channel key, like runtime findChannelKeysByHash.
  const keyRows = yield {
    sql:
      `SELECT c.id AS id, c.${q('sourceId')} AS ${q('sourceId')}, c.psk AS psk, s.type AS type `
      + `FROM channels c LEFT JOIN sources s ON s.id = c.${q('sourceId')}`,
    params: [],
    write: false,
  };
  const bySlot = buildSlotKeys(keyRows as unknown as ChannelKeyDbRow[]);

  // 3. Re-file per MQTT source, one keyset page at a time.
  for (const src of mqtt) {
    let after = '';
    for (;;) {
      const page = (yield {
        sql:
          `SELECT id, ${q('fromPublicKey')}, ${q('text')}, ${q('timestamp')}, ${q('senderTimestamp')}, ${q('reactionRawText')} `
          + `FROM meshcore_messages WHERE ${q('sourceId')} = ? AND ${q('messageType')} = 'channel' `
          + `AND ${q('keyFingerprint')} IS NULL AND ${q('fromPublicKey')} LIKE 'channel-%' AND id > ? `
          + `ORDER BY id LIMIT ${PAGE_SIZE}`,
        params: [src, after],
        write: false,
      }) as unknown as MessageRow[];
      if (page.length === 0) break;
      after = String(page[page.length - 1].id);

      const groups = new Map<string, { target: RefileTarget; ids: string[] }>();
      for (const row of page) {
        const target = planRefile(src, row, bySlot);
        const gk = target.resolved
          ? `${target.fromPublicKey}|${target.keyFingerprint}|${target.keySourceId}|${target.keyChannelIdx}`
          : 'unresolved';
        const g = groups.get(gk) ?? { target, ids: [] };
        g.ids.push(String(row.id));
        groups.set(gk, g);
      }
      for (const { target, ids } of groups.values()) {
        for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
          const chunk = ids.slice(i, i + UPDATE_CHUNK);
          const marks = chunk.map(() => '?').join(',');
          if (target.resolved) {
            yield {
              sql:
                `UPDATE meshcore_messages SET ${q('fromPublicKey')} = ?, ${q('keyFingerprint')} = ?, `
                + `${q('keySourceId')} = ?, ${q('keyChannelIdx')} = ? `
                + `WHERE ${q('sourceId')} = ? AND ${q('keyFingerprint')} IS NULL AND id IN (${marks})`,
              params: [target.fromPublicKey, target.keyFingerprint, target.keySourceId, target.keyChannelIdx, src, ...chunk],
              write: true,
            };
            counts.refiled += chunk.length;
          } else {
            yield {
              sql:
                `UPDATE meshcore_messages SET ${q('keyFingerprint')} = ? `
                + `WHERE ${q('sourceId')} = ? AND ${q('keyFingerprint')} IS NULL AND id IN (${marks})`,
              params: [UNRESOLVED_FINGERPRINT, src, ...chunk],
              write: true,
            };
            counts.unresolved += chunk.length;
          }
        }
      }
    }
  }

  // 4. Slot -> keyed indices per MQTT source, derived from stored state.
  const mappings = new Map<string, SlotMapping>();
  for (const src of mqtt) {
    const mapping: SlotMapping = new Map();
    const add = (slot: number, keyed: number): void => {
      const list = mapping.get(slot) ?? [];
      if (!list.includes(keyed)) list.push(keyed);
      mapping.set(slot, list);
    };
    const seen = yield {
      sql:
        `SELECT DISTINCT ${q('keyChannelIdx')} AS slot, ${q('fromPublicKey')} AS ${q('channelKey')} FROM meshcore_messages `
        + `WHERE ${q('sourceId')} = ? AND ${q('keyFingerprint')} IS NOT NULL AND ${q('keyFingerprint')} <> ? `
        + `AND ${q('keyChannelIdx')} IS NOT NULL`,
      params: [src, UNRESOLVED_FINGERPRINT],
      write: false,
    };
    for (const r of seen) {
      const m = /^channel-(\d+)$/.exec(String(r.channelKey));
      if (m) add(Number(r.slot), parseInt(m[1], 10));
    }
    for (const [slot, keys] of bySlot) {
      for (const k of keys) {
        if (k.isMeshCore) add(slot, KEYED_BASE + parseInt(k.fingerprint.slice(0, 4), 16));
      }
    }
    mappings.set(src, mapping);
  }

  const inList = mqtt.map(() => '?').join(',');
  const prefRows = yield {
    sql:
      `SELECT id, ${col('sourceId')} AS ${q('sourceId')}, ${col('enabledChannels')} AS ${q('enabledChannels')}, `
      + `${col('mutedChannels')} AS ${q('mutedChannels')} FROM user_notification_preferences `
      + `WHERE ${col('sourceId')} IN (${inList})`,
    params: mqtt,
    write: false,
  };
  const updates = planPrefFanOut(
    prefRows as unknown as PrefRow[],
    (s) => mappings.get(s) ?? new Map(),
    now,
  );
  for (const u of updates) {
    yield {
      sql:
        `UPDATE user_notification_preferences SET ${col('enabledChannels')} = ?, ${col('mutedChannels')} = ? WHERE id = ?`,
      params: [u.enabledChannels, u.mutedChannels, u.id],
      write: true,
    };
    counts.prefsUpdated++;
  }

  // 5. Read markers: copy to each keyed index if missing.
  const marks = yield {
    sql:
      `SELECT ${col('userId')} AS ${q('userId')}, ${col('sourceId')} AS ${q('sourceId')}, `
      + `${col('conversationKey')} AS ${q('conversationKey')}, ${col('lastReadAt')} AS ${q('lastReadAt')} `
      + `FROM conversation_read_state WHERE ${col('conversationKind')} = 'meshcore_channel' `
      + `AND ${col('sourceId')} IN (${inList})`,
    params: mqtt,
    write: false,
  };
  const existing = new Set(marks.map((r) => `${Number(r.userId)}|${r.sourceId}|${r.conversationKey}`));
  for (const r of marks) {
    const key = String(r.conversationKey);
    if (!/^\d+$/.test(key) || Number(key) >= KEYED_BASE) continue;
    for (const k of mappings.get(String(r.sourceId))?.get(Number(key)) ?? []) {
      const tag = `${Number(r.userId)}|${r.sourceId}|${k}`;
      if (existing.has(tag)) continue;
      existing.add(tag);
      yield {
        sql:
          `INSERT INTO conversation_read_state (${col('userId')}, ${col('sourceId')}, ${col('conversationKind')}, `
          + `${col('conversationKey')}, ${col('lastReadAt')}) VALUES (?, ?, 'meshcore_channel', ?, ?)`,
        params: [Number(r.userId), String(r.sourceId), String(k), Number(r.lastReadAt)],
        write: true,
      };
      counts.readMarkersCopied++;
    }
  }
  return counts;
}

function logCounts(backend: string, c: RefileCounts): void {
  logger.info(
    `${LABEL} (${backend}): re-filed ${c.refiled} MQTT channel row(s), ${c.unresolved} unresolved, `
    + `${c.prefsUpdated} notification pref row(s) updated, ${c.readMarkersCopied} read marker(s) copied`,
  );
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const run = db.transaction((): RefileCounts => {
      const gen = refileCore('sqlite');
      let step = gen.next();
      while (!step.done) {
        const { sql, params, write } = step.value;
        const stmt = db.prepare(sql);
        if (write) {
          stmt.run(...params);
          step = gen.next([]);
        } else {
          step = gen.next(stmt.all(...params) as Row[]);
        }
      }
      return step.value;
    });
    logCounts('SQLite', run());
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (data re-file)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration228Postgres(client: import('pg').PoolClient): Promise<void> {
  const gen = refileCore('postgres');
  let step = gen.next();
  while (!step.done) {
    const { sql, params, write } = step.value;
    let n = 0;
    const res = await client.query(sql.replace(/\?/g, () => `$${++n}`), params as unknown[]);
    step = gen.next(write ? [] : (res.rows as Row[]));
  }
  logCounts('PostgreSQL', step.value);
}

// ============ MySQL ============

export async function runMigration228Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  const gen = refileCore('mysql');
  let step = gen.next();
  while (!step.done) {
    const { sql, params, write } = step.value;
    const [rows] = await pool.query(sql, params as unknown[]);
    step = gen.next(write ? [] : (rows as Row[]));
  }
  logCounts('MySQL', step.value);
}
