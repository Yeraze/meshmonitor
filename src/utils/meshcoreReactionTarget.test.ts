import { describe, it, expect } from 'vitest';
import {
  meshcoreWireSecond,
  storedWireSecond,
  meshcoreWireChannelText,
  mc1HashForChannelWire,
  mc1HashForOwnChannelText,
  mc1HashForDm,
  foldReactionEmoji,
  candidateMatchesReaction,
  pendingKeyOfReaction,
  pendingKeysOfMessage,
  type ReactionCandidate,
} from './meshcoreReactionTarget.js';
import { parseMeshCoreReaction, dartStringHash, meshcoreOpenV3Hash } from './meshcoreReactions.js';

const SEC = 1704067200;
const HELLO = 'b45pc4ek';

function row(over: Partial<ReactionCandidate> = {}): ReactionCandidate {
  return {
    id: 'r1',
    fromPublicKey: 'channel-0',
    fromName: 'Bob',
    text: 'Hello',
    timestamp: SEC * 1000,
    senderTimestamp: SEC,
    mc1Hash: HELLO,
    ...over,
  };
}

const chan = { scope: 'channel' as const };
const dm = { scope: 'dm' as const };

describe('meshcoreWireSecond', () => {
  it('rejects 0, floats, non-numbers and values above u32', () => {
    expect(meshcoreWireSecond(0)).toBeNull();
    expect(meshcoreWireSecond(1.5)).toBeNull();
    expect(meshcoreWireSecond('5')).toBeNull();
    expect(meshcoreWireSecond(0x100000000)).toBeNull();
    expect(meshcoreWireSecond(NaN)).toBeNull();
  });
  it('reads a negative int32 as unsigned', () => {
    expect(meshcoreWireSecond(-1)).toBe(0xffffffff);
    expect(meshcoreWireSecond(-0x80000001)).toBeNull();
  });
  it('passes a normal second through', () => {
    expect(meshcoreWireSecond(SEC)).toBe(SEC);
    expect(meshcoreWireSecond(0xffffffff)).toBe(0xffffffff);
  });
});

describe('storedWireSecond', () => {
  it('prefers senderTimestamp', () => {
    expect(storedWireSecond({ id: 'sent-1', timestamp: 5, senderTimestamp: SEC })).toBe(SEC);
  });
  it('never reads the timestamp of an own sent- row', () => {
    expect(storedWireSecond({ id: 'sent-1', timestamp: SEC * 1000 })).toBeNull();
  });
  it('reads whole-second received timestamps, not ms ones', () => {
    expect(storedWireSecond({ id: 'a', timestamp: SEC * 1000 })).toBe(SEC);
    expect(storedWireSecond({ id: 'a', timestamp: SEC * 1000 + 7 })).toBeNull();
  });
  it('applies no plausibility gate', () => {
    expect(storedWireSecond({ id: 'a', timestamp: 1000, senderTimestamp: 3 })).toBe(3);
  });
});

describe('hash helpers', () => {
  it('match the epic vector', () => {
    expect(mc1HashForChannelWire('Bob: Hello', SEC)).toBe(HELLO);
    expect(mc1HashForOwnChannelText('Hello', SEC)).toBe(HELLO);
    expect(mc1HashForDm('Hello', SEC)).toBe(HELLO);
  });
  it('trim spaces and tabs on channel text only', () => {
    expect(mc1HashForChannelWire('Bob:  Hello \t', SEC)).toBe(HELLO);
    expect(mc1HashForOwnChannelText(' Hello', SEC)).toBe(HELLO);
    expect(mc1HashForDm(' Hello', SEC)).not.toBe(HELLO);
  });
  it('give null without a second', () => {
    expect(mc1HashForChannelWire('Bob: Hello', null)).toBeNull();
    expect(mc1HashForOwnChannelText('Hello', null)).toBeNull();
    expect(mc1HashForDm('Hello', null)).toBeNull();
  });
  it('meshcoreWireChannelText rebuilds the wire text', () => {
    expect(meshcoreWireChannelText('Bob', 'Hello')).toBe('Bob: Hello');
    expect(meshcoreWireChannelText(null, 'Hello')).toBe('Hello');
    expect(meshcoreWireChannelText('', 'Hello')).toBe('Hello');
  });
});

describe('foldReactionEmoji', () => {
  it('strips VS16', () => {
    expect(foldReactionEmoji('❤️')).toBe('❤');
    expect(foldReactionEmoji('❤')).toBe('❤');
    expect(foldReactionEmoji('\u{1F44D}')).toBe('\u{1F44D}');
  });
});

