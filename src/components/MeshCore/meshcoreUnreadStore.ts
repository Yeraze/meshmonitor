/**
 * Shared client-side unread-marker store for MeshCore (#3891, #4607).
 *
 * MeshCore messages are NOT covered by the Meshtastic server-side read-tracking
 * (`read_messages` joins the Meshtastic `messages` table only). Originally the
 * operator's last-read markers therefore lived only in localStorage, scoped by
 * sourceId:
 *
 *   - channels: `meshmonitor-meshcore-channel-lastread-<sourceId>` → { idx: ms }
 *               (pre-existing key from #3703 — kept as-is for backward compat)
 *   - DMs:      `meshmonitor-meshcore-dm-lastread-<sourceId>`      → { peerKey: ms }
 *   - rooms:    `meshmonitor-meshcore-room-lastread-<sourceId>`    → { roomKey: ms } (#6261)
 *
 * That is per-BROWSER, which is the wrong shape for an app with real
 * multi-user auth: two operators sharing a machine shared one set of markers,
 * and the same operator on a second device started from zero. #4607 moved the
 * durable copy server-side into `conversation_read_state` (per user, per
 * source, per conversation) and left localStorage in place as (a) a synchronous
 * cache so the first paint is not blank while the server round-trip is in
 * flight, and (b) the fallback when there is no server read-state at all.
 *
 * The synchronous read API is unchanged on purpose — every caller
 * (MeshCoreChannelsView / MeshCoreDirectMessagesView / useMeshCoreUnread)
 * reads markers during render. Reads merge localStorage with the hydrated
 * server snapshot by taking the MAX per key, so whichever side is ahead wins
 * and a marker can never appear to rewind. Writes update localStorage
 * immediately (so the UI reacts at once) and are mirrored to the server
 * through the injected transport.
 *
 * The transport is INJECTED rather than imported so this module stays free of
 * React and fetch: `MeshCorePage` wires it once with a CSRF-aware fetcher. With
 * no transport configured the module behaves exactly as it did before #4607,
 * which is also what keeps the pre-existing unit tests meaningful.
 */

import { uniquePrefixMatch } from '../../utils/meshcoreKeyMatch';
import { meshcoreReceiptTimeMs } from '../../utils/meshcoreMessageTime';

const CHANGE_EVENT = 'meshcore-unread-changed';

export const channelLastReadKey = (sourceId: string) =>
  `meshmonitor-meshcore-channel-lastread-${sourceId}`;
export const dmLastReadKey = (sourceId: string) =>
  `meshmonitor-meshcore-dm-lastread-${sourceId}`;

export const roomLastReadKey = (sourceId: string) =>
  `meshmonitor-meshcore-room-lastread-${sourceId}`;

/** Conversation families as named by the server's `conversation_read_state`. */
export type MeshCoreReadKind = 'meshcore_channel' | 'meshcore_dm' | 'meshcore_room';

/** Server-side read-state transport, injected by the page (see module header). */
export interface ReadStateTransport {
  /** Fetch every watermark this user holds on `sourceId`. */
  load(sourceId: string): Promise<Record<MeshCoreReadKind, Record<string, number>> | null>;
  /** Persist one watermark. Failures are swallowed — markers are best-effort. */
  save(sourceId: string, kind: MeshCoreReadKind, conversationKey: string, lastReadAt: number): Promise<void>;
  /**
   * Persist many watermarks in one request (mark-all-read, #6261). Optional:
   * without it {@link markManyRead} falls back to one `save` per entry.
   */
  saveMany?(
    sourceId: string,
    entries: Array<{ kind: MeshCoreReadKind; conversationKey: string; lastReadAt: number }>,
  ): Promise<void>;
}

let transport: ReadStateTransport | null = null;

/**
 * Hydrated server snapshots, per sourceId. Populated by {@link hydrateReadState}
 * and merged into every synchronous read.
 */
const serverState = new Map<string, { channels: Record<string, number>; dms: Record<string, number>; rooms: Record<string, number> }>();

/** Sources whose hydration has already been kicked off (once per session). */
const hydrated = new Set<string>();

/**
 * Install the server transport. Call once per app; passing `null` restores the
 * localStorage-only behaviour (used by tests and by builds with no session).
 */
export function configureReadStateTransport(next: ReadStateTransport | null): void {
  transport = next;
  // A new (or removed) transport means a new session/fetcher, so the cached
  // snapshot no longer belongs to whoever is now signed in. Dropping it here
  // stops one user's markers surviving a logout into the next user's view.
  serverState.clear();
  hydrated.clear();
}

