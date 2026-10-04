/**
 * Cross-source merge of MeshCore message rows for the unified feed (#5587).
 *
 * MeshCore has no mesh packet id, and `meshcore_messages` stores no packet
 * hash, so "the same message heard by two sources" has to be worked out from
 * the stored fields. Each writer stores a reception differently:
 *
 * | Writer               | channel key          | sender            | sender clock              |
 * |----------------------|----------------------|-------------------|---------------------------|
 * | companion (received) | `channel-<slot>`     | `fromName`, split | `timestamp` = sec*1000 if |
 * |                      |                      | by a regex        | plausible, else receipt ms|
 * | repeater (#5551)     | `channel-<1000+h16>` | `fromName`, split | `timestamp` = sec*1000 if |
 * |                      | + `keyFingerprint`   | by the decoder    | > 0, else receipt ms      |
 * | MQTT ingest          | `channel-<slot of    | as repeater       | as repeater               |
 * |                      | the key's source>`   |                   |                           |
 * | our own send         | `toPublicKey`        | local node name   | `senderTimestamp` (channel|
 * |                      |                      |                   | sends only), else none    |
 *
 * This module normalises all four onto one identity and clusters them.
 *
 * ## The key
 *
 * A row's *logical identity* is
 *
 * - channel: (channel secret fingerprint, sender name, body)
 * - DM / room post: (sender key prefix, recipient key prefix, body)
 *
 * plus the *sender second*: the wire `sender_timestamp`, which the sender sets
 * once and every receiver reads back unchanged. Rows that share an identity
 * and a sender second are the same message, whichever sources heard them. That
 * key is exact, so no time window is involved and the same sender repeating
 * the same text a second later stays two rows.
 *
 * A row has no usable sender second when the sender's clock was implausible
 * (no RTC) or when it is one of our own sends that stored none (DMs). Those
 * fall back to a window on `createdAt`, the server's own insert clock, and
 * only ever merge with a reception from a DIFFERENT source: one source hearing
 * the same text twice is two messages.
 *
 * ## Stability
 *
 * Clustering is an online pass in `createdAt` order. A row either joins a
 * cluster an earlier row opened or opens its own, and the cluster's key is
 * fixed by the row that opened it. New rows always sort last, so a reception
 * that arrives later can join a cluster but can never change the key of one
 * already shown.
 */
import { createHash } from 'node:crypto';
import {
  isPlausibleMeshCoreMessageTimeMs,
  isPlausibleMeshCoreTimeMs,
} from '../../utils/meshcoreTimestamp.js';

/**
 * How far apart (server insert time) two receptions from different sources may
 * be and still merge when no sender second is available. Compared against the
 * cluster's first member, so a cluster never spans more than this.
 */
export const MESHCORE_MERGE_WINDOW_MS = 15_000;

/** The `meshcore_messages` fields the merge reads. */
export interface MeshCoreMergeRow {
  id: string;
  fromPublicKey: string;
  fromName?: string | null;
  toPublicKey?: string | null;
  text: string;
  timestamp: number;
  createdAt: number;
  senderTimestamp?: number | null;
  messageType?: string | null;
}

/** One permitted row, tagged with where it came from. */
export interface MeshCoreMergeItem<R extends MeshCoreMergeRow = MeshCoreMergeRow> {
  row: R;
  sourceId: string;
  /**
   * Cross-source channel identity (the secret's fingerprint), or null when the
   * secret is unknown. Ignored for DMs. A channel row with a null identity is
   * never merged across sources.
   */
  channelIdentity: string | null;
}

export interface MeshCoreMergeCluster<I extends MeshCoreMergeItem> {
  dedupKey: string;
  /** One member per source, in `createdAt` order. `members[0]` opened the cluster. */
  members: I[];
}

const CHANNEL_PREFIX = 'channel-';

