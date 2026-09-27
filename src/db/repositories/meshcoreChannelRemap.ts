/**
 * MeshCore channel slot remap (#5379).
 *
 * After an on-device channel reorder, every stored reference to a MeshCore
 * channel SLOT INDEX for that source must follow its channel. This repository
 * rewrites all of them in ONE transaction per backend, so a failure leaves the
 * database exactly as it was:
 *
 *  - `meshcore_messages`: `fromPublicKey` / `toPublicKey` = `channel-<idx>`
 *  - `channels`: `id` (the slot) — carries `scope` and the name/PSK mirror
 *  - `conversation_read_state`: kind `meshcore_channel`, key `<idx>`
 *  - `permissions`: `channel_<idx>` grants scoped to this source (slots 1-7)
 *  - `settings`: `source:<id>:meshcoreAutoAckChannels`,
 *    `meshcoreAutoAnnounceChannelIndexes`, `meshcoreAutoResponderTriggers`,
 *    `meshcoreTimerTriggers`
 *
 * The caller passes a full PERMUTATION of slots (see `completeChannelMoves`),
 * so every rewrite is a bijection: no two slots merge and nothing is deleted
 * except permission grants that cannot follow their channel (see below).
 *
 * Key rewrites go through a temporary value first (`channel-mmtmp-N`,
 * `-1000 - N`, `mmtmp-N`) so any cycle, not only a two-way swap, is safe.
 * The older Meshtastic helpers special-case swaps and collapse a 3-cycle.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { BaseRepository } from './base.js';

export interface ChannelSlotMove {
  from: number;
  to: number;
}

export interface ChannelSlotRemapCounts {
  messages: number;
  channels: number;
  readMarkers: number;
  permissionsMoved: number;
  /** Grants for a slot 1-7 channel that moved to slot 8+, which has no `channel_N` resource. */
  permissionsDropped: number;
  settingsUpdated: string[];
}

/** Per-source settings keys that hold MeshCore channel slot indexes. */
export const MESHCORE_CHANNEL_INDEX_SETTING_KEYS = [
  'meshcoreAutoAckChannels',
  'meshcoreAutoAnnounceChannelIndexes',
  'meshcoreAutoResponderTriggers',
  'meshcoreTimerTriggers',
] as const;

/** Highest slot that has its own `channel_N` permission resource. */
const MAX_PERMISSION_CHANNEL = 7;
const CHANNEL_KEY_PREFIX = 'channel-';
const TEMP_KEY_PREFIX = 'channel-mmtmp-';
const TEMP_READ_KEY_PREFIX = 'mmtmp-';
const TEMP_ID_BASE = -1000;

/**
 * Turn the moves of the channels that changed slot into a full permutation.
 *
 * A reorder that also packs channels into 1..n can move a channel into a slot
 * that was EMPTY on the device, and leave the slot it came from empty. Stored
 * rows can still sit at that empty destination (e.g. history of a channel
 * deleted earlier, #5324 — deleting a MeshCore channel keeps its messages).
 * Pairing each such destination with a vacated slot keeps those orphan rows on
 * an empty slot instead of merging them into the moved channel's history.
 */
export function completeChannelMoves(moves: ChannelSlotMove[]): ChannelSlotMove[] {
  const real = moves.filter((m) => m.from !== m.to);
  const froms = new Set(real.map((m) => m.from));
  const tos = new Set(real.map((m) => m.to));
  const vacated = [...froms].filter((s) => !tos.has(s)).sort((a, b) => a - b);
  const filled = [...tos].filter((s) => !froms.has(s)).sort((a, b) => a - b);
  const orphan = filled.map((slot, i) => ({ from: slot, to: vacated[i] }));
  return [...real, ...orphan];
}

function remapCsv(value: string, map: Map<number, number>): string {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!/^\d+$/.test(trimmed)) return trimmed;
      const n = Number(trimmed);
      return String(map.get(n) ?? n);
    })
    .filter((p) => p.length > 0)
    .join(',');
}

/**
 * Rewrite one MeshCore settings value for a slot map. Returns null when the
 * value does not change (or cannot be parsed — it is then left untouched).
 */
