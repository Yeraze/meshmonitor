/**
 * Display order for MeshCore list views (#5385, #5379).
 *
 * Originally the Channels list only (#5385/#5379/#5503); #6148 generalised the
 * engine so the Rooms list shares it. Everything here is a MeshMonitor-side
 * VIEW preference only. It never touches the device: channel slot indices stay
 * exactly where the firmware has them, and room contacts are untouched, so
 * message history, sends, bridge rules and automations are unaffected. Zero
 * packets.
 *
 * The sort/order primitives are generic over the item's id type `K` so a
 * channel (keyed by its integer slot) and a room (keyed by its `publicKey`
 * string) use the same code. Channel call sites infer `K = number` and keep
 * working unchanged.
 *
 * Modes:
 *   - `device`      — firmware slot order (channels only; the old default)
 *   - `name`        — alphabetical by display name
 *   - `lastMessage` — newest activity first; silent items sink to the bottom
 *   - `messageCount` — most messages first (#5503); empty items sink
 *   - `distance`    — nearest first (rooms only, #6148); no-location sinks, by name
 *   - `custom`      — the operator's drag-and-drop order (#5379)
 *
 * The mode and the custom order are persisted per source in localStorage,
 * next to the per-source unread markers these views already keep there. A view
 * preference must not need `settings:write`, which read-only viewers lack.
 */

/** The id a list item is keyed and ordered by. */
export type OrderKey = string | number;

/** Compare two ids for a stable tie-break: numeric for numbers, locale-aware
 *  (numeric-collating) for strings. */
function compareKey<K extends OrderKey>(a: K, b: K): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export interface OrderableItem<K extends OrderKey = number> {
  id: K;
  name: string;
}

// ---------------------------------------------------------------------------
// Channels (#5385/#5379/#5503)
// ---------------------------------------------------------------------------

export type ChannelSortMode = 'device' | 'name' | 'lastMessage' | 'messageCount' | 'custom';

export const CHANNEL_SORT_MODES: readonly ChannelSortMode[] = ['device', 'name', 'lastMessage', 'messageCount', 'custom'];

/** @deprecated Use {@link OrderableItem}. Kept for existing channel call sites. */
export type OrderableChannel = OrderableItem<number>;

export const channelSortModeKey = (sourceId: string) =>
  `meshmonitor-meshcore-channel-sort-mode-${sourceId}`;
export const channelCustomOrderKey = (sourceId: string) =>
  `meshmonitor-meshcore-channel-custom-order-${sourceId}`;

function isChannelSortMode(v: unknown): v is ChannelSortMode {
  return typeof v === 'string' && (CHANNEL_SORT_MODES as readonly string[]).includes(v);
}

