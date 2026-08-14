/**
 * messageOrder (Reticulum) — #3960 Phase 2 WP5.
 *
 * Unlike MeshCore's whole-second-bucketed comparator, both directions of a
 * Reticulum LXMF conversation share a single millisecond-resolution clock
 * (the bridge's envelope `ts`, copied straight into `timestamp` for inbound
 * rows; `Date.now()` for outbound rows) — so a plain numeric comparison on
 * `timestamp` is correct here, with `receivedAt` then `id` as tie-breaks.
 */
import { describe, it, expect } from 'vitest';
import { compareReticulumMessages, sortReticulumMessages } from './messageOrder';
import type { ReticulumMessageRow } from '../../types/reticulum';

function msg(overrides: Partial<ReticulumMessageRow> & Pick<ReticulumMessageRow, 'id'>): ReticulumMessageRow {
  return {
    id: overrides.id,
    sourceId: 's1',
    fromHash: 'a',
    toHash: 'b',
    title: null,
    content: null,
    timestamp: 0,
    receivedAt: null,
    createdAt: 0,
    state: 'delivered',
    method: null,
    signatureValidated: false,
    ratcheted: false,
    fields: null,
    replyToHash: null,
    threadHash: null,
    rssi: null,
    snr: null,
    quality: null,
    ...overrides,
  };
}

describe('compareReticulumMessages', () => {
  it('orders strictly by timestamp when they differ', () => {
    const older = msg({ id: 'a', timestamp: 1000 });
    const newer = msg({ id: 'b', timestamp: 2000 });
    expect(compareReticulumMessages(older, newer)).toBeLessThan(0);
    expect(compareReticulumMessages(newer, older)).toBeGreaterThan(0);
  });

  it('does NOT truncate to whole seconds (unlike MeshCore) — sub-second differences are honored', () => {
    const a = msg({ id: 'a', timestamp: 1000 });
    const b = msg({ id: 'b', timestamp: 1050 });
    expect(compareReticulumMessages(a, b)).toBeLessThan(0);
  });

  it('breaks a timestamp tie using receivedAt', () => {
    const first = msg({ id: 'a', timestamp: 5000, receivedAt: 100 });
    const second = msg({ id: 'b', timestamp: 5000, receivedAt: 200 });
    expect(compareReticulumMessages(first, second)).toBeLessThan(0);
  });

  it('falls back to timestamp for receivedAt when it is null (legacy/optimistic rows)', () => {
    const a = msg({ id: 'a', timestamp: 1000, receivedAt: null });
    const b = msg({ id: 'b', timestamp: 2000, receivedAt: null });
    expect(compareReticulumMessages(a, b)).toBeLessThan(0);
  });

  it('breaks a fully-tied clock using id, for a total stable order', () => {
    const a = msg({ id: 'aaa', timestamp: 1000, receivedAt: 1000 });
    const b = msg({ id: 'bbb', timestamp: 1000, receivedAt: 1000 });
    expect(compareReticulumMessages(a, b)).toBeLessThan(0);
    expect(compareReticulumMessages(b, a)).toBeGreaterThan(0);
  });

  it('is reflexively zero for identical rows', () => {
    const a = msg({ id: 'a', timestamp: 1000, receivedAt: 1000 });
    expect(compareReticulumMessages(a, a)).toBe(0);
  });
});

describe('sortReticulumMessages', () => {
  it('returns an oldest-first copy without mutating the input', () => {
    const input = [
      msg({ id: 'c', timestamp: 3000 }),
      msg({ id: 'a', timestamp: 1000 }),
      msg({ id: 'b', timestamp: 2000 }),
    ];
    const sorted = sortReticulumMessages(input);
    expect(sorted.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(input.map(m => m.id)).toEqual(['c', 'a', 'b']);
  });
});