export function remapMeshCoreChannelSetting(
  key: string,
  value: string,
  map: Map<number, number>,
): string | null {
  let next: string;
  switch (key) {
    case 'meshcoreAutoAckChannels':
    case 'meshcoreAutoAnnounceChannelIndexes':
      next = remapCsv(value, map);
      break;
    case 'meshcoreAutoResponderTriggers': {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return null; }
      if (!Array.isArray(parsed)) return null;
      const out = parsed.map((t) => {
        if (!t || typeof t !== 'object' || !Array.isArray((t as { channels?: unknown }).channels)) return t;
        const trig = t as { channels: unknown[] };
        return {
          ...trig,
          channels: trig.channels.map((c) => (typeof c === 'number' ? (map.get(c) ?? c) : c)),
        };
      });
      next = JSON.stringify(out);
      if (next === JSON.stringify(parsed)) return null;
      return next;
    }
    case 'meshcoreTimerTriggers': {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return null; }
      if (!Array.isArray(parsed)) return null;
      const out = parsed.map((t) => {
        if (!t || typeof t !== 'object') return t;
        const trig = t as { channelIndex?: unknown };
        if (typeof trig.channelIndex !== 'number') return t;
        return { ...trig, channelIndex: map.get(trig.channelIndex) ?? trig.channelIndex };
      });
      next = JSON.stringify(out);
      if (next === JSON.stringify(parsed)) return null;
      return next;
    }
    default:
      return null;
  }
  return next === value ? null : next;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Drizzle query builders differ per dialect; this repo builds the same queries against whichever table set is active. */
type Op = (tx: any) => any;
/** One write; `count` names the reported bucket its affected rows go to (temp passes have none). */
interface Step { q: Op; count?: 'messages' | 'channels' | 'readMarkers' }