export function loadChannelSortMode(sourceId: string): ChannelSortMode {
  try {
    const raw = localStorage.getItem(channelSortModeKey(sourceId));
    return isChannelSortMode(raw) ? raw : 'device';
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

// ---------------------------------------------------------------------------
// Rooms (#6148)
// ---------------------------------------------------------------------------

export type RoomSortMode = 'name' | 'lastMessage' | 'messageCount' | 'distance' | 'custom';

export const ROOM_SORT_MODES: readonly RoomSortMode[] = ['name', 'lastMessage', 'messageCount', 'distance', 'custom'];

export const roomSortModeKey = (sourceId: string) =>
  `meshmonitor-meshcore-room-sort-mode-${sourceId}`;
export const roomCustomOrderKey = (sourceId: string) =>
  `meshmonitor-meshcore-room-custom-order-${sourceId}`;

function isRoomSortMode(v: unknown): v is RoomSortMode {
  return typeof v === 'string' && (ROOM_SORT_MODES as readonly string[]).includes(v);
}

export function loadRoomSortMode(sourceId: string): RoomSortMode {
  try {
    const raw = localStorage.getItem(roomSortModeKey(sourceId));
    // Default to Room name: it is stable and needs no location or history.
    return isRoomSortMode(raw) ? raw : 'name';
  } catch {
    return 'name';
  }
}

export function saveRoomSortMode(sourceId: string, mode: RoomSortMode): void {
  try {
    localStorage.setItem(roomSortModeKey(sourceId), mode);
  } catch {
    /* storage blocked — the choice just won't survive a reload */
  }
}

/** Saved room custom order (public-key strings). Junk entries are dropped. */
export function loadRoomCustomOrder(sourceId: string): string[] {
  try {
    const raw = localStorage.getItem(roomCustomOrderKey(sourceId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v === 'string' && v.length > 0 && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function saveRoomCustomOrder(sourceId: string, order: string[]): void {
  try {
    localStorage.setItem(roomCustomOrderKey(sourceId), JSON.stringify(order));
  } catch {
    /* storage blocked — the order just won't survive a reload */
  }
}

// ---------------------------------------------------------------------------
// Generic ordering engine
// ---------------------------------------------------------------------------

/** Every mode any list view supports. Each view exposes only its own subset. */
export type ListSortMode = ChannelSortMode | RoomSortMode;

/**
 * Apply a saved custom order. Items the order names come first, in that order;
 * items it does not name (added since the order was saved) follow in id order.
 * Ids in the order that no longer exist are ignored. Generic over the id type,
 * so channels (number slots) and rooms (public-key strings) share it.
 */
export function applyCustomOrder<K extends OrderKey, T extends OrderableItem<K>>(items: T[], order: K[]): T[] {
  const rank = new Map<K, number>();
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return compareKey(a.id, b.id);
  });
}

export interface SortItemsOptions<K extends OrderKey = number> {
  /** Saved drag-and-drop order (ids), used by `custom`. */
  customOrder?: K[];
  /** Newest message timestamp per id, used by `lastMessage`. */
  latest?: Partial<Record<K, number>>;
  /** Stored message count per id, used by `messageCount` (#5503). */
  counts?: Partial<Record<K, number>>;
  /** Distance (km) per id, used by `distance` (#6148). A missing/non-finite
   *  value means "no location" and sinks that item to the bottom, by name. */
  distances?: Partial<Record<K, number>>;
  /** Display label for `name`/`distance` sorting (defaults to the raw name). */
  label?: (c: OrderableItem<K>) => string;
}

/** @deprecated Use {@link SortItemsOptions}. */
export type SortChannelsOptions = SortItemsOptions<number>;

/** Return a new array of `items` in the order `mode` asks for. */
export function sortItems<K extends OrderKey, T extends OrderableItem<K>>(
  items: T[],
  mode: ListSortMode,
  opts: SortItemsOptions<K> = {},
): T[] {
  const tie = (a: T, b: T) => compareKey(a.id, b.id);
  const label = opts.label ?? ((c: OrderableItem<K>) => c.name);
  const nameKey = (c: T) => label(c).replace(/^#\s*/, '').trim();
  const byName = (a: T, b: T) =>
    nameKey(a).localeCompare(nameKey(b), undefined, { sensitivity: 'base', numeric: true }) || tie(a, b);

  switch (mode) {
    case 'name':
      return [...items].sort(byName);
    case 'lastMessage': {
      const latest: Partial<Record<K, number>> = opts.latest ?? {};
      // Silent items (no timestamp) sink to the bottom, in id order.
      return [...items].sort((a, b) => (latest[b.id] ?? 0) - (latest[a.id] ?? 0) || tie(a, b));
    }
    case 'messageCount': {
      const counts: Partial<Record<K, number>> = opts.counts ?? {};
      // Busiest first; empty items sink to the bottom, in id order.
      return [...items].sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || tie(a, b));
    }
    case 'distance': {
      const distances: Partial<Record<K, number>> = opts.distances ?? {};
      const dist = (id: K): number | undefined => {
        const d = distances[id];
        return typeof d === 'number' && Number.isFinite(d) ? d : undefined;
      };
      // Nearest first; items with no location sink to the bottom, ordered by
      // name so their order stays stable (#6148).
      return [...items].sort((a, b) => {
        const da = dist(a.id);
        const db = dist(b.id);
        if (da !== undefined && db !== undefined) return (da - db) || byName(a, b);
        if (da !== undefined) return -1;
        if (db !== undefined) return 1;
        return byName(a, b);
      });
    }
    case 'custom':
      return applyCustomOrder(items, opts.customOrder ?? []);
    case 'device':
    default:
      return [...items].sort(tie);
  }
}

/**
 * @deprecated Channel-flavoured alias of {@link sortItems}. Kept so existing
 * channel call sites and tests read naturally; new code calls `sortItems`.
 */
export const sortChannels = sortItems;

/** Move the item at `from` to `to`, returning a new array. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
