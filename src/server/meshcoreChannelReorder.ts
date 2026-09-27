/**
 * MeshCore on-device channel reorder planner (#5379).
 *
 * Pure functions only: no device IO, no DB. `MeshCoreManager.reorderChannels`
 * feeds these the channel table it read from the companion and executes the
 * resulting steps one CMD_SET_CHANNEL at a time.
 *
 * Firmware facts this relies on (companion_radio MyMesh.cpp, BaseChatMesh.cpp):
 *  - CMD_SET_CHANNEL (0x20) overwrites ONE slot in place and saves the whole
 *    table to flash. There is no insert, no delete-and-shift and no "set
 *    order" command. `deleteChannel` in meshcore.js is just a write of an empty
 *    name and an all-zero secret.
 *  - The table is a fixed array of MAX_GROUP_CHANNELS slots (40 on current
 *    companion builds). Empty slots persist as gaps, which is why #5324 shows
 *    an "empty" slot after a delete.
 *  - An incoming channel message is attributed to the FIRST slot whose secret
 *    matches (`findChannelIdx`), so a channel briefly present in two slots
 *    still decrypts, it just reports the lower index.
 *
 * Reorder is therefore a sequence of slot overwrites. The planner orders those
 * writes so that after EVERY single write, each channel that was on the device
 * at the start is still present in at least one slot. A write only lands on a
 * slot whose current content is empty, already duplicated elsewhere, or not
 * wanted in the target. When every remaining write would destroy the last
 * copy of something (a cycle, e.g. a plain swap), the planner first copies one
 * of them into a free scratch slot. A crash, disconnect or failed write
 * mid-sequence can leave a duplicate or a channel in the wrong slot, but never
 * a missing channel.
 */

/** One configured channel slot as the firmware stores it. */
export interface ChannelSlotContent {
  name: string;
  /** 32 lowercase hex chars (16-byte AES-128 secret). */
  secretHex: string;
}

/** A slot is `null` when empty (blank name + all-zero secret). */
export type SlotValue = ChannelSlotContent | null;

/** A slot whose content we could not confirm (failed write, lost read-back). */
export const UNKNOWN_SLOT = Symbol('meshcore-channel-slot-unknown');
export type BelievedSlotValue = SlotValue | typeof UNKNOWN_SLOT;

/** One device write: set `slot` to `value` (`null` clears it). */
export interface ReorderStep {
  slot: number;
  value: SlotValue;
  /** Why this write exists, for logs and the progress report. */
  kind: 'place' | 'scratch' | 'clear';
}

/** A channel that changes slot: every stored `from` reference becomes `to`. */
export interface ChannelMove {
  from: number;
  to: number;
}

export class ChannelReorderPlanError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'ORDER_INVALID'
      | 'ORDER_MISMATCH'
      | 'NO_FREE_SLOT'
      | 'PLAN_DID_NOT_CONVERGE'
      | 'NOT_COMPANION'
      | 'NOT_CONNECTED'
      | 'REORDER_IN_PROGRESS'
      | 'TABLE_READ_FAILED',
  ) {
    super(message);
    this.name = 'ChannelReorderPlanError';
  }
}

const ZERO_SECRET = /^0*$/;

/** Firmware's "unused slot" shape: blank name and an all-zero secret. */
export function isEmptySlot(ch: { name: string; secretHex: string } | null | undefined): boolean {
  if (!ch) return true;
  const hasName = (ch.name || '').trim().length > 0;
  const hasSecret = !!ch.secretHex && !ZERO_SECRET.test(ch.secretHex);
  return !hasName && !hasSecret;
}

/** Normalise a raw device slot into a `SlotValue`. */
export function toSlotValue(ch: { name: string; secretHex: string } | null | undefined): SlotValue {
  if (isEmptySlot(ch)) return null;
  return { name: ch!.name ?? '', secretHex: (ch!.secretHex ?? '').toLowerCase() };
}

export function sameSlotValue(a: BelievedSlotValue, b: BelievedSlotValue): boolean {
  if (a === UNKNOWN_SLOT || b === UNKNOWN_SLOT) return false;
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.secretHex.toLowerCase() === b.secretHex.toLowerCase();
}

