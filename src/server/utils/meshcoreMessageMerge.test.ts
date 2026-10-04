import { describe, it, expect } from 'vitest';
import {
  clusterMeshCoreReceptions,
  meshcoreChannelIndexOf,
  meshcoreExactDedupKey,
  meshcoreLogicalIdentity,
  meshcoreSenderSecond,
  normaliseMeshCoreChannelContent,
  MESHCORE_MERGE_WINDOW_MS,
  type MeshCoreMergeItem,
  type MeshCoreMergeRow,
} from './meshcoreMessageMerge.js';

const SEC = 1_790_000_000;
const T0 = SEC * 1000;
const FP = 'aaaaaaaaaaaaaaaa';
const FP2 = 'bbbbbbbbbbbbbbbb';

let n = 0;
function row(over: Partial<MeshCoreMergeRow> = {}): MeshCoreMergeRow {
  n += 1;
  return {
    id: `r${n}`,
    fromPublicKey: 'channel-1',
    fromName: 'Alice',
    toPublicKey: null,
    text: 'hello',
    timestamp: T0,
    createdAt: T0 + 400,
    ...over,
  };
}
function item(sourceId: string, over: Partial<MeshCoreMergeRow> = {}, channelIdentity: string | null = FP): MeshCoreMergeItem {
  return { row: row(over), sourceId, channelIdentity };
}
/** Receipt-clock row: the sender's clock was rejected, so `timestamp` has a ms part. */
const clockless = (createdAt: number, over: Partial<MeshCoreMergeRow> = {}): Partial<MeshCoreMergeRow> => ({
  timestamp: createdAt - 3,
  createdAt,
  ...over,
});
const shape = (clusters: ReturnType<typeof clusterMeshCoreReceptions>) =>
  clusters.map((c) => c.members.map((m) => m.sourceId).sort());

describe('meshcoreChannelIndexOf', () => {
  it('reads the index from either side, and null for a DM', () => {
    expect(meshcoreChannelIndexOf({ fromPublicKey: 'channel-7' })).toBe(7);
    expect(meshcoreChannelIndexOf({ fromPublicKey: 'ab'.repeat(32), toPublicKey: 'channel-1042' })).toBe(1042);
    expect(meshcoreChannelIndexOf({ fromPublicKey: 'ab'.repeat(32), toPublicKey: 'cd'.repeat(32) })).toBeNull();
  });
});

describe('normaliseMeshCoreChannelContent', () => {
  it('gives the companion split and the decoder split the same result', () => {
    // Wire text "Bob:  hi": the companion regex eats all whitespace after the
    // colon; the decoder strips exactly ": " and keeps the second space.
    const companion = normaliseMeshCoreChannelContent({ fromPublicKey: 'channel-1', fromName: 'Bob', text: 'hi' });
    const decoder = normaliseMeshCoreChannelContent({ fromPublicKey: 'channel-1033', fromName: 'Bob', text: ' hi' });
    expect(decoder).toEqual(companion);
    expect(companion).toEqual({ name: 'Bob', body: 'hi' });
  });

  it('splits a row the decoder left unsplit ("Name:body", bracketed name)', () => {
    expect(
      normaliseMeshCoreChannelContent({ fromPublicKey: 'channel-1033', fromName: null, text: 'Bob:hi' }),
    ).toEqual({ name: 'Bob', body: 'hi' });
    // The decoder refuses a name holding "[": the companion splits it.
    expect(
      normaliseMeshCoreChannelContent({ fromPublicKey: 'channel-1033', fromName: null, text: 'Bob [K1]: hi' }),
    ).toEqual(normaliseMeshCoreChannelContent({ fromPublicKey: 'channel-1', fromName: 'Bob [K1]', text: 'hi' }));
  });

  it('un-splits a name longer than the companion allows', () => {
    const long = 'N'.repeat(40);
    const decoder = normaliseMeshCoreChannelContent({ fromPublicKey: 'channel-1033', fromName: long, text: 'hi' });
    const companion = normaliseMeshCoreChannelContent({ fromPublicKey: 'channel-1', fromName: null, text: `${long}: hi` });
    expect(decoder).toEqual(companion);
    expect(decoder.name).toBe('');
  });

  it('does not split the body of our own send', () => {
    expect(
      normaliseMeshCoreChannelContent({ fromPublicKey: 'ab'.repeat(32), fromName: 'Base', text: 'Note: buy milk' }),
    ).toEqual({ name: 'Base', body: 'Note: buy milk' });
    // ...and the echo of that send, as another source stores it, matches.
    expect(
      normaliseMeshCoreChannelContent({ fromPublicKey: 'channel-1', fromName: 'Base', text: 'Note: buy milk' }),
    ).toEqual({ name: 'Base', body: 'Note: buy milk' });
  });
});