describe('candidateMatchesReaction', () => {
  const mc1 = parseMeshCoreReaction(`@[Bob]\u{1F44D}\n${HELLO}`, 'channel')!;
  const legacy = parseMeshCoreReaction(`\u{1F44D}@[Bob]\n${HELLO}`, 'channel')!;

  it('mc1 channel: hash and exact sender', () => {
    expect(mc1.format).toBe('mc1-channel');
    expect(candidateMatchesReaction(mc1, row(), chan)).toBe(true);
    expect(candidateMatchesReaction(legacy, row(), chan)).toBe(true);
  });
  it('mc1 channel: case differs -> false', () => {
    expect(candidateMatchesReaction(mc1, row({ fromName: 'bob' }), chan)).toBe(false);
  });
  it('mc1 channel: wrong hash -> false', () => {
    expect(candidateMatchesReaction(mc1, row({ mc1Hash: '00000000' }), chan)).toBe(false);
  });
  it('mc1 channel: trimmed target sender matches the trimmed stored name', () => {
    const r = parseMeshCoreReaction(`@[ Bob ]\u{1F44D}\n${HELLO}`, 'channel')!;
    expect(candidateMatchesReaction(r, row(), chan)).toBe(true);
  });
  it('mc1 channel: own row matches by self name', () => {
    const own = row({ id: 'sent-1', fromPublicKey: 'local', fromName: 'Me-Node' });
    const r = parseMeshCoreReaction(`@[Alice]\u{1F44D}\n${HELLO}`, 'channel')!;
    expect(candidateMatchesReaction(r, own, { ...chan, selfName: 'Alice' })).toBe(true);
    expect(candidateMatchesReaction(r, own, { ...chan, selfName: 'Other' })).toBe(false);
    const byKey = row({ fromPublicKey: 'aabb', fromName: 'x' });
    expect(candidateMatchesReaction(r, byKey, { ...chan, selfName: 'Alice', selfKey: 'aabb' })).toBe(true);
    expect(candidateMatchesReaction(r, byKey, { ...chan, selfName: 'Alice' })).toBe(false);
  });
  it('mc1 channel: old row with null mc1Hash is rebuilt from stored fields', () => {
    expect(candidateMatchesReaction(mc1, row({ mc1Hash: null }), chan)).toBe(true);
    expect(candidateMatchesReaction(mc1, row({ mc1Hash: null, senderTimestamp: null }), chan)).toBe(true);
    expect(candidateMatchesReaction(mc1, row({ mc1Hash: null, senderTimestamp: null, timestamp: 5 }), chan)).toBe(false);
  });
  it('mc1 dm: hash only', () => {
    const r = parseMeshCoreReaction(`\u{1F44D}\n${HELLO}`, 'dm')!;
    expect(candidateMatchesReaction(r, row({ fromPublicKey: 'abcd', fromName: 'z' }), dm)).toBe(true);
    expect(candidateMatchesReaction(r, row({ mc1Hash: null }), dm)).toBe(true);
    expect(candidateMatchesReaction(r, row({ mc1Hash: null, text: 'Hellp' }), dm)).toBe(false);
  });

  it('mco-v3 channel and dm', () => {
    const hc = meshcoreOpenV3Hash(SEC, 'Bob', 'Hello')!;
    const hd = meshcoreOpenV3Hash(SEC, null, 'Hello')!;
    const rc = parseMeshCoreReaction(`r:${hc}:00`, 'channel')!;
    const rd = parseMeshCoreReaction(`r:${hd}:00`, 'dm')!;
    expect(rc.format).toBe('mco-v3');
    expect(candidateMatchesReaction(rc, row(), chan)).toBe(true);
    expect(candidateMatchesReaction(rd, row({ fromPublicKey: 'ab' }), dm)).toBe(true);
    expect(candidateMatchesReaction(rc, row({ fromName: 'Eve' }), chan)).toBe(false);
    expect(candidateMatchesReaction(rc, row({ senderTimestamp: null, timestamp: 5 }), chan)).toBe(false);
  });

  it('mco-v1 channel shape', () => {
    const r = parseMeshCoreReaction(
      `r:${SEC * 1000}_${dartStringHash('Bob')}_${dartStringHash('Hello')}:\u{1F44D}`,
      'channel',
    )!;
    expect(r.format).toBe('mco-v1');
    expect(candidateMatchesReaction(r, row(), chan)).toBe(true);
    expect(candidateMatchesReaction(r, row({ text: 'Hullo' }), chan)).toBe(false);
    expect(candidateMatchesReaction(r, row({ fromName: 'Eve' }), chan)).toBe(false);
  });
  it('mco-v1 dm shape', () => {
    const r = parseMeshCoreReaction(`r:${SEC * 1000 + 250}_aabbccdd:\u{1F44D}`, 'dm')!;
    const d = row({ fromPublicKey: 'AABBCCDD1122', fromName: null });
    expect(candidateMatchesReaction(r, d, dm)).toBe(true);
    expect(candidateMatchesReaction(r, row({ fromPublicKey: '11223344' }), dm)).toBe(false);
    const own = row({ id: 'sent-9', fromPublicKey: 'local' });
    expect(candidateMatchesReaction(r, own, { ...dm, selfKey: 'aabbccdd9999' })).toBe(true);
    expect(candidateMatchesReaction(r, own, dm)).toBe(false);
  });
});

describe('pending keys', () => {
  it('a reaction key equals one key its target offers', () => {
    const cases: Array<[string, 'channel' | 'dm']> = [
      [`@[Bob]\u{1F44D}\n${HELLO}`, 'channel'],
      [`r:${meshcoreOpenV3Hash(SEC, 'Bob', 'Hello')}:00`, 'channel'],
      [`r:${SEC * 1000}_${dartStringHash('Bob')}_${dartStringHash('Hello')}:\u{1F44D}`, 'channel'],
    ];
    for (const [text, scope] of cases) {
      const r = parseMeshCoreReaction(text, scope)!;
      const reactionHash = 'hash' in r ? r.hash : String(r.timestampMs);
      const key = pendingKeyOfReaction({ reactionFormat: r.format, reactionTargetHash: reactionHash });
      expect(pendingKeysOfMessage(row(), { scope })).toContain(key);
    }
  });
  it('offers no mc1 key without a hash, and nothing without a second', () => {
    expect(pendingKeysOfMessage(row({ mc1Hash: null }), chan).some((k) => k.startsWith('mc1:'))).toBe(false);
    expect(pendingKeysOfMessage(row({ mc1Hash: null, senderTimestamp: null, timestamp: 5 }), chan)).toEqual([]);
  });
});