/** Test seam: forget every hydrated snapshot and re-arm hydration. */
export function resetReadStateCache(): void {
  serverState.clear();
  hydrated.clear();
}

/**
 * Pull this user's server-side watermarks for `sourceId` into the cache.
 * Idempotent per source unless `force` is set. Safe to call unconditionally:
 * with no transport, or on a 403 (anonymous / unpermitted), it resolves
 * quietly and the store keeps using localStorage alone.
 */
export async function hydrateReadState(sourceId: string, force = false): Promise<void> {
  if (!sourceId || !transport) return;
  if (hydrated.has(sourceId) && !force) return;
  hydrated.add(sourceId);
  try {
    const data = await transport.load(sourceId);
    if (!data) return;
    serverState.set(sourceId, {
      channels: { ...(data.meshcore_channel ?? {}) },
      dms: { ...(data.meshcore_dm ?? {}) },
      rooms: { ...(data.meshcore_room ?? {}) },
    });
    notifyChanged();
  } catch {
    // Best-effort: an unreachable server must not break the unread UI.
    hydrated.delete(sourceId);
  }
}

function notifyChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    /* non-DOM env (tests) — safe to ignore */
  }
}

function loadMap<K extends string | number>(storageKey: string): Record<K, number> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {} as Record<K, number>;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<K, number>) : ({} as Record<K, number>);
  } catch {
    return {} as Record<K, number>;
  }
}

/**
 * Merge a server snapshot into a local map, keeping the LATER marker per key.
 * Max rather than "server wins": a marker written in this tab is already in
 * localStorage but may not have round-tripped yet, and letting an older server
 * value overwrite it would make the unread dot flicker back on.
 */
function mergeLatest(
  local: Record<string, number>,
  remote: Record<string, number> | undefined
): Record<string, number> {
  if (!remote) return local;
  const out: Record<string, number> = { ...local };
  for (const [key, ts] of Object.entries(remote)) {
    if (!Number.isFinite(ts)) continue;
    if ((out[key] ?? 0) < ts) out[key] = ts;
  }
  return out;
}

/** Read the per-channel last-read map (channel idx → ms) for a source. */
export function loadChannelLastRead(sourceId: string): Record<number, number> {
  if (!sourceId) return {};
  const local = loadMap<number>(channelLastReadKey(sourceId)) as Record<string, number>;
  return mergeLatest(local, serverState.get(sourceId)?.channels) as Record<number, number>;
}

/** Read the per-peer DM last-read map (canonical peer key → ms) for a source. */
export function loadDmLastRead(sourceId: string): Record<string, number> {
  if (!sourceId) return {};
  const local = loadMap<string>(dmLastReadKey(sourceId));
  return mergeLatest(local, serverState.get(sourceId)?.dms);
}

/** Read the per-room last-read map (room pubkey → ms) for a source (#6261). */
export function loadRoomLastRead(sourceId: string): Record<string, number> {
  if (!sourceId) return {};
  const local = loadMap<string>(roomLastReadKey(sourceId));
  return mergeLatest(local, serverState.get(sourceId)?.rooms);
}

function persist(storageKey: string, map: Record<string | number, number>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    /* storage full / disabled — unread state is best-effort */
  }
  // Notify same-tab listeners (storage event only fires cross-tab).
  notifyChanged();
}

/**
 * Mirror a marker to the server and into the local snapshot. Never throws.
 *
 * With no transport this is a complete no-op — in particular it must NOT seed
 * `serverState`. That map is a cache OF the server; populating it without one
 * would make markers outlive a `localStorage.clear()` and reappear in a
 * session that never wrote them.
 */
function mirrorToSnapshot(sourceId: string, kind: MeshCoreReadKind, key: string, ts: number): void {
  const snapshot = serverState.get(sourceId) ?? { channels: {}, dms: {}, rooms: {} };
  const bucket = kind === 'meshcore_channel' ? snapshot.channels : kind === 'meshcore_room' ? snapshot.rooms : snapshot.dms;
  if ((bucket[key] ?? 0) < ts) bucket[key] = ts;
  serverState.set(sourceId, snapshot);
}