function valueKey(v: SlotValue): string {
  return v === null ? '' : `${v.secretHex.toLowerCase()}|${v.name}`;
}

export interface ReorderTarget {
  /** Slot -> desired value, for every slot whose value changes. */
  target: Map<number, SlotValue>;
  /** Old slot -> new slot for each channel that moves. */
  moves: ChannelMove[];
}

/**
 * Build the target layout for a requested order.
 *
 * `table` is the full slot table read from the device (index = slot).
 * `order` lists the CURRENT slot indices of every configured channel in
 * slots 1+ in the order the user wants them. The channel at `order[k]` lands
 * in slot `k + 1`, so the result is packed into 1..n with no gaps. Slot 0 is
 * MeshCore's Public channel and never moves.
 *
 * The request must name exactly the configured slots the device reports. If
 * the device changed since the UI loaded (a channel added or removed from
 * another client) the caller gets ORDER_MISMATCH instead of a layout built on
 * a stale view.
 */
export function buildReorderTarget(table: SlotValue[], order: number[]): ReorderTarget {
  if (!Array.isArray(order) || order.length === 0) {
    throw new ChannelReorderPlanError('order must be a non-empty array of slot indices', 'ORDER_INVALID');
  }
  const seen = new Set<number>();
  for (const idx of order) {
    if (!Number.isInteger(idx) || idx < 1 || idx >= table.length) {
      throw new ChannelReorderPlanError(`order contains an invalid slot index: ${String(idx)}`, 'ORDER_INVALID');
    }
    if (seen.has(idx)) {
      throw new ChannelReorderPlanError(`order lists slot ${idx} more than once`, 'ORDER_INVALID');
    }
    seen.add(idx);
  }

  const configured: number[] = [];
  for (let slot = 1; slot < table.length; slot++) {
    if (table[slot] !== null) configured.push(slot);
  }
  const missing = configured.filter((s) => !seen.has(s));
  const extra = order.filter((s) => table[s] === null);
  if (missing.length > 0 || extra.length > 0) {
    throw new ChannelReorderPlanError(
      'The channel list on the device changed since this page loaded ' +
        `(device has slots ${configured.join(', ') || 'none'}; request named ${order.join(', ')}). ` +
        'Reload the channel list and try again.',
      'ORDER_MISMATCH',
    );
  }

  const target = new Map<number, SlotValue>();
  const moves: ChannelMove[] = [];
  order.forEach((fromSlot, k) => {
    const toSlot = k + 1;
    if (fromSlot !== toSlot) {
      moves.push({ from: fromSlot, to: toSlot });
    }
    if (!sameSlotValue(table[toSlot], table[fromSlot])) {
      target.set(toSlot, table[fromSlot]);
    }
  });
  // Compaction: slots past the packed range that held a channel end up empty.
  for (let slot = order.length + 1; slot < table.length; slot++) {
    if (table[slot] !== null) target.set(slot, null);
  }
  return { target, moves };
}

/**
 * Order the writes that turn `current` into `target` without ever removing
 * the last copy of a channel.
 *
 * `current` is what we believe each slot holds (index = slot). An
 * `UNKNOWN_SLOT` entry (a write whose read-back failed) is treated as always
 * needing a write and never as the only copy of anything, which is sound
 * because the planner never writes over a last copy in the first place.
 *
 * `scratchCandidates` limits which slots may be borrowed as scratch; by
 * default any slot >= 1 that is empty now and is not part of the target.
 */
