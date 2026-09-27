import { describe, it, expect } from 'vitest';
import {
  UNKNOWN_SLOT,
  ChannelReorderPlanError,
  buildReorderTarget,
  planReorderWrites,
  verifyPlan,
  isEmptySlot,
  toSlotValue,
  type SlotValue,
  type BelievedSlotValue,
} from './meshcoreChannelReorder.js';

const ch = (name: string): SlotValue => ({ name, secretHex: name.padEnd(32, 'a').slice(0, 32).replace(/[^0-9a-f]/g, 'b') });

/** A 40-slot table (the companion default) with `names` in slots 1.. and gaps where null. */
function table(names: Array<string | null>, size = 40): SlotValue[] {
  const t: SlotValue[] = Array.from({ length: size }, () => null);
  names.forEach((n, i) => { t[i + 1] = n === null ? null : ch(n); });
  return t;
}

function apply(start: BelievedSlotValue[], steps: ReturnType<typeof planReorderWrites>): BelievedSlotValue[] {
  const s = start.slice();
  for (const step of steps) s[step.slot] = step.value;
  return s;
}

describe('slot helpers', () => {
  it('treats blank name + zero secret as empty and anything else as configured', () => {
    expect(isEmptySlot({ name: '', secretHex: '0'.repeat(32) })).toBe(true);
    expect(isEmptySlot({ name: '  ', secretHex: '' })).toBe(true);
    expect(isEmptySlot({ name: 'x', secretHex: '0'.repeat(32) })).toBe(false);
    expect(isEmptySlot({ name: '', secretHex: '01'.padEnd(32, '0') })).toBe(false);
    expect(toSlotValue({ name: 'A', secretHex: 'AB'.repeat(16) })).toEqual({ name: 'A', secretHex: 'ab'.repeat(16) });
  });
});

describe('buildReorderTarget', () => {
  it('packs the requested order into slots 1..n and reports the moves', () => {
    const t = table(['a', 'b', 'c']);
    const { target, moves } = buildReorderTarget(t, [3, 1, 2]);
    expect(moves).toEqual([{ from: 3, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }]);
    expect([...target.entries()]).toEqual([[1, ch('c')], [2, ch('a')], [3, ch('b')]]);
  });

  it('closes gaps left by a deleted channel (#5324)', () => {
    const t = table(['a', null, 'c', 'd']);
    const { target, moves } = buildReorderTarget(t, [1, 3, 4]);
    expect(moves).toEqual([{ from: 3, to: 2 }, { from: 4, to: 3 }]);
    expect(target.get(2)).toEqual(ch('c'));
    expect(target.get(3)).toEqual(ch('d'));
    expect(target.get(4)).toBeNull();
    expect(target.has(1)).toBe(false);
  });

  it('refuses an order that does not match the device (stale page)', () => {
    const t = table(['a', 'b', 'c']);
    expect(() => buildReorderTarget(t, [2, 1])).toThrow(expect.objectContaining({ code: 'ORDER_MISMATCH' }));
    expect(() => buildReorderTarget(t, [2, 1, 3, 4])).toThrow(expect.objectContaining({ code: 'ORDER_MISMATCH' }));
  });

  it('refuses slot 0, duplicates and out-of-range slots', () => {
    const t = table(['a', 'b']);
    for (const bad of [[0, 1, 2], [1, 1], [1, 2, 99], [], [1.5, 2]]) {
      expect(() => buildReorderTarget(t, bad)).toThrow(ChannelReorderPlanError);
    }
  });

  it('returns an empty target when the order is unchanged', () => {
    expect(buildReorderTarget(table(['a', 'b']), [1, 2]).target.size).toBe(0);
  });
});

describe('planReorderWrites', () => {
  it('uses one scratch slot for a swap and never removes the last copy', () => {
    const start = table(['a', 'b']);
    const { target } = buildReorderTarget(start, [2, 1]);
    const steps = planReorderWrites(start, target);
    expect(steps.map((s) => s.kind)).toEqual(['scratch', 'place', 'place', 'clear']);
    expect(steps[0].slot).toBe(39);
    expect(verifyPlan(start, target, steps)).toEqual({ ok: true });
    const end = apply(start, steps);
    expect(end[1]).toEqual(ch('b'));
    expect(end[2]).toEqual(ch('a'));
    expect(end[39]).toBeNull();
  });

  it('needs no scratch when a channel moves into an empty slot', () => {
    const start = table(['a', null, 'c']);
    const { target } = buildReorderTarget(start, [3, 1]);
    const steps = planReorderWrites(start, target);
    expect(steps.some((s) => s.kind === 'scratch')).toBe(false);
    expect(verifyPlan(start, target, steps)).toEqual({ ok: true });
  });

  it('refuses a cycle when every slot is in use', () => {
    const names = Array.from({ length: 39 }, (_, i) => `c${i}`);
    const start = table(names);
    const order = names.map((_, i) => i + 1);
    [order[0], order[1]] = [order[1], order[0]];
    const { target } = buildReorderTarget(start, order);
    expect(() => planReorderWrites(start, target)).toThrow(expect.objectContaining({ code: 'NO_FREE_SLOT' }));
  });

  it('holds the invariant for random permutations with gaps', () => {
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let trial = 0; trial < 300; trial++) {
      const slots = 3 + Math.floor(rand() * 12);
      const names: Array<string | null> = Array.from({ length: slots }, (_, i) => (rand() < 0.25 ? null : `n${trial}x${i}`));
      const start = table(names, slots + 1 + Math.floor(rand() * 3));
      const configured = start.map((v, i) => (i > 0 && v ? i : -1)).filter((i) => i > 0);
      if (configured.length === 0) continue;
      const order = configured.slice().sort(() => rand() - 0.5);
      const { target } = buildReorderTarget(start, order);
      let steps;
      try {
        steps = planReorderWrites(start, target);
      } catch (err) {
        expect((err as ChannelReorderPlanError).code).toBe('NO_FREE_SLOT');
        continue;
      }
      expect(verifyPlan(start, target, steps)).toEqual({ ok: true });
      const end = apply(start, steps);
      order.forEach((from, k) => expect(end[k + 1]).toEqual(start[from]));
      for (let s = order.length + 1; s < end.length; s++) expect(end[s]).toBeNull();
    }
  });

  it('plans a rollback from a state with an unknown slot', () => {
    const original = table(['a', 'b']);
    // Mid-swap: scratch holds a, slot 1 got b, slot 2's write failed (unknown).
    const believed: BelievedSlotValue[] = original.slice();
    believed[39] = ch('a');
    believed[1] = ch('b');
    believed[2] = UNKNOWN_SLOT;
    const target = new Map<number, SlotValue>([[1, ch('a')], [2, ch('b')], [39, null]]);
    const steps = planReorderWrites(believed, target);
    expect(verifyPlan(believed, target, steps)).toEqual({ ok: true });
    const end = apply(believed, steps);
    expect(end[1]).toEqual(ch('a'));
    expect(end[2]).toEqual(ch('b'));
    expect(end[39]).toBeNull();
  });
});

describe('verifyPlan', () => {
  it('flags a plan that overwrites the last copy of a channel', () => {
    const start = table(['a', 'b']);
    const target = new Map<number, SlotValue>([[1, ch('b')], [2, ch('a')]]);
    const naive = [
      { slot: 1, value: ch('b'), kind: 'place' as const },
      { slot: 2, value: ch('a'), kind: 'place' as const },
    ];
    const res = verifyPlan(start, target, naive);
    expect(res.ok).toBe(false);
  });
});