describe('meshcoreSenderSecond', () => {
  it('prefers the stored senderTimestamp', () => {
    expect(meshcoreSenderSecond(row({ id: 'sent-1', timestamp: T0 + 731, senderTimestamp: SEC }))).toBe(SEC);
  });

  it('reads a whole-second timestamp on a received row', () => {
    expect(meshcoreSenderSecond(row({ timestamp: T0 }))).toBe(SEC);
  });

  it('returns null for a receipt-clock timestamp', () => {
    expect(meshcoreSenderSecond(row({ timestamp: T0 + 17 }))).toBeNull();
  });

  it('never reads the send clock of our own row as a sender second', () => {
    expect(meshcoreSenderSecond(row({ id: 'sent-9', timestamp: T0 }))).toBeNull();
  });

  it('rejects a sender clock the companion path would reject (no-RTC repeater row)', () => {
    // 2024 default clock, stored verbatim by the repeater path.
    expect(meshcoreSenderSecond(row({ timestamp: 1_715_770_351_000, createdAt: T0 }))).toBeNull();
    // More than a day ahead of receipt.
    expect(meshcoreSenderSecond(row({ timestamp: T0 + 2 * 86_400_000, createdAt: T0 }))).toBeNull();
  });

  it('accepts an old room post: a room server replays history', () => {
    const old = T0 - 5 * 86_400_000;
    expect(meshcoreSenderSecond(row({ timestamp: old, createdAt: T0, messageType: 'room_post' }))).toBe(old / 1000);
    expect(meshcoreSenderSecond(row({ timestamp: old, createdAt: T0 }))).toBeNull();
  });
});

