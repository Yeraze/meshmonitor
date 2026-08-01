/**
 * Ordering tests built from a real observed inversion.
 *
 * On a MeshCore channel, a remote auto-responder's reply rendered ABOVE the
 * message that triggered it. The captured rows:
 *
 *   trigger (ours)   id "sent-1785604213050-…"  timestamp 1785604213050
 *   reply   (remote) id "1785604214478-…"       timestamp 1785604213000
 *
 * The reply was observed 1.4 s AFTER the trigger, yet carried a timestamp 50 ms
 * earlier — the remote can only express whole seconds via `sender_timestamp`,
 * while our own send is stamped Date.now() to the millisecond.
 */
import { describe, it, expect } from 'vitest';
import { compareMeshCoreMessages, sortMeshCoreMessages } from './messageOrder';

type M = { id: string; timestamp: number; receivedAt?: number; text?: string };

const TRIGGER: M = {
  id: 'sent-1785604213050-juy7prb66',
  timestamp: 1785604213050,
  receivedAt: 1785604213050,
  text: 'testing send on newly created channel',
};
const REPLY: M = {
  id: '1785604214478-x87tbdp3t',
  timestamp: 1785604213000, // remote clock, whole seconds — EARLIER than the trigger
  receivedAt: 1785604214478, // but actually observed 1.4s later
  text: '🤖 Copy, …',
};

describe('compareMeshCoreMessages', () => {
  it('puts a same-second auto-reply AFTER the message that triggered it', () => {
    const ordered = sortMeshCoreMessages([REPLY, TRIGGER]);
    expect(ordered.map(m => m.text)).toEqual([TRIGGER.text, REPLY.text]);
  });

  it('is not fooled by the raw timestamps, which are inverted', () => {
    // Guard the premise: a naive timestamp sort genuinely gets this wrong.
    const naive = [REPLY, TRIGGER].sort((a, b) => a.timestamp - b.timestamp);
    expect(naive[0].text).toBe(REPLY.text);
  });

  it('still orders messages from different seconds by their stated time', () => {
    const older: M = { id: 'a', timestamp: 1785604100000, receivedAt: 1785604999999 };
    const newer: M = { id: 'b', timestamp: 1785604300000, receivedAt: 1785604000000 };
    // Even though `receivedAt` disagrees, a whole second of difference in the
    // sender's time wins — receivedAt is only a tie-break.
    expect(sortMeshCoreMessages([newer, older]).map(m => m.id)).toEqual(['a', 'b']);
  });

  it('falls back to timestamp when receivedAt is absent (legacy rows)', () => {
    const a: M = { id: 'a', timestamp: 1785604213000 };
    const b: M = { id: 'b', timestamp: 1785604213900 };
    // Same second, no observation clock — ordering must stay stable and total,
    // not depend on input order.
    expect(sortMeshCoreMessages([b, a]).map(m => m.id)).toEqual(sortMeshCoreMessages([a, b]).map(m => m.id));
  });

  it('mixes legacy and new rows without throwing away the new ordering signal', () => {
    const legacy: M = { id: 'legacy', timestamp: 1785604213000 };
    const fresh: M = { id: 'fresh', timestamp: 1785604213000, receivedAt: 1785604213800 };
    // legacy falls back to timestamp (…000) so it precedes fresh (…800).
    expect(sortMeshCoreMessages([fresh, legacy]).map(m => m.id)).toEqual(['legacy', 'fresh']);
  });

  it('is a total order — identical clocks fall back to id, never input order', () => {
    const a: M = { id: 'aaa', timestamp: 1000, receivedAt: 1000 };
    const b: M = { id: 'bbb', timestamp: 1000, receivedAt: 1000 };
    expect(compareMeshCoreMessages(a, b)).toBeLessThan(0);
    expect(compareMeshCoreMessages(b, a)).toBeGreaterThan(0);
    expect(compareMeshCoreMessages(a, a)).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = [REPLY, TRIGGER];
    sortMeshCoreMessages(input);
    expect(input.map(m => m.id)).toEqual([REPLY.id, TRIGGER.id]);
  });
});
