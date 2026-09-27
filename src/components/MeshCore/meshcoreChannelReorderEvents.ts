/**
 * Client-side fan-out for a MeshCore on-device channel reorder (#5379).
 *
 * The server emits `meshcore:channels:reordered` over the socket with the slot
 * permutation it applied. `useMeshCore` receives it once, remaps the state it
 * owns, then re-broadcasts it here as a window event so views that keep their
 * own slot-keyed state (the Channels view's list, selection and counts) can
 * follow without new prop plumbing.
 */

export interface ChannelSlotMove {
  from: number;
  to: number;
}

export interface ChannelsReorderedDetail {
  sourceId: string;
  moves: ChannelSlotMove[];
}

const EVENT = 'meshcore-channels-reordered';

/** Old slot -> new slot for `moves` (unlisted slots map to themselves). */
export function slotMoveMap(moves: ChannelSlotMove[]): Map<number, number> {
  return new Map(moves.map((m) => [m.from, m.to]));
}

/** Rewrite a `channel-<idx>` key for `moves`; other keys pass through. */
export function remapChannelKey(key: string | undefined, map: Map<number, number>): string | undefined {
  if (!key || !key.startsWith('channel-')) return key;
  const idx = Number(key.slice('channel-'.length));
  if (!Number.isInteger(idx)) return key;
  const to = map.get(idx);
  return to === undefined ? key : `channel-${to}`;
}

export function emitChannelsReordered(detail: ChannelsReorderedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ChannelsReorderedDetail>(EVENT, { detail }));
}

export function subscribeChannelsReordered(cb: (detail: ChannelsReorderedDetail) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<ChannelsReorderedDetail>).detail;
    if (detail && Array.isArray(detail.moves)) cb(detail);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
