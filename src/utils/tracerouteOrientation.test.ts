/**
 * The rule that tells the two stored forms of a traceroute row apart.
 * Pure: no database. The repository tests prove the same rule end to end on
 * all three backends.
 */
import { describe, it, expect } from 'vitest';
import {
  isStoredRequesterFirst,
  orientTracerouteRow,
  replyPacketToRequesterFirst,
} from './tracerouteOrientation';

const LOCAL = 3639506708;
const REMOTE = 944633591;
const id = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

const completed = { route: '[111]', routeBack: '[222]', snrTowards: '[8,12]', snrBack: '[16,20]' };
const row = (from: number, to: number, extra: Record<string, unknown> = {}) => ({
  fromNodeNum: from, toNodeNum: to, fromNodeId: id(from), toNodeId: id(to), ...completed, ...extra,
});

describe('isStoredRequesterFirst', () => {
  it('a pending or unanswered request (route NULL) is requester-first, local node known or not', () => {
    for (const local of [LOCAL, REMOTE, null, undefined]) {
      expect(isStoredRequesterFirst(row(LOCAL, REMOTE, { route: null, routeBack: null, snrBack: null }), local)).toBe(true);
    }
  });

  it('our radio in from, with a return path: a run we sent', () => {
    expect(isStoredRequesterFirst(row(LOCAL, REMOTE), LOCAL)).toBe(true);
    // A zero-hop run has no routeBack hops; the snrBack sample is the return path.
    expect(isStoredRequesterFirst(row(LOCAL, REMOTE, { route: '[]', routeBack: '[]', snrBack: '[20]' }), LOCAL)).toBe(true);
  });

  it('our radio in from, with NO return path: our own outgoing reply, so the other node asked', () => {
    expect(isStoredRequesterFirst(row(LOCAL, REMOTE, { routeBack: '[]', snrBack: '[]' }), LOCAL)).toBe(false);
  });

  it('our radio in to: a reply inserted as it arrived', () => {
    expect(isStoredRequesterFirst(row(REMOTE, LOCAL), LOCAL)).toBe(false);
  });

  it('a run between two other nodes, or a source with no radio: reply-packet form', () => {
    expect(isStoredRequesterFirst(row(5, 6), LOCAL)).toBe(false);
    expect(isStoredRequesterFirst(row(LOCAL, REMOTE), null)).toBe(false);
    expect(isStoredRequesterFirst(row(LOCAL, REMOTE), undefined)).toBe(false);
    expect(isStoredRequesterFirst(row(LOCAL, REMOTE), Number.NaN)).toBe(false);
  });

  it('compares BIGINT-as-string node numbers by value', () => {
    expect(isStoredRequesterFirst(row(LOCAL, REMOTE, { fromNodeNum: String(LOCAL) }), LOCAL)).toBe(true);
  });
});

describe('orientTracerouteRow', () => {
  it('gives the same row for both stored forms of one run', () => {
    const sent = orientTracerouteRow(row(LOCAL, REMOTE), LOCAL);
    const replyOnly = orientTracerouteRow(row(REMOTE, LOCAL), LOCAL);
    expect(replyOnly).toEqual(sent);
    expect(sent).toMatchObject({
      fromNodeNum: LOCAL, toNodeNum: REMOTE, fromNodeId: id(LOCAL), toNodeId: id(REMOTE), ...completed,
    });
  });

  it('returns the same object when nothing moves, a copy when it swaps, and never touches the arrays', () => {
    const sent = row(LOCAL, REMOTE);
    expect(orientTracerouteRow(sent, LOCAL)).toBe(sent);

    const replyOnly = row(REMOTE, LOCAL);
    const oriented = orientTracerouteRow(replyOnly, LOCAL);
    expect(oriented).not.toBe(replyOnly);
    expect(replyOnly.fromNodeNum).toBe(REMOTE); // input not mutated
    expect(oriented).toMatchObject(completed);
  });

  it('does not invent id fields on a row that has none', () => {
    const bare = { fromNodeNum: REMOTE, toNodeNum: LOCAL, ...completed };
    const oriented = orientTracerouteRow(bare, LOCAL);
    expect(oriented).toEqual({ fromNodeNum: LOCAL, toNodeNum: REMOTE, ...completed });
    expect('fromNodeId' in oriented).toBe(false);
  });

  // The trap the module doc warns about, pinned so nobody "fixes" it by
  // calling the helper defensively on rows the repository already oriented.
  it('is NOT idempotent for a reply-packet row on a source with no radio', () => {
    const once = orientTracerouteRow(row(REMOTE, LOCAL), null);
    expect(once.fromNodeNum).toBe(LOCAL);
    expect(orientTracerouteRow(once, null).fromNodeNum).toBe(REMOTE);
  });
});

describe('replyPacketToRequesterFirst', () => {
  it('always swaps: the caller holds a reply packet', () => {
    expect(replyPacketToRequesterFirst(row(REMOTE, LOCAL))).toMatchObject({
      fromNodeNum: LOCAL, toNodeNum: REMOTE, fromNodeId: id(LOCAL), toNodeId: id(REMOTE), ...completed,
    });
  });
});