function pushToServer(sourceId: string, kind: MeshCoreReadKind, key: string, ts: number): void {
  if (!transport) return;

  mirrorToSnapshot(sourceId, kind, key, ts);

  void transport.save(sourceId, kind, key, ts).catch(() => {
    /* best-effort — localStorage already reflects the marker */
  });
}

/**
 * Mark a channel read up to `ts` (defaults to now). Never moves the marker
 * backwards. No-op when the marker is already at/after `ts`.
 */
export function markChannelRead(sourceId: string, idx: number, ts: number = Date.now()): void {
  if (!sourceId) return;
  const map = loadChannelLastRead(sourceId);
  if ((map[idx] ?? 0) >= ts) return;
  map[idx] = ts;
  persist(channelLastReadKey(sourceId), map);
  pushToServer(sourceId, 'meshcore_channel', String(idx), ts);
}

/**
 * Follow an on-device channel reorder (#5379): move each channel's last-read
 * marker from its old slot key to its new one, in localStorage and in the
 * hydrated server snapshot. The server already moved its own rows in the same
 * transaction as the rest of the remap, so nothing is pushed back. `moves` is
 * a permutation, so no two markers land on one key.
 */
export function remapChannelLastRead(sourceId: string, moves: Array<{ from: number; to: number }>): void {
  if (!sourceId || moves.length === 0) return;
  const map = new Map(moves.map((m) => [String(m.from), String(m.to)]));
  const remap = (rec: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [key, ts] of Object.entries(rec)) out[map.get(key) ?? key] = ts;
    return out;
  };
  const snapshot = serverState.get(sourceId);
  if (snapshot) snapshot.channels = remap(snapshot.channels);
  persist(channelLastReadKey(sourceId), remap(loadMap<string>(channelLastReadKey(sourceId))));
}

/**
 * Mark a DM conversation (with `peerKey`) read up to `ts` (defaults to now).
 * `peerKey` must be the canonical peer key (see {@link canonicalizePeerKey}).
 * Never moves the marker backwards.
 */
export function markDmRead(sourceId: string, peerKey: string, ts: number = Date.now()): void {
  if (!sourceId || !peerKey) return;
  const map = loadDmLastRead(sourceId);
  if ((map[peerKey] ?? 0) >= ts) return;
  map[peerKey] = ts;
  persist(dmLastReadKey(sourceId), map);
  pushToServer(sourceId, 'meshcore_dm', peerKey, ts);
}

/**
 * Mark a room read up to `ts` (defaults to now). `roomKey` is the room's
 * contact public key. Never moves the marker backwards (#6261).
 */
export function markRoomRead(sourceId: string, roomKey: string, ts: number = Date.now()): void {
  if (!sourceId || !roomKey) return;
  const map = loadRoomLastRead(sourceId);
  if ((map[roomKey] ?? 0) >= ts) return;
  map[roomKey] = ts;
  persist(roomLastReadKey(sourceId), map);
  pushToServer(sourceId, 'meshcore_room', roomKey, ts);
}

/**
 * Mark many conversations read in one pass (mark-all-read, #6261). Monotonic
 * per key; one localStorage write per kind, one change event, and one server
 * request when the transport has `saveMany` (else one `save` per entry).
 */
export function markManyRead(
  sourceId: string,
  entries: ReadonlyArray<{ kind: MeshCoreReadKind; key: string; ts: number }>,
): void {
  if (!sourceId || entries.length === 0) return;
  const maps: Record<MeshCoreReadKind, Record<string, number>> = {
    meshcore_channel: loadChannelLastRead(sourceId) as Record<string, number>,
    meshcore_dm: loadDmLastRead(sourceId),
    meshcore_room: loadRoomLastRead(sourceId),
  };
  const storageKeys: Record<MeshCoreReadKind, string> = {
    meshcore_channel: channelLastReadKey(sourceId),
    meshcore_dm: dmLastReadKey(sourceId),
    meshcore_room: roomLastReadKey(sourceId),
  };
  const changed: Array<{ kind: MeshCoreReadKind; conversationKey: string; lastReadAt: number }> = [];
  const touched = new Set<MeshCoreReadKind>();
  for (const { kind, key, ts } of entries) {
    if (!key || !Number.isFinite(ts)) continue;
    const map = maps[kind];
    if ((map[key] ?? 0) >= ts) continue;
    map[key] = ts;
    touched.add(kind);
    changed.push({ kind, conversationKey: key, lastReadAt: ts });
  }
  if (changed.length === 0) return;
  for (const kind of touched) {
    try {
      localStorage.setItem(storageKeys[kind], JSON.stringify(maps[kind]));
    } catch {
      /* storage full / disabled — unread state is best-effort */
    }
  }
  notifyChanged();

  if (!transport) return;
  for (const e of changed) mirrorToSnapshot(sourceId, e.kind, e.conversationKey, e.lastReadAt);
  if (transport.saveMany) {
    void transport.saveMany(sourceId, changed).catch(() => { /* best-effort */ });
  } else {
    for (const e of changed) {
      void transport.save(sourceId, e.kind, e.conversationKey, e.lastReadAt).catch(() => { /* best-effort */ });
    }
  }
}

