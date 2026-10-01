/**
 * Display order for the MeshCore Channels list (#5385, #5379).
 *
 * This is a MeshMonitor-side VIEW preference only. It never touches the
 * device: channel slot indices stay exactly where the firmware has them, so
 * message history (keyed `channel-<idx>`), channel sends, bridge rules and
 * automations that reference a slot index are unaffected. Zero packets.
 *
 * One model covers both issues:
 *   - `device`      — firmware slot order (the default, and the old behaviour)
 *   - `name`        — alphabetical by channel name
 *   - `lastMessage` — newest activity first; silent channels sink to the bottom
 *   - `messageCount` — most messages first (#5503); empty channels sink
 *   - `custom`      — the operator's drag-and-drop order (#5379)
 *
 * The mode and the custom order are persisted per source in localStorage,
 * next to the per-source unread markers this view already keeps there. A view
 * preference must not need `settings:write`, which read-only viewers lack.
 */

export type ChannelSortMode = 'device' | 'name' | 'lastMessage' | 'messageCount' | 'custom';

export const CHANNEL_SORT_MODES: readonly ChannelSortMode[] = ['device', 'name', 'lastMessage', 'messageCount', 'custom'];

export interface OrderableChannel {
  id: number;
  name: string;
}

export const channelSortModeKey = (sourceId: string) =>
  `meshmonitor-meshcore-channel-sort-mode-${sourceId}`;
export const channelCustomOrderKey = (sourceId: string) =>
  `meshmonitor-meshcore-channel-custom-order-${sourceId}`;

function isSortMode(v: unknown): v is ChannelSortMode {
  return typeof v === 'string' && (CHANNEL_SORT_MODES as readonly string[]).includes(v);
}

export function loadChannelSortMode(sourceId: string): ChannelSortMode {
  try {
    const raw = localStorage.getItem(channelSortModeKey(sourceId));
    return isSortMode(raw) ? raw : 'device';
  } catch {
    return 'device';
  }
}

export function saveChannelSortMode(sourceId: string, mode: ChannelSortMode): void {
  try {
    localStorage.setItem(channelSortModeKey(sourceId), mode);
  } catch {
    /* storage blocked — the choice just won't survive a reload */
  }
}

export function loadChannelCustomOrder(sourceId: string): number[] {
  try {
    const raw = localStorage.getItem(channelCustomOrderKey(sourceId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<number>();
    const out: number[] = [];
    for (const v of parsed) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Follow an on-device channel reorder (#5379): the saved Custom display order
 * names channels by slot, so rewrite each slot old -> new. `moves` is a full
 * permutation, so no two entries collide. No-op when nothing is saved.
 */
export function remapChannelCustomOrder(sourceId: string, moves: Array<{ from: number; to: number }>): void {
  if (!sourceId || moves.length === 0) return;
  const saved = loadChannelCustomOrder(sourceId);
  if (saved.length === 0) return;
  const map = new Map(moves.map((m) => [m.from, m.to]));
  saveChannelCustomOrder(sourceId, saved.map((slot) => map.get(slot) ?? slot));
}

export function saveChannelCustomOrder(sourceId: string, order: number[]): void {
  try {
    localStorage.setItem(channelCustomOrderKey(sourceId), JSON.stringify(order));
  } catch {
    /* storage blocked — the order just won't survive a reload */
  }
}

const byId = (a: OrderableChannel, b: OrderableChannel) => a.id - b.id;

/**
 * Apply a saved custom order. Channels the order names come first, in that
 * order; channels it does not name (added since the order was saved) follow in
 * slot order. Ids in the order that no longer exist are ignored.
 */
export function applyCustomOrder<T extends OrderableChannel>(channels: T[], order: number[]): T[] {
  const rank = new Map<number, number>();
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  return [...channels].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.id - b.id;
  });
}

export interface SortChannelsOptions {
  /** Saved drag-and-drop order (slot ids), used by `custom`. */
  customOrder?: number[];
  /** Newest message timestamp per slot id, used by `lastMessage`. */
  latest?: Record<number, number>;
  /** Stored message count per slot id, used by `messageCount` (#5503). */
  counts?: Record<number, number>;
  /** Display label for `name` sorting (defaults to the raw name). */
  label?: (c: OrderableChannel) => string;
}

/** Return a new array of `channels` in the order `mode` asks for. */
export function sortChannels<T extends OrderableChannel>(
  channels: T[],
  mode: ChannelSortMode,
  opts: SortChannelsOptions = {},
): T[] {
  switch (mode) {
    case 'name': {
      const label = opts.label ?? ((c: OrderableChannel) => c.name);
      const key = (c: OrderableChannel) => label(c).replace(/^#\s*/, '').trim();
      return [...channels].sort((a, b) =>
        key(a).localeCompare(key(b), undefined, { sensitivity: 'base', numeric: true }) || byId(a, b));
    }
    case 'lastMessage': {
      const latest = opts.latest ?? {};
      // Silent channels (no timestamp) sink to the bottom, in slot order.
      return [...channels].sort((a, b) => (latest[b.id] ?? 0) - (latest[a.id] ?? 0) || byId(a, b));
    }
    case 'messageCount': {
      const counts = opts.counts ?? {};
      // Busiest first; empty channels sink to the bottom, in slot order.
      return [...channels].sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || byId(a, b));
    }
    case 'custom':
      return applyCustomOrder(channels, opts.customOrder ?? []);
    case 'device':
    default:
      return [...channels].sort(byId);
  }
}

/** Move the item at `from` to `to`, returning a new array. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
