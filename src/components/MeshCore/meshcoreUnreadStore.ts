/**
 * Shared client-side unread-marker store for MeshCore (#3891).
 *
 * MeshCore messages are NOT covered by the Meshtastic server-side read-tracking
 * (`read_messages` joins the Meshtastic `messages` table only), so we track the
 * operator's last-read markers client-side in localStorage, scoped by sourceId:
 *
 *   - channels: `meshmonitor-meshcore-channel-lastread-<sourceId>` → { idx: ms }
 *               (pre-existing key from #3703 — kept as-is for backward compat)
 *   - DMs:      `meshmonitor-meshcore-dm-lastread-<sourceId>`      → { peerKey: ms }
 *
 * Both the views that own a conversation (MeshCoreChannelsView /
 * MeshCoreDirectMessagesView) and the page-level unread hook that drives the
 * sidebar red-dots read/write through here, so a single source of truth keeps
 * the in-view badges and the sidebar dots consistent. Writes dispatch a
 * same-tab `CustomEvent` so listeners update immediately (the native `storage`
 * event only fires in OTHER tabs).
 */

const CHANGE_EVENT = 'meshcore-unread-changed';

export const channelLastReadKey = (sourceId: string) =>
  `meshmonitor-meshcore-channel-lastread-${sourceId}`;
export const dmLastReadKey = (sourceId: string) =>
  `meshmonitor-meshcore-dm-lastread-${sourceId}`;

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

/** Read the per-channel last-read map (channel idx → ms) for a source. */
export function loadChannelLastRead(sourceId: string): Record<number, number> {
  if (!sourceId) return {};
  return loadMap<number>(channelLastReadKey(sourceId));
}

/** Read the per-peer DM last-read map (canonical peer key → ms) for a source. */
export function loadDmLastRead(sourceId: string): Record<string, number> {
  if (!sourceId) return {};
  return loadMap<string>(dmLastReadKey(sourceId));
}

function persist(storageKey: string, map: Record<string | number, number>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    /* storage full / disabled — unread state is best-effort */
  }
  // Notify same-tab listeners (storage event only fires cross-tab).
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    /* non-DOM env (tests) — safe to ignore */
  }
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
}

/**
 * Subscribe to unread-marker changes (both same-tab writes via this module and
 * cross-tab `storage` events). Returns an unsubscribe function.
 */
export function subscribeUnreadChanged(cb: () => void): () => void {
  const onCustom = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith('meshmonitor-meshcore-channel-lastread-') || e.key.startsWith('meshmonitor-meshcore-dm-lastread-')) {
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
  for (const c of contacts) {
    if (c.publicKey === key) return key;
  }
  for (const c of contacts) {
    if (c.publicKey && c.publicKey.startsWith(key)) return c.publicKey;
  }
  return key;
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

/**
 * Compute the set of DM peers with unread INCOMING messages: a peer is unread
 * when its latest *received* message (from the peer, to us) is newer than the
 * stored last-read marker. Own-sent messages never create unread. Keys are
 * canonical peer keys.
 */
export function computeUnreadDmPeers(params: {
  messages: ReadonlyArray<{ fromPublicKey: string; toPublicKey?: string; timestamp: number; messageType?: string }>;
  contacts: ReadonlyArray<{ publicKey?: string }>;
  selfKey: string | undefined;
  dmLastRead: Record<string, number>;
  /** Peer currently open in the DM view — never reported as unread. */
  activePeerKey?: string | null;
}): Set<string> {
  const { messages, contacts, selfKey, dmLastRead, activePeerKey } = params;
  // Without knowing our own key we can't tell received from sent, so we can't
  // reliably attribute "unread" — report nothing rather than false positives.
  if (!selfKey) return new Set<string>();
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
  const latestIncoming = new Map<string, number>();
  for (const m of messages) {
    if (!m.toPublicKey) continue;
    if (m.messageType === 'room_post') continue;
    if (isChannelPseudoKey(m.fromPublicKey) || isChannelPseudoKey(m.toPublicKey)) continue;
    // Only received messages count as unread — sender is NOT us, recipient IS us.
    if (peerKeysMatch(m.fromPublicKey, selfKey)) continue;
    if (!peerKeysMatch(m.toPublicKey, selfKey)) continue;
    const peer = canon(m.fromPublicKey);
    if (peerKeysMatch(peer, selfKey)) continue;
    const prev = latestIncoming.get(peer) ?? 0;
    if (m.timestamp > prev) latestIncoming.set(peer, m.timestamp);
  }
  const activeCanonical = activePeerKey ? canon(activePeerKey) : null;
  const unread = new Set<string>();
  for (const [peer, ts] of latestIncoming) {
    if (activeCanonical && peerKeysMatch(peer, activeCanonical)) continue;
    if (ts > (dmLastRead[peer] ?? 0)) unread.add(peer);
  }
  return unread;
}
