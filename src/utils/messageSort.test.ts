/**
 * Tests for `getMessageSortTime` — the helper that makes message lists
 * sort by server-side receipt time instead of sender-reported timestamp.
 * Issue #3187 regression: a node with bad/uninitialized RTC sends a
 * message claiming `timestamp` = year 2065; previously the message
 * floated to the top of the channel. Now it sorts by `receivedAt` (server
 * ingest time) and lands in the correct chronological slot.
 */
import { describe, it, expect } from 'vitest';
import { getMessageSortTime } from './messageSort';
import { MeshMessage } from '../types/message';

function makeMessage(opts: { timestamp: Date; receivedAt?: Date }): MeshMessage {
  return {
    id: 'm',
    from: 'a',
    to: 'b',
    fromNodeId: '!a',
    toNodeId: '!b',
    text: 't',
    channel: 0,
    timestamp: opts.timestamp,
    receivedAt: opts.receivedAt,
  };
}

describe('getMessageSortTime', () => {
  it('prefers receivedAt when present', () => {
    const msg = makeMessage({
      timestamp: new Date('2065-01-01T00:00:00Z'), // bogus future from bad clock
      receivedAt: new Date('2026-05-25T12:00:00Z'), // real ingest time
    });
    expect(getMessageSortTime(msg)).toBe(new Date('2026-05-25T12:00:00Z').getTime());
  });

  it('falls back to timestamp when receivedAt is missing', () => {
    const msg = makeMessage({
      timestamp: new Date('2026-05-25T12:00:00Z'),
    });
    expect(getMessageSortTime(msg)).toBe(new Date('2026-05-25T12:00:00Z').getTime());
  });

  it('sorts a mix of bad-clock and good-clock messages chronologically by receipt', () => {
    const goodEarly = makeMessage({
      timestamp: new Date('2026-05-25T10:00:00Z'),
      receivedAt: new Date('2026-05-25T10:00:00Z'),
    });
    const badClockMid = makeMessage({
      // Node reports year 2065 but we received it between the good messages.
      timestamp: new Date('2065-01-01T00:00:00Z'),
      receivedAt: new Date('2026-05-25T10:30:00Z'),
    });
    const goodLate = makeMessage({
      timestamp: new Date('2026-05-25T11:00:00Z'),
      receivedAt: new Date('2026-05-25T11:00:00Z'),
    });

    const list = [goodLate, badClockMid, goodEarly];
    const sorted = [...list].sort((a, b) => getMessageSortTime(a) - getMessageSortTime(b));

    expect(sorted.map((m) => m.timestamp.toISOString())).toEqual([
      '2026-05-25T10:00:00.000Z',
      '2065-01-01T00:00:00.000Z', // bad-clock message in its real receipt slot
      '2026-05-25T11:00:00.000Z',
    ]);
  });

  it('keeps last-message-time computations stable under bad timestamps', () => {
    // Reduce-based "latest message" — the previous implementation picked the
    // bad-clock 2065 message even when the most recent real message was newer.
    const realLatest = makeMessage({
      timestamp: new Date('2026-05-25T11:30:00Z'),
      receivedAt: new Date('2026-05-25T11:30:00Z'),
    });
    const badClockOld = makeMessage({
      timestamp: new Date('2065-01-01T00:00:00Z'),
      receivedAt: new Date('2026-05-25T09:00:00Z'),
    });

    const messages = [realLatest, badClockOld];
    const latest = messages.reduce((winner, m) =>
      getMessageSortTime(m) > getMessageSortTime(winner) ? m : winner,
    );

    expect(latest).toBe(realLatest);
  });

  it('handles a flood of bad timestamps without throwing', () => {
    const messages: MeshMessage[] = Array.from({ length: 50 }, (_, i) =>
      makeMessage({
        timestamp: new Date(0), // 1970 — looks like an uninitialized RTC
        receivedAt: new Date(2_000_000_000_000 + i * 1000),
      }),
    );

    const sorted = [...messages].sort((a, b) => getMessageSortTime(a) - getMessageSortTime(b));
    // Sorted in receipt order: receivedAt strictly increasing.
    for (let i = 1; i < sorted.length; i++) {
      expect(getMessageSortTime(sorted[i])).toBeGreaterThan(getMessageSortTime(sorted[i - 1]));
    }
  });
});