/** Channel index a row belongs to (`channel-<n>` on either side), or null for a DM. */
export function meshcoreChannelIndexOf(row: {
  fromPublicKey: string;
  toPublicKey?: string | null;
}): number | null {
  const probe = (s: string | null | undefined): number | null => {
    if (s && s.startsWith(CHANNEL_PREFIX)) {
      const n = parseInt(s.slice(CHANNEL_PREFIX.length), 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    return null;
  };
  return probe(row.fromPublicKey) ?? probe(row.toPublicKey);
}

/**
 * Sender name and body of a channel row, the same for every writer.
 *
 * The wire text is `Name: body`. The companion path splits it with a regex
 * (name up to 32 chars, any whitespace after the colon); the frame decoder
 * splits on the first `": "` within 50 chars and refuses names holding
 * `:`, `[` or `]`. So the two disagree on long names, bracketed names and
 * `Name:body`. A received row is therefore rebuilt into its wire text and
 * split again with ONE parser. Our own sends carry no prefix: their name is
 * the stored local node name and their text is already the body.
 */
export function normaliseMeshCoreChannelContent(row: {
  fromPublicKey: string;
  fromName?: string | null;
  text: string;
}): { name: string; body: string } {
  const text = row.text ?? '';
  const storedName = (row.fromName ?? '').trim();
  if (!row.fromPublicKey.startsWith(CHANNEL_PREFIX)) {
    return { name: storedName, body: text.trim() };
  }
  const wire = storedName ? `${storedName}: ${text}` : text;
  const m = wire.match(/^([^:\n]{1,32}):\s*(.*)$/s);
  if (!m) return { name: '', body: wire.trim() };
  return { name: m[1].trim(), body: m[2].trim() };
}

/**
 * The wire `sender_timestamp` (epoch seconds) a row was stamped with, or null
 * when the row does not hold one.
 *
 * - `senderTimestamp` is set on our own channel sends (#5512).
 * - A received row keeps it in `timestamp` as whole seconds. A `timestamp`
 *   with a millisecond part is the receipt clock, written when the sender's
 *   clock was rejected. Our own sends (`sent-` ids) always hold the send
 *   clock there, so they are never read this way.
 *
 * The value must also be plausible against the row's own `createdAt`, by the
 * rule the companion path applies on receipt. The repeater and MQTT paths
 * store any non-zero sender clock, so without this a no-RTC node (its clock
 * restarts from the same default on every boot) would count as "exact" there
 * and as "no clock" on a companion, and would never merge.
 */
export function meshcoreSenderSecond(row: MeshCoreMergeRow): number | null {
  let sec: number | null = null;
  if (typeof row.senderTimestamp === 'number' && row.senderTimestamp > 0) {
    sec = row.senderTimestamp;
  } else if (
    !row.id.startsWith('sent-') &&
    Number.isFinite(row.timestamp) &&
    row.timestamp > 0 &&
    row.timestamp % 1000 === 0
  ) {
    sec = row.timestamp / 1000;
  }
  if (sec === null) return null;
  // A room server replays its backlog on login, so an old post is real history.
  const plausible = row.messageType === 'room_post'
    ? isPlausibleMeshCoreTimeMs(sec * 1000, row.createdAt)
    : isPlausibleMeshCoreMessageTimeMs(sec * 1000, row.createdAt);
  return plausible ? sec : null;
}

/** First 6 bytes of a public key as lowercase hex, or null when it is not one. */
function keyPrefix(key: string | null | undefined): string | null {
  if (!key) return null;
  const k = key.toLowerCase();
  // 12 hex chars is what a received DM stores for its sender (pubkey_prefix).
  return /^[0-9a-f]{12,}$/.test(k) ? k.slice(0, 12) : null;
}

/**
 * The logical identity of a row, equal across sources for the same message.
 * Null when the row cannot be matched across sources at all: a channel whose
 * secret is unknown, or a DM whose endpoints are not both real keys.
 */
export function meshcoreLogicalIdentity(item: MeshCoreMergeItem): string | null {
  const { row } = item;
  if (meshcoreChannelIndexOf(row) !== null) {
    if (!item.channelIdentity) return null;
    const { name, body } = normaliseMeshCoreChannelContent(row);
    return ['c', item.channelIdentity, name, body].join('\u0000');
  }
  const from = keyPrefix(row.fromPublicKey);
  const to = keyPrefix(row.toPublicKey);
  if (!from || !to) return null;
  const kind = row.messageType === 'room_post' ? 'r' : 'd';
  return [kind, from, to, (row.text ?? '').trim()].join('\u0000');
}

/** dedupKey of a cluster opened by a row with an exact sender second. */
export function meshcoreExactDedupKey(identity: string, senderSecond: number): string {
  const digest = createHash('sha256').update(`${identity}\u0000${senderSecond}`).digest('hex').slice(0, 32);
  return `mcx:${digest}`;
}

/** dedupKey of a cluster opened by a row with no sender second (the pre-#5587 key). */
export function meshcoreRowDedupKey(sourceId: string, rowId: string): string {
  return `mc:${sourceId}:${rowId}`;
}

interface OpenCluster<I extends MeshCoreMergeItem> {
  dedupKey: string;
  members: I[];
  sources: Set<string>;
  exactSec: number | null;
  openedAt: number;
}

/**
 * Group permitted rows into logical messages.
 *
 * Callers MUST pass only rows the viewer may read: the per-source permission
 * check and the keyed-row gate run first. Nothing here can then reveal a
 * source, because a cluster is built from, and keyed by, visible rows alone.
 */
export function clusterMeshCoreReceptions<I extends MeshCoreMergeItem>(
  items: I[],
  windowMs: number = MESHCORE_MERGE_WINDOW_MS,
): MeshCoreMergeCluster<I>[] {
  const ordered = [...items].sort(
    (a, b) =>
      a.row.createdAt - b.row.createdAt ||
      (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0) ||
      (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
  );

  const out: OpenCluster<I>[] = [];
  const byIdentity = new Map<string, OpenCluster<I>[]>();
  const open = (item: I, dedupKey: string, exactSec: number | null): OpenCluster<I> => {
    const c: OpenCluster<I> = {
      dedupKey,
      members: [item],
      sources: new Set([item.sourceId]),
      exactSec,
      openedAt: item.row.createdAt,
    };
    out.push(c);
    return c;
  };

  for (const item of ordered) {
    const identity = meshcoreLogicalIdentity(item);
    if (identity === null) {
      open(item, meshcoreRowDedupKey(item.sourceId, item.row.id), null);
      continue;
    }
    let group = byIdentity.get(identity);
    if (!group) {
      group = [];
      byIdentity.set(identity, group);
    }
    const sec = meshcoreSenderSecond(item.row);

    // 1. Exact: same identity, same sender second. Any source, any distance.
    let target = sec !== null ? group.find((c) => c.exactSec === sec) : undefined;

    // 2. Window: the nearest cluster this source is not yet part of. A row
    //    with a sender second may only adopt a cluster that has none; one that
    //    holds a DIFFERENT second is a different message.
    if (!target) {
      for (const c of group) {
        if (c.sources.has(item.sourceId)) continue;
        if (sec !== null && c.exactSec !== null) continue;
        if (item.row.createdAt - c.openedAt > windowMs) continue;
        if (!target || c.openedAt > target.openedAt) target = c;
      }
    }

    if (!target) {
      group.push(
        open(
          item,
          sec !== null
            ? meshcoreExactDedupKey(identity, sec)
            : meshcoreRowDedupKey(item.sourceId, item.row.id),
          sec,
        ),
      );
      continue;
    }
    if (sec !== null && target.exactSec === null) target.exactSec = sec;
    // A second copy on a source already in the cluster (a DM retry heard
    // twice) is the same message: keep that source's first reception.
    if (target.sources.has(item.sourceId)) continue;
    target.sources.add(item.sourceId);
    target.members.push(item);
  }

  return out.map(({ dedupKey, members }) => ({ dedupKey, members }));
}
