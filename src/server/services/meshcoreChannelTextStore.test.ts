/**
 * Shared GRP_TXT store path (#6341 P6). The golden ids pin today's row ids for
 * the repeater ('rpt'), companion ('cmp') and MQTT ('mqtt') paths: they must
 * never change, or every stored message would re-insert under a new id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DecryptedGroupText } from './meshcoreFrameIngest.js';
import { frameChannelMessageId } from './meshcoreFrameIngest.js';
import { storeDecryptedChannelText } from './meshcoreChannelTextStore.js';
import { noteSenderNameOverride, __resetSenderNameOverridesForTests } from './meshcoreLocalSenderNames.js';

const insertMessage = vi.fn();
const incrementDecryptedCountAsync = vi.fn();
const emitMeshCoreMessage = vi.fn();
const classify = vi.fn();
const countHit = vi.fn();
const isReactionsInboundEnabled = vi.fn();
const resolveInboundReaction = vi.fn();
const notePendingReaction = vi.fn();
const resolvePendingReactionsFor = vi.fn();
const emitReactionResolutions = vi.fn();
const getAllManagers = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    meshcore: { insertMessage: (...a: unknown[]) => insertMessage(...a) },
    channelDatabase: { incrementDecryptedCountAsync: (...a: unknown[]) => incrementDecryptedCountAsync(...a) },
  },
}));
vi.mock('./dataEventEmitter.js', () => ({
  dataEventEmitter: { emitMeshCoreMessage: (...a: unknown[]) => emitMeshCoreMessage(...a) },
}));
vi.mock('./meshcoreMessageFilter.js', () => ({
  meshcoreMessageFilter: {
    classify: (...a: unknown[]) => classify(...a),
    countHit: (...a: unknown[]) => countHit(...a),
  },
}));
vi.mock('./meshcoreReactionIngest.js', () => ({
  isReactionsInboundEnabled: (...a: unknown[]) => isReactionsInboundEnabled(...a),
  resolveInboundReaction: (...a: unknown[]) => resolveInboundReaction(...a),
  notePendingReaction: (...a: unknown[]) => notePendingReaction(...a),
  resolvePendingReactionsFor: (...a: unknown[]) => resolvePendingReactionsFor(...a),
  emitReactionResolutions: (...a: unknown[]) => emitReactionResolutions(...a),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getAllManagers: () => getAllManagers() },
}));

const SECRET = '0102030405060708090a0b0c0d0e0f10';
const FINGERPRINT = '5dfbabeedf318bf3';
const TS = 1790000000;
const SRC = 'src1';

function plain(over: Partial<DecryptedGroupText> = {}): DecryptedGroupText {
  return {
    text: 'Alice: hello',
    senderName: 'Alice',
    timestampSec: TS,
    key: { sourceId: SRC, channelIdx: 2, channelDbId: null, name: 'ch', secretHex: SECRET },
    ...over,
  };
}

const deviceOpts = (prefix: string) => ({
  sourceId: SRC,
  rawHex: 'zz',
  buildId: (f: { keyFingerprint: string }) => frameChannelMessageId(prefix, SRC, f.keyFingerprint, TS, 'Alice: hello'),
  snr: 5,
  rssi: -90,
  radio: { hopCount: 2, hops: ['aa', 'bb'] },
  self: { name: 'MyNode', key: 'k'.repeat(64) },
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetSenderNameOverridesForTests();
  insertMessage.mockResolvedValue(true);
  incrementDecryptedCountAsync.mockResolvedValue(undefined);
  classify.mockReturnValue({ action: 'allow' });
  isReactionsInboundEnabled.mockResolvedValue(true);
  resolvePendingReactionsFor.mockResolvedValue([]);
  getAllManagers.mockReturnValue([]);
});

describe('golden ids', () => {
  it('rpt and cmp key on the key fingerprint', async () => {
    const rpt = await storeDecryptedChannelText(plain(), deviceOpts('rpt'));
    const cmp = await storeDecryptedChannelText(plain(), deviceOpts('cmp'));
    expect(rpt).toMatchObject({ kind: 'stored', id: `rpt_${SRC}_864ac7c5694e6cf21ba52678` });
    expect(cmp).toMatchObject({ kind: 'stored', id: `cmp_${SRC}_864ac7c5694e6cf21ba52678` });
    expect(insertMessage.mock.calls[0][0]).toMatchObject({ keyFingerprint: FINGERPRINT });
  });

  it('mqtt keys on the frame channel hash', async () => {
    const res = await storeDecryptedChannelText(plain(), {
      sourceId: SRC,
      rawHex: 'zz',
      buildId: () => frameChannelMessageId('mqtt', SRC, '3f', TS, 'Alice: hello'),
      self: null,
    });
    expect(res).toMatchObject({ kind: 'stored', id: `mqtt_${SRC}_5c959a6909608d11f2d4e8d5` });
  });
});

describe('filter', () => {
  it('block calls onBlocked and does not insert', async () => {
    const verdict = { action: 'block' };
    classify.mockReturnValue(verdict);
    const onBlocked = vi.fn();
    const res = await storeDecryptedChannelText(plain(), { ...deviceOpts('rpt'), onBlocked });
    expect(res.kind).toBe('blocked');
    expect(onBlocked).toHaveBeenCalledWith(expect.stringMatching(/^rpt_/), verdict);
    expect(insertMessage).not.toHaveBeenCalled();
    expect(countHit).not.toHaveBeenCalled();
  });

  it('ignore stores and flags the event', async () => {
    classify.mockReturnValue({ action: 'ignore' });
    const res = await storeDecryptedChannelText(plain(), deviceOpts('rpt'));
    expect(insertMessage).toHaveBeenCalledTimes(1);
    expect(res.kind === 'stored' && res.event.filtered).toBe('ignore');
    expect(countHit).toHaveBeenCalledTimes(1);
  });
});

describe('insert false', () => {
  it('does not emit, hook or count', async () => {
    insertMessage.mockResolvedValue(false);
    const onStored = vi.fn();
    const afterStored = vi.fn();
    const res = await storeDecryptedChannelText(plain(), { ...deviceOpts('rpt'), onStored, afterStored });
    expect(res.kind).toBe('not-inserted');
    expect(emitMeshCoreMessage).not.toHaveBeenCalled();
    expect(onStored).not.toHaveBeenCalled();
    expect(afterStored).not.toHaveBeenCalled();
    expect(countHit).not.toHaveBeenCalled();
    expect(incrementDecryptedCountAsync).not.toHaveBeenCalled();
  });
});

describe('reactions', () => {
  const fields = {
    reactionEmoji: '👍',
    reactionTargetId: null,
    reactionFormat: 'mc1',
    reactionTargetHash: 'abcd',
  };

  it('stores the emoji, notes a pending target, skips afterStored', async () => {
    resolveInboundReaction.mockResolvedValue({ kind: 'reaction', fields });
    const afterStored = vi.fn();
    const res = await storeDecryptedChannelText(plain({ text: 'r:abcd1234 x' }), { ...deviceOpts('rpt'), afterStored });
    expect(insertMessage.mock.calls[0][0]).toMatchObject({ text: '👍', mc1Hash: null, reactionFormat: 'mc1' });
    expect(notePendingReaction).toHaveBeenCalledWith(SRC, {
      id: expect.stringMatching(/^rpt_/),
      reactionFormat: 'mc1',
      reactionTargetHash: 'abcd',
    });
    expect(afterStored).not.toHaveBeenCalled();
    expect(res.kind).toBe('stored');
  });

  it('no pending note without format and hash', async () => {
    resolveInboundReaction.mockResolvedValue({
      kind: 'reaction',
      fields: { ...fields, reactionFormat: null, reactionTargetHash: null },
    });
    await storeDecryptedChannelText(plain({ text: 'r:abcd1234 x' }), deviceOpts('rpt'));
    expect(notePendingReaction).not.toHaveBeenCalled();
  });

  it('duplicate returns early', async () => {
    resolveInboundReaction.mockResolvedValue({ kind: 'duplicate' });
    const res = await storeDecryptedChannelText(plain({ text: 'r:abcd1234 x' }), deviceOpts('rpt'));
    expect(res.kind).toBe('duplicate-reaction');
    expect(insertMessage).not.toHaveBeenCalled();
  });
});

describe('ordinary message', () => {
  it('emits before afterStored, and the default resolves and emits resolutions', async () => {
    const order: string[] = [];
    emitMeshCoreMessage.mockImplementation(() => order.push('emit'));
    const afterStored = vi.fn(async () => { order.push('after'); });
    await storeDecryptedChannelText(plain(), { ...deviceOpts('rpt'), afterStored });
    expect(order).toEqual(['emit', 'after']);

    resolvePendingReactionsFor.mockResolvedValue([{ reactionId: 'r', targetId: 't' }]);
    await storeDecryptedChannelText(plain({ timestampSec: TS + 1 }), {
      sourceId: SRC,
      rawHex: 'zz',
      buildId: () => 'x',
      self: null,
    });
    expect(resolvePendingReactionsFor).toHaveBeenCalledWith(
      SRC,
      expect.objectContaining({ id: 'x', fromPublicKey: expect.stringMatching(/^channel-/) }),
      { selfName: null, selfKey: null },
    );
    expect(emitReactionResolutions).toHaveBeenCalledWith(SRC, [{ reactionId: 'r', targetId: 't' }]);
  });

  it('onStored gets the message without event-only fields', async () => {
    const onStored = vi.fn();
    await storeDecryptedChannelText(plain(), { ...deviceOpts('rpt'), onStored });
    const arg = onStored.mock.calls[0][0];
    expect(arg).not.toHaveProperty('packetHash');
    expect(arg).not.toHaveProperty('selfOrigin');
    expect(arg).not.toHaveProperty('filtered');
  });
});

describe('selfOrigin', () => {
  it('is set for an override name', async () => {
    noteSenderNameOverride('alice');
    const res = await storeDecryptedChannelText(plain(), deviceOpts('rpt'));
    expect(res.kind === 'stored' && res.event.selfOrigin).toBe(true);
  });

  it('is set for a sibling manager name', async () => {
    getAllManagers.mockReturnValue([{ sourceType: 'meshcore', getLocalNode: () => ({ name: ' ALICE ' }) }]);
    const res = await storeDecryptedChannelText(plain(), deviceOpts('rpt'));
    expect(res.kind === 'stored' && res.event.selfOrigin).toBe(true);
  });

  it('is absent otherwise', async () => {
    getAllManagers.mockReturnValue([{ sourceType: 'meshcore', getLocalNode: () => ({ name: 'Other' }) }]);
    const res = await storeDecryptedChannelText(plain(), deviceOpts('rpt'));
    expect(res.kind === 'stored' && res.event).not.toHaveProperty('selfOrigin');
  });
});

describe('row shape', () => {
  it('device: radio fields, receivedAt, sourceId, toPublicKey null', async () => {
    const res = await storeDecryptedChannelText(plain(), deviceOpts('rpt'));
    const row = insertMessage.mock.calls[0][0];
    expect(row).toMatchObject({
      toPublicKey: null,
      hopCount: 2,
      routePath: 'aa,bb',
      snr: 5,
      rssi: -90,
      senderTimestamp: TS,
      keySourceId: SRC,
      keyChannelIdx: 2,
      keyFingerprint: FINGERPRINT,
    });
    expect(res.kind === 'stored' && res.event).toMatchObject({ sourceId: SRC, hopCount: 2, routePath: 'aa,bb' });
    expect(res.kind === 'stored' && typeof res.event.receivedAt).toBe('number');
  });

  it('feed: no radio fields, createdAt kept, key fields present', async () => {
    const res = await storeDecryptedChannelText(plain(), {
      sourceId: SRC,
      rawHex: 'zz',
      buildId: () => 'mqtt_x',
      snr: 3,
      self: null,
    });
    const row = insertMessage.mock.calls[0][0];
    expect(row).not.toHaveProperty('toPublicKey');
    expect(row).not.toHaveProperty('hopCount');
    expect(row).not.toHaveProperty('routePath');
    expect(row).toMatchObject({ keyFingerprint: FINGERPRINT, keySourceId: SRC, keyChannelIdx: 2, snr: 3 });
    if (res.kind !== 'stored') throw new Error('not stored');
    expect(res.event).not.toHaveProperty('hopCount');
    expect(res.event).not.toHaveProperty('routePath');
    expect(res.event).not.toHaveProperty('receivedAt');
    expect(res.event).not.toHaveProperty('sourceId');
    expect(typeof (res.event as { createdAt?: number }).createdAt).toBe('number');
  });

  it('feed: clock-less sender omits senderTimestamp only when no wire second', async () => {
    const res = await storeDecryptedChannelText(plain({ timestampSec: 0 }), {
      sourceId: SRC, rawHex: 'zz', buildId: () => 'm', self: null,
    });
    expect(res.kind).toBe('stored');
  });
});