export class MeshCoreChannelRemapRepository extends BaseRepository {
  /**
   * Rewrite every stored slot reference for `sourceId` in one transaction.
   * `moves` must be a permutation (use `completeChannelMoves`). Slot 0 must
   * not appear: MeshCore's Public channel never moves, and legacy slot-0
   * message rows are matched by shape, not by key.
   */
  async remapChannelSlots(sourceId: string, moves: ChannelSlotMove[]): Promise<ChannelSlotRemapCounts> {
    const counts: ChannelSlotRemapCounts = {
      messages: 0,
      channels: 0,
      readMarkers: 0,
      permissionsMoved: 0,
      permissionsDropped: 0,
      settingsUpdated: [],
    };
    const real = moves.filter((m) => m.from !== m.to);
    if (real.length === 0) return counts;
    if (!sourceId) throw new Error('remapChannelSlots requires a sourceId');
    for (const m of real) {
      if (!Number.isInteger(m.from) || !Number.isInteger(m.to) || m.from < 1 || m.to < 1) {
        throw new Error(`remapChannelSlots: invalid move ${m.from}->${m.to} (slot 0 never moves)`);
      }
    }
    const froms = new Set(real.map((m) => m.from));
    const tos = new Set(real.map((m) => m.to));
    if (froms.size !== real.length || tos.size !== real.length
      || [...froms].some((s) => !tos.has(s))) {
      throw new Error('remapChannelSlots: moves must be a permutation (see completeChannelMoves)');
    }
    const map = new Map(real.map((m) => [m.from, m.to]));

    const { meshcoreMessages: msg, channels: ch, conversationReadState: rs, permissions: perm, settings: st } = this.tables;
    const settingKeys = MESHCORE_CHANNEL_INDEX_SETTING_KEYS.map((k) => `source:${sourceId}:${k}`);
    const permResources = real
      .filter((m) => m.from <= MAX_PERMISSION_CHANNEL)
      .map((m) => `channel_${m.from}`);

    const readPerms: Op = (tx) => (permResources.length === 0
      ? null
      : tx.select().from(perm).where(and(eq(perm.sourceId, sourceId), inArray(perm.resource, permResources))));
    const readSettings: Op = (tx) => tx.select().from(st).where(inArray(st.key, settingKeys));

    // Build the write list from a snapshot of the rows we read-modify-write.
    const buildOps = (permRows: any[], settingRows: any[]): Step[] => {
      const ops: Step[] = [];
      const add = (q: Op, count?: Step['count']) => { ops.push({ q, count }); };

      // 1. Messages: both key columns, through a temp key.
      for (const col of ['fromPublicKey', 'toPublicKey'] as const) {
        for (const m of real) {
          add((tx) => tx.update(msg)
            .set({ [col]: `${TEMP_KEY_PREFIX}${m.from}` })
            .where(and(eq(msg.sourceId, sourceId), eq(msg[col], `${CHANNEL_KEY_PREFIX}${m.from}`))));
        }
        for (const m of real) {
          add((tx) => tx.update(msg)
            .set({ [col]: `${CHANNEL_KEY_PREFIX}${m.to}` })
            .where(and(eq(msg.sourceId, sourceId), eq(msg[col], `${TEMP_KEY_PREFIX}${m.from}`))), 'messages');
        }
      }

      // 2. Channel rows (unique on sourceId+id): through a negative temp id.
      for (const m of real) {
        add((tx) => tx.update(ch).set({ id: TEMP_ID_BASE - m.from })
          .where(and(eq(ch.sourceId, sourceId), eq(ch.id, m.from))));
      }
      for (const m of real) {
        add((tx) => tx.update(ch).set({ id: m.to })
          .where(and(eq(ch.sourceId, sourceId), eq(ch.id, TEMP_ID_BASE - m.from))), 'channels');
      }

      // 3. Read markers (unique on user+source+kind+key): through a temp key.
      for (const m of real) {
        add((tx) => tx.update(rs).set({ conversationKey: `${TEMP_READ_KEY_PREFIX}${m.from}` })
          .where(and(eq(rs.sourceId, sourceId), eq(rs.conversationKind, 'meshcore_channel'),
            eq(rs.conversationKey, String(m.from)))));
      }
      for (const m of real) {
        add((tx) => tx.update(rs).set({ conversationKey: String(m.to) })
          .where(and(eq(rs.sourceId, sourceId), eq(rs.conversationKind, 'meshcore_channel'),
            eq(rs.conversationKey, `${TEMP_READ_KEY_PREFIX}${m.from}`))), 'readMarkers');
      }

      // 4. Permissions: delete + re-insert, because SQLite's CHECK constraint
      //    on `resource` rejects any temp value.
      if (permRows.length > 0) {
        add((tx) => tx.delete(perm).where(and(eq(perm.sourceId, sourceId), inArray(perm.resource, permResources))));
        for (const row of permRows) {
          const fromSlot = Number(String(row.resource).slice('channel_'.length));
          const toSlot = map.get(fromSlot) ?? fromSlot;
          if (toSlot > MAX_PERMISSION_CHANNEL) {
            // Slot 8+ has no channel_N resource (it falls back to `messages`).
            // Dropping the grant is the safe choice: carrying it anywhere else
            // would hand the user a different channel.
            counts.permissionsDropped++;
            continue;
          }
          const values: any = {
            userId: row.userId,
            resource: `channel_${toSlot}`,
            canViewOnMap: row.canViewOnMap,
            canRead: row.canRead,
            canWrite: row.canWrite,
            grantedAt: row.grantedAt ?? Date.now(),
            grantedBy: row.grantedBy ?? null,
            sourceId: row.sourceId ?? sourceId,
          };
          if (!this.isSQLite()) values.canDelete = row.canDelete ?? false;
          counts.permissionsMoved++;
          add((tx) => tx.insert(perm).values(values));
        }
      }

      // 5. Settings holding slot indexes.
      for (const row of settingRows) {
        const bareKey = String(row.key).slice(`source:${sourceId}:`.length);
        const next = remapMeshCoreChannelSetting(bareKey, String(row.value ?? ''), map);
        if (next === null) continue;
        counts.settingsUpdated.push(bareKey);
        add((tx) => tx.update(st).set({ value: next, updatedAt: Date.now() }).where(eq(st.key, row.key)));
      }
      return ops;
    };

    if (this.isSQLite()) {
      // better-sqlite3 is synchronous and Drizzle's SQLite transaction refuses
      // a Promise-returning callback. The snapshot reads and the transaction
      // run back to back with no await between them, so nothing interleaves.
      const db = this.db as any;
      const permQuery = readPerms(db);
      const permRows: any[] = permQuery ? permQuery.all() : [];
      const settingRows: any[] = readSettings(db).all();
      const ops = buildOps(permRows, settingRows);
      db.transaction((tx: any) => {
        for (const step of ops) {
          const result = step.q(tx).run();
          if (step.count) counts[step.count] += this.getAffectedRows(result);
        }
      });
      return counts;
    }

    await (this.db as any).transaction(async (tx: any) => {
      const permQuery = readPerms(tx);
      const permRows: any[] = permQuery ? await permQuery : [];
      const settingRows: any[] = await readSettings(tx);
      const ops = buildOps(permRows, settingRows);
      for (const step of ops) {
        const result = await step.q(tx);
        if (step.count) counts[step.count] += this.getAffectedRows(result);
      }
    });
    return counts;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