export function planReorderWrites(
  current: BelievedSlotValue[],
  target: Map<number, SlotValue>,
  scratchCandidates?: number[],
): ReorderStep[] {
  const state: BelievedSlotValue[] = current.slice();
  // Every slot the plan touches must end as the target says. A borrowed
  // scratch slot joins this map with a `null` target so it is cleaned up.
  const goal = new Map(target);
  const steps: ReorderStep[] = [];

  const copies = (v: SlotValue): number => {
    const key = valueKey(v);
    let n = 0;
    for (const s of state) {
      if (s !== UNKNOWN_SLOT && s !== null && valueKey(s) === key) n++;
    }
    return n;
  };
  const wanted = (v: SlotValue): boolean => {
    const key = valueKey(v);
    for (const g of goal.values()) if (g !== null && valueKey(g) === key) return true;
    return false;
  };
  // Writing over `slot` is safe when its current value survives elsewhere or
  // is not part of the target at all.
  const safeToOverwrite = (slot: number): boolean => {
    const v = state[slot];
    if (v === UNKNOWN_SLOT || v === null) return true;
    return copies(v) > 1 || !wanted(v);
  };
  const pending = (): number[] =>
    [...goal.keys()].filter((slot) => !sameSlotValue(state[slot], goal.get(slot)!) || state[slot] === UNKNOWN_SLOT)
      .sort((a, b) => a - b);

  const write = (slot: number, value: SlotValue, kind: ReorderStep['kind']) => {
    steps.push({ slot, value, kind });
    state[slot] = value;
  };

  // Each loop iteration does one write, and a scratch copy is always followed
  // by the write it unblocks, so this bound is generous.
  const maxIterations = (goal.size + 1) * 4 + 8;
  for (let i = 0; i < maxIterations; i++) {
    const todo = pending();
    if (todo.length === 0) return steps;

    // 1. Place channels first; a clear only ever removes a duplicate or an
    //    unwanted value, so doing it last never costs a scratch copy.
    const place = todo.find((slot) => goal.get(slot) !== null && safeToOverwrite(slot));
    if (place !== undefined) {
      write(place, goal.get(place)!, 'place');
      continue;
    }
    const clear = todo.find((slot) => goal.get(slot) === null && safeToOverwrite(slot));
    if (clear !== undefined) {
      write(clear, null, 'clear');
      continue;
    }

    // 2. Every remaining write would destroy a last copy: we are in a cycle.
    //    Copy one blocked value into a free slot, which unblocks its home.
    const blocked = todo.find((slot) => goal.get(slot) !== null) ?? todo[0];
    const blockedValue = state[blocked] as SlotValue;
    const candidates = (scratchCandidates ?? state.map((_, idx) => idx))
      .filter((slot) => slot >= 1 && slot < state.length && !goal.has(slot) && state[slot] === null);
    if (candidates.length === 0) {
      throw new ChannelReorderPlanError(
        'This reorder needs one free channel slot on the device to move channels without ' +
          'ever removing one, and every slot is in use. Delete a channel you no longer need, then try again.',
        'NO_FREE_SLOT',
      );
    }
    // Use the highest free slot: it is the least likely to be one a user is
    // about to fill, and keeps the temporary copy out of the packed range.
    const scratch = candidates[candidates.length - 1];
    goal.set(scratch, null);
    write(scratch, blockedValue, 'scratch');
  }
  throw new ChannelReorderPlanError('Channel reorder plan did not converge', 'PLAN_DID_NOT_CONVERGE');
}

/**
 * Simulate `steps` over `start` and confirm the safety invariant: every
 * channel present in `start` is present after each step, and the final state
 * matches `target`. Used by tests and as a runtime self-check before any
 * device write.
 */
export function verifyPlan(
  start: BelievedSlotValue[],
  target: Map<number, SlotValue>,
  steps: ReorderStep[],
): { ok: true } | { ok: false; reason: string } {
  const state = start.slice();
  const required = new Set<string>();
  for (const v of start) if (v !== UNKNOWN_SLOT && v !== null) required.add(valueKey(v));
  // Values only present in the target (rollback of an unknown slot) are not
  // required up front, but once written they must stay.
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    state[step.slot] = step.value;
    const present = new Set<string>();
    for (const v of state) if (v !== UNKNOWN_SLOT && v !== null) present.add(valueKey(v));
    for (const key of required) {
      const stillWanted = [...target.values()].some((t) => t !== null && valueKey(t) === key);
      if (stillWanted && !present.has(key)) {
        return { ok: false, reason: `step ${i} (slot ${step.slot}) removed the last copy of a channel` };
      }
    }
  }
  for (const [slot, value] of target) {
    if (!sameSlotValue(state[slot], value)) {
      return { ok: false, reason: `slot ${slot} does not match the target after the plan` };
    }
  }
  return { ok: true };
}

/** Old slot -> new slot lookup built from a move list (identity for unlisted slots). */
export function moveMap(moves: ChannelMove[]): Map<number, number> {
  return new Map(moves.map((m) => [m.from, m.to]));
}