/**
 * Subscribe to unread-marker changes (both same-tab writes via this module and
 * cross-tab `storage` events). Returns an unsubscribe function.
 */
export function subscribeUnreadChanged(cb: () => void): () => void {
  const onCustom = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith('meshmonitor-meshcore-channel-lastread-') || e.key.startsWith('meshmonitor-meshcore-dm-lastread-') || e.key.startsWith('meshmonitor-meshcore-room-lastread-')) {
      cb();
    }
  };
  window.addEventListener(CHANGE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Canonicalize a peer key to its full contact pubkey. Inbound `contact_message`
 * events carry only a `pubkey_prefix` (~12 hex), while contacts and outbound
 * messages use the full 64-hex key; resolving both to the same canonical key
 * keeps a single peer from being tracked as two conversations. Mirrors the
 * canonicalization in MeshCoreDirectMessagesView so read-markers written by the
 * view line up with the unread computed by the hook.
 */
export function canonicalizePeerKey(
  key: string,
  contacts: ReadonlyArray<{ publicKey?: string }>,
): string {
  if (!key) return key;
  // Unique match only (#5349): an ambiguous prefix stays as-is rather than
  // being folded into whichever colliding contact comes first.
  return uniquePrefixMatch(contacts, key)?.publicKey ?? key;
}

/** True when `a` and `b` reference the same key allowing for prefix matching. */
export function peerKeysMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

/** True when a key is a synthetic per-channel pseudo-key (`channel-<idx>`). */
export function isChannelPseudoKey(k: string | null | undefined): boolean {
  return typeof k === 'string' && k.startsWith('channel-');
}

type UnreadMessage = { fromPublicKey: string; toPublicKey?: string; timestamp: number; receivedAt?: number; createdAt?: number; messageType?: string; filtered?: string; reactionEmoji?: string | null };

/**
 * Latest received (peer to us) DM time per canonical peer key, by receipt time
 * (#5973). Own-sent messages, room posts, reactions, ignored rows and channel
 * pseudo-keys never count. Empty without `selfKey`.
 */
export function latestIncomingDmByPeer(params: {
  messages: ReadonlyArray<UnreadMessage>;
  contacts: ReadonlyArray<{ publicKey?: string }>;
  selfKey: string | undefined;
}): Map<string, number> {
  const { messages, contacts, selfKey } = params;
  const latestIncoming = new Map<string, number>();
  // Without knowing our own key we can't tell received from sent, so we can't
  // reliably attribute "unread" — report nothing rather than false positives.
  if (!selfKey) return latestIncoming;
  // Memoize canonicalization per raw key: a conversation has many messages from
  // the same sender prefix, so this collapses the per-message O(contacts) scan
  // to one scan per distinct key.
  const canonCache = new Map<string, string>();
  const canon = (key: string): string => {
    const hit = canonCache.get(key);
    if (hit !== undefined) return hit;
    const resolved = canonicalizePeerKey(key, contacts);
    canonCache.set(key, resolved);
    return resolved;
  };
  for (const m of messages) {
    if (!m.toPublicKey) continue;
    if (m.messageType === 'room_post') continue;
    // Ignored messages never count as unread (#5408), nor do reactions (#5759).
    if (m.filtered || m.reactionEmoji) continue;
    if (isChannelPseudoKey(m.fromPublicKey) || isChannelPseudoKey(m.toPublicKey)) continue;
    // Only received messages count as unread — sender is NOT us, recipient IS us.
    if (peerKeysMatch(m.fromPublicKey, selfKey)) continue;
    if (!peerKeysMatch(m.toPublicKey, selfKey)) continue;
    const peer = canon(m.fromPublicKey);
    if (peerKeysMatch(peer, selfKey)) continue;
    const prev = latestIncoming.get(peer) ?? 0;
    // Receipt time (#5973), the clock the DM view marks read with.
    const ts = meshcoreReceiptTimeMs(m);
    if (ts > prev) latestIncoming.set(peer, ts);
  }
  return latestIncoming;
}

/**
 * Compute the set of DM peers with unread INCOMING messages: a peer is unread
 * when its latest *received* message (from the peer, to us) is newer than the
 * stored last-read marker. Own-sent messages never create unread. Keys are
 * canonical peer keys.
 */
export function computeUnreadDmPeers(params: {
  messages: ReadonlyArray<UnreadMessage>;
  contacts: ReadonlyArray<{ publicKey?: string }>;
  selfKey: string | undefined;
  dmLastRead: Record<string, number>;
  /** Peer currently open in the DM view — never reported as unread. */
  activePeerKey?: string | null;
}): Set<string> {
  const { messages, contacts, selfKey, dmLastRead, activePeerKey } = params;
  if (!selfKey) return new Set<string>();
  const latestIncoming = latestIncomingDmByPeer({ messages, contacts, selfKey });
  const activeCanonical = activePeerKey ? canonicalizePeerKey(activePeerKey, contacts) : null;
  const unread = new Set<string>();
  for (const [peer, ts] of latestIncoming) {
    if (activeCanonical && peerKeysMatch(peer, activeCanonical)) continue;
    if (ts > (dmLastRead[peer] ?? 0)) unread.add(peer);
  }
  return unread;
}

/** Prefix-aware key match, both directions (mirrors `buildRoomFilter`). */
function roomKeyMatches(storedKey: string, roomKey: string): boolean {
  return storedKey === roomKey || storedKey.startsWith(roomKey) || roomKey.startsWith(storedKey);
}

/**
 * Newest receipt time (ms) of a post per room, keyed by room public key: the
 * max of the server's `latestReceivedAt` and live-pool `room_post` rows.
 * Own posts, reactions and ignored rows do not count toward the live side.
 */
export function latestRoomReceiptByRoom(params: {
  messages: ReadonlyArray<UnreadMessage>;
  roomStats: ReadonlyArray<{ roomPublicKey: string; latestReceivedAt?: number }>;
  rooms: ReadonlyArray<{ publicKey: string }>;
  selfKey: string | undefined;
}): Map<string, number> {
  const { messages, roomStats, rooms, selfKey } = params;
  const latest = new Map<string, number>();
  const bump = (room: string, ts: number) => {
    if (ts > (latest.get(room) ?? 0)) latest.set(room, ts);
  };
  for (const s of roomStats) {
    const ts = Number(s.latestReceivedAt ?? 0);
    if (!(ts > 0)) continue;
    for (const r of rooms) if (roomKeyMatches(s.roomPublicKey, r.publicKey)) bump(r.publicKey, ts);
  }
  for (const m of messages) {
    if (m.messageType !== 'room_post' || !m.toPublicKey) continue;
    if (m.filtered || m.reactionEmoji) continue;
    if (selfKey && peerKeysMatch(m.fromPublicKey, selfKey)) continue;
    const ts = meshcoreReceiptTimeMs(m);
    for (const r of rooms) if (roomKeyMatches(m.toPublicKey, r.publicKey)) bump(r.publicKey, ts);
  }
  return latest;
}

/**
 * Room public keys with unread posts (#6261). The clock is MeshMonitor receipt
 * time, so a login backlog replay does not read as new unless it is newly
 * stored. Unread when latest receipt > last-read marker, the room is not the
 * one open, and it is not muted.
 */
export function computeUnreadRooms(params: {
  messages: ReadonlyArray<UnreadMessage>;
  roomStats: ReadonlyArray<{ roomPublicKey: string; latestReceivedAt?: number }>;
  rooms: ReadonlyArray<{ publicKey: string }>;
  selfKey: string | undefined;
  roomLastRead: Record<string, number>;
  activeRoomKey?: string | null;
  isMuted?: (roomKey: string) => boolean;
}): Set<string> {
  const { roomLastRead, activeRoomKey, isMuted } = params;
  const unread = new Set<string>();
  for (const [room, ts] of latestRoomReceiptByRoom(params)) {
    if (activeRoomKey && roomKeyMatches(room, activeRoomKey)) continue;
    if (isMuted?.(room)) continue;
    if (ts > (roomLastRead[room] ?? 0)) unread.add(room);
  }
  return unread;
}