describe('meshcoreLogicalIdentity', () => {
  it('is equal for one channel message stored by a companion and by a repeater', () => {
    const a = meshcoreLogicalIdentity(item('A', { fromPublicKey: 'channel-1' }));
    const b = meshcoreLogicalIdentity(item('B', { fromPublicKey: 'channel-43690' }));
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it('differs by secret, sender and text, not by channel index', () => {
    const base = meshcoreLogicalIdentity(item('A'));
    expect(meshcoreLogicalIdentity(item('B', {}, FP2))).not.toBe(base);
    expect(meshcoreLogicalIdentity(item('B', { fromName: 'Bob' }))).not.toBe(base);
    expect(meshcoreLogicalIdentity(item('B', { text: 'other' }))).not.toBe(base);
  });

  it('is null for a channel whose secret is unknown', () => {
    expect(meshcoreLogicalIdentity(item('A', {}, null))).toBeNull();
  });

  it('matches a sent DM (full keys) with its received copy (6-byte sender prefix)', () => {
    const alice = 'A1'.repeat(32);
    const bob = 'b2'.repeat(32);
    const sent = meshcoreLogicalIdentity(item('A', { id: 'sent-1', fromPublicKey: alice, toPublicKey: bob, fromName: 'Alice' }, null));
    const received = meshcoreLogicalIdentity(item('B', { fromPublicKey: alice.toLowerCase().slice(0, 12), toPublicKey: bob, fromName: null }, null));
    expect(sent).not.toBeNull();
    expect(received).toBe(sent);
    // Direction matters.
    expect(meshcoreLogicalIdentity(item('B', { fromPublicKey: bob, toPublicKey: alice }, null))).not.toBe(sent);
  });

  it('is null for a DM whose endpoint is not a key', () => {
    expect(meshcoreLogicalIdentity(item('A', { fromPublicKey: 'local', toPublicKey: 'b2'.repeat(32) }, null))).toBeNull();
    expect(meshcoreLogicalIdentity(item('A', { fromPublicKey: 'b2'.repeat(32), toPublicKey: null }, null))).toBeNull();
  });
});

describe('clusterMeshCoreReceptions', () => {
  it('merges the same sender second across sources under a content key', () => {
    const a = item('A', { fromPublicKey: 'channel-1' });
    const b = item('B', { fromPublicKey: 'channel-43690', createdAt: T0 + 90_000 });
    const out = clusterMeshCoreReceptions([b, a]);
    expect(shape(out)).toEqual([['A', 'B']]);
    expect(out[0].dedupKey).toBe(meshcoreExactDedupKey(meshcoreLogicalIdentity(a)!, SEC));
    expect(out[0].members[0]).toBe(a);
  });

  it('keeps the key when only one of the receptions is present', () => {
    const a = item('A');
    const b = item('B');
    const both = clusterMeshCoreReceptions([a, b])[0].dedupKey;
    expect(clusterMeshCoreReceptions([a])[0].dedupKey).toBe(both);
    expect(clusterMeshCoreReceptions([b])[0].dedupKey).toBe(both);
  });

  it('keeps the same text sent one second apart as two messages', () => {
    const out = clusterMeshCoreReceptions([
      item('A', { timestamp: T0 }),
      item('B', { timestamp: T0 }),
      item('A', { timestamp: T0 + 1000 }),
      item('B', { timestamp: T0 + 1000 }),
    ]);
    expect(shape(out)).toEqual([['A', 'B'], ['A', 'B']]);
    expect(out[0].dedupKey).not.toBe(out[1].dedupKey);
  });

  it('does not merge equal index, different secret', () => {
    const out = clusterMeshCoreReceptions([item('A', {}, FP), item('B', {}, FP2)]);
    expect(shape(out)).toEqual([['A'], ['B']]);
  });

  it('never merges across sources when the secret is unknown', () => {
    const out = clusterMeshCoreReceptions([item('A', { id: 'x1' }, null), item('B', { id: 'x2' }, null)]);
    expect(out.map((c) => c.dedupKey)).toEqual(['mc:A:x1', 'mc:B:x2']);
  });

  it('collapses a second copy on one source into that source\'s first reception', () => {
    const first = item('A');
    const out = clusterMeshCoreReceptions([first, item('A', { createdAt: T0 + 9000 }), item('B')]);
    expect(shape(out)).toEqual([['A', 'B']]);
    expect(out[0].members[0]).toBe(first);
  });

  describe('rows without a sender second', () => {
    it('merges different sources inside the window, keyed by the first row', () => {
      const a = item('A', clockless(T0, { id: 'first' }));
      const b = item('B', clockless(T0 + 4000));
      const out = clusterMeshCoreReceptions([b, a]);
      expect(shape(out)).toEqual([['A', 'B']]);
      expect(out[0].dedupKey).toBe('mc:A:first');
    });

    it('never merges two rows from one source', () => {
      const out = clusterMeshCoreReceptions([item('A', clockless(T0)), item('A', clockless(T0 + 2000))]);
      expect(shape(out)).toEqual([['A'], ['A']]);
    });

    it('does not merge outside the window', () => {
      const out = clusterMeshCoreReceptions([
        item('A', clockless(T0)),
        item('B', clockless(T0 + MESHCORE_MERGE_WINDOW_MS + 1)),
      ]);
      expect(shape(out)).toEqual([['A'], ['B']]);
    });

    it('compares neighbours, so a pair straddling a bucket edge still merges', () => {
      // floor(t / 10s) would put these in different buckets.
      const out = clusterMeshCoreReceptions([
        item('A', clockless(1_790_000_009_900)),
        item('B', clockless(1_790_000_010_100)),
      ]);
      expect(shape(out)).toEqual([['A', 'B']]);
    });

    it('pairs a repeated message with its own copy on the other source', () => {
      const out = clusterMeshCoreReceptions([
        item('A', clockless(T0)),
        item('B', clockless(T0 + 500)),
        item('A', clockless(T0 + 6000)),
        item('B', clockless(T0 + 6500)),
      ]);
      expect(shape(out)).toEqual([['A', 'B'], ['A', 'B']]);
    });

    it('merges our own sent DM (no stored sender second) with the copy another source received', () => {
      const alice = 'a1'.repeat(32);
      const bob = 'b2'.repeat(32);
      const sent = item('A', { id: 'sent-1', fromPublicKey: alice, toPublicKey: bob, timestamp: T0 + 250, createdAt: T0 + 250 }, null);
      const received = item('B', { fromPublicKey: alice.slice(0, 12), toPublicKey: bob, fromName: null, timestamp: T0, createdAt: T0 + 2100 }, null);
      const out = clusterMeshCoreReceptions([received, sent]);
      expect(shape(out)).toEqual([['A', 'B']]);
      expect(out[0].dedupKey).toBe('mc:A:sent-1');
    });

    it('does not let a row with a different sender second adopt an exact cluster', () => {
      const out = clusterMeshCoreReceptions([
        item('A', { timestamp: T0 }),
        item('B', { timestamp: T0 + 3000, createdAt: T0 + 3400 }),
      ]);
      expect(shape(out)).toEqual([['A'], ['B']]);
    });
  });

  describe('key stability', () => {
    it('does not change the key of a shown row when a later reception joins it', () => {
      const a = item('A', clockless(T0, { id: 'first' }));
      const before = clusterMeshCoreReceptions([a]);
      const after = clusterMeshCoreReceptions([a, item('B', clockless(T0 + 3000))]);
      expect(after).toHaveLength(1);
      expect(after[0].dedupKey).toBe(before[0].dedupKey);
      expect(after[0].members).toHaveLength(2);
    });

    it('does not re-key earlier clusters when later rows arrive', () => {
      const rows = [
        item('A', clockless(T0)),
        item('B', clockless(T0 + 1000)),
        item('A', clockless(T0 + 8000)),
        item('C', { timestamp: T0, createdAt: T0 + 9000 }),
        item('B', clockless(T0 + 9500)),
      ];
      const keysAt = (k: number) => clusterMeshCoreReceptions(rows.slice(0, k)).map((c) => c.dedupKey);
      for (let k = 1; k < rows.length; k++) {
        expect(keysAt(k + 1).slice(0, keysAt(k).length)).toEqual(keysAt(k));
      }
    });

    it('is independent of input order', () => {
      const rows = [
        item('A', clockless(T0)),
        item('B', clockless(T0 + 1000)),
        item('A', { timestamp: T0 + 60_000, createdAt: T0 + 60_400 }),
        item('B', { timestamp: T0 + 60_000, createdAt: T0 + 60_900 }),
      ];
      const forward = clusterMeshCoreReceptions(rows);
      const backward = clusterMeshCoreReceptions([...rows].reverse());
      expect(backward.map((c) => c.dedupKey)).toEqual(forward.map((c) => c.dedupKey));
      expect(shape(backward)).toEqual(shape(forward));
    });
  });
});
