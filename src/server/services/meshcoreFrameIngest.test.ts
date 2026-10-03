/**
 * Shared raw-frame ingest (#5551, #5553): key lookup by channel hash, GRP_TXT
 * decrypt, the secret-derived channel index / fingerprint, and ADVERT → node.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelCrypto } from '@michaelhart/meshcore-decoder';
import { ALL_SOURCES } from '../../db/repositories/base.js';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const getAllChannels = vi.fn();
const getEnabledVirtual = vi.fn();
vi.mock('../../services/database.js', () => ({
  default: {
    meshcore: { upsertNode: (...a: unknown[]) => upsertNode(...a) },
    channels: { getAllChannels: (...a: unknown[]) => getAllChannels(...a) },
    channelDatabase: { getEnabledAsync: (...a: unknown[]) => getEnabledVirtual(...a) },
  },
}));

import {
  pskToHex,
  advertLastHeardMs,
  channelKeyFingerprint,
  keyedChannelIndex,
  isKeyedChannelIndex,
  MESHCORE_KEYED_CHANNEL_BASE,
  findChannelKeysByHash,
  decryptGroupTextFrame,
  frameChannelMessageId,
  ingestAdvertFrame,
} from './meshcoreFrameIngest.js';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import { buildGrpTxtFrame, buildAdvertFrame } from '../test-helpers/meshcoreFrames.js';

const SECRET_A = '0123456789abcdef0123456789abcdef';
const SECRET_B = 'fedcba9876543210fedcba9876543210';
const B64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const NODE_KEY = '11'.repeat(32);

const groupOf = (rawHex: string) => decodeMeshCorePacket(rawHex)!.payload.groupText!;

beforeEach(() => {
  upsertNode.mockClear();
  getAllChannels.mockReset();
  getEnabledVirtual.mockReset().mockResolvedValue([]);
});

describe('pskToHex / advertLastHeardMs', () => {
  it('accepts hex and base64 and rejects empties', () => {
    expect(pskToHex(SECRET_A.toUpperCase())).toBe(SECRET_A);
    expect(pskToHex(B64(SECRET_A))).toBe(SECRET_A);
    expect(pskToHex('')).toBeNull();
    expect(pskToHex(null)).toBeNull();
  });

  it('caps a future advert time at now and drops a missing one', () => {
    expect(advertLastHeardMs(1_600_000_000, 2e12)).toBe(1_600_000_000_000);
    expect(advertLastHeardMs(4_000_000_000, 2e12)).toBe(2e12);
    expect(advertLastHeardMs(0)).toBeUndefined();
  });
});

describe('channelKeyFingerprint / keyedChannelIndex', () => {
  it('is a 16-hex one-way digest whose first byte is the on-air channel hash', () => {
    const fp = channelKeyFingerprint(SECRET_A);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain(SECRET_A.slice(0, 8));
    expect(fp.slice(0, 2)).toBe(ChannelCrypto.calculateChannelHash(SECRET_A));
    expect(channelKeyFingerprint(SECRET_A.toUpperCase())).toBe(fp);
    expect(channelKeyFingerprint(SECRET_B)).not.toBe(fp);
  });

  it('derives a stable index above every device slot and the CHANNEL_DB_OFFSET range', () => {
    const idx = keyedChannelIndex(SECRET_A);
    expect(idx).toBe(keyedChannelIndex(SECRET_A));
    expect(idx).toBeGreaterThanOrEqual(MESHCORE_KEYED_CHANNEL_BASE);
    expect(idx).toBeLessThan(MESHCORE_KEYED_CHANNEL_BASE + 65536);
    expect(isKeyedChannelIndex(idx)).toBe(true);
    expect(isKeyedChannelIndex(7)).toBe(false);
    expect(isKeyedChannelIndex(140)).toBe(false);
  });
});

describe('findChannelKeysByHash', () => {
  it('reads keys across ALL sources and keeps only the matching hash', async () => {
    getAllChannels.mockResolvedValue([
      { id: 2, name: 'ops', psk: B64(SECRET_A), sourceId: 'src-x' },
      { id: 5, name: 'other', psk: B64(SECRET_B), sourceId: 'src-y' },
      { id: 6, name: 'nokey', psk: null, sourceId: 'src-y' },
    ]);
    const found = await findChannelKeysByHash(ChannelCrypto.calculateChannelHash(SECRET_A));
    expect(getAllChannels).toHaveBeenCalledWith(ALL_SOURCES);
    expect(found).toEqual([{ sourceId: 'src-x', channelIdx: 2, channelDbId: null, name: 'ops', secretHex: SECRET_A }]);
  });

  it('adds MeshCore virtual channels after device keys, once per secret (#5552)', async () => {
    getAllChannels.mockResolvedValue([{ id: 2, name: 'ops', psk: B64(SECRET_A), sourceId: 'src-x' }]);
    getEnabledVirtual.mockResolvedValue([
      // Same secret as the device key: the device key already covers it.
      { id: 11, name: 'ops (virtual)', psk: B64(SECRET_A) },
      { id: 12, name: 'only virtual', psk: B64(SECRET_B) },
    ]);
    const a = await findChannelKeysByHash(ChannelCrypto.calculateChannelHash(SECRET_A));
    expect(a.map((k) => k.channelDbId)).toEqual([null]);
    const b = await findChannelKeysByHash(ChannelCrypto.calculateChannelHash(SECRET_B));
    expect(b).toEqual([{ sourceId: null, channelIdx: null, channelDbId: 12, name: 'only virtual', secretHex: SECRET_B }]);
    // Only MeshCore rows are ever requested.
    expect(getEnabledVirtual).toHaveBeenCalledWith('meshcore');
  });

  it('a failed virtual-channel read leaves device keys usable', async () => {
    getAllChannels.mockResolvedValue([{ id: 2, name: 'ops', psk: B64(SECRET_A), sourceId: 'src-x' }]);
    getEnabledVirtual.mockRejectedValue(new Error('db down'));
    expect(await findChannelKeysByHash(ChannelCrypto.calculateChannelHash(SECRET_A))).toHaveLength(1);
  });

  it('uses a caller-supplied row list without reading the database', async () => {
    const found = await findChannelKeysByHash(
      ChannelCrypto.calculateChannelHash(SECRET_B),
      [{ id: 1, name: 'b', psk: SECRET_B, sourceId: 's' }],
    );
    expect(getAllChannels).not.toHaveBeenCalled();
    expect(found).toHaveLength(1);
  });
});

describe('decryptGroupTextFrame', () => {
  it('decrypts with a key held by another source and reports which key', async () => {
    getAllChannels.mockResolvedValue([{ id: 3, name: 'ops', psk: B64(SECRET_A), sourceId: 'src-x' }]);
    const res = await decryptGroupTextFrame(groupOf(buildGrpTxtFrame(1_700_000_000, 'Alice: hello', SECRET_A)));
    expect(res).toMatchObject({
      text: 'hello',
      senderName: 'Alice',
      timestampSec: 1_700_000_000,
      key: { sourceId: 'src-x', channelIdx: 3, channelDbId: null, name: 'ops', secretHex: SECRET_A },
    });
  });

  it('returns null when no stored key matches', async () => {
    getAllChannels.mockResolvedValue([{ id: 3, name: 'ops', psk: B64(SECRET_B), sourceId: 'src-x' }]);
    expect(await decryptGroupTextFrame(groupOf(buildGrpTxtFrame(1, 'Alice: hi', SECRET_A)))).toBeNull();
  });
});

describe('frameChannelMessageId', () => {
  it('is stable per (source, channel, time, text) and differs across sources', () => {
    const a = frameChannelMessageId('rpt', 's1', 'ab', 10, 'hi');
    expect(a).toBe(frameChannelMessageId('rpt', 's1', 'ab', 10, 'hi'));
    expect(a).toMatch(/^rpt_s1_[0-9a-f]{24}$/);
    expect(frameChannelMessageId('rpt', 's2', 'ab', 10, 'hi')).not.toBe(a);
    expect(frameChannelMessageId('rpt', 's1', 'ab', 11, 'hi')).not.toBe(a);
  });
});

describe('ingestAdvertFrame', () => {
  it('upserts the advert fields with undefined-preserves semantics', async () => {
    const advert = await ingestAdvertFrame(
      buildAdvertFrame({ publicKey: NODE_KEY, advType: 2 }),
      'src-rep',
      { lastHeardMs: 1234 },
    );
    expect(advert?.publicKey.toLowerCase()).toBe(NODE_KEY);
    expect(upsertNode).toHaveBeenCalledTimes(1);
    const [node, sourceId] = upsertNode.mock.calls[0];
    expect(sourceId).toBe('src-rep');
    expect(node).toMatchObject({ advType: 2, lastHeard: 1234 });
    // No name / position on the wire => undefined, so stored values survive.
    expect(node.name).toBeUndefined();
    expect(node.latitude).toBeUndefined();
    expect(node.positionSource).toBeUndefined();
    // #5578: the positionless advert is still recorded as such.
    expect(node.lastAdvertHadPosition).toBe(false);
    // The neighbour marker and link signal are never written from an advert.
    expect(node).not.toHaveProperty('repeaterNeighborAt');
    expect(node).not.toHaveProperty('snr');
  });

  it("uses the advert's own time, capped at now, in 'advert' mode", async () => {
    await ingestAdvertFrame(
      buildAdvertFrame({ publicKey: NODE_KEY, timestamp: 1_700_000_000, name: 'Hill', lat: 45.5, lon: -122.5 }),
      'src-mqtt',
      { lastHeardMs: 'advert' },
    );
    const [node] = upsertNode.mock.calls[0];
    expect(node).toMatchObject({ name: 'Hill', lastHeard: 1_700_000_000_000, positionSource: 'contact' });
    expect(node.latitude).toBeCloseTo(45.5, 5);
    // #5578
    expect(node.lastAdvertHadPosition).toBe(true);
  });

  it('records an advert that carries 0/0 as having no position (#5578)', async () => {
    await ingestAdvertFrame(
      buildAdvertFrame({ publicKey: NODE_KEY, name: 'Zero', lat: 0, lon: 0 }),
      'src-mqtt',
      { lastHeardMs: 1 },
    );
    const [node] = upsertNode.mock.calls[0];
    expect(node.lastAdvertHadPosition).toBe(false);
  });

  it('skips a named key and ignores non-advert frames', async () => {
    expect(await ingestAdvertFrame(buildAdvertFrame({ publicKey: NODE_KEY }), 's', { lastHeardMs: 1, skipPublicKey: NODE_KEY.toUpperCase() })).toBeNull();
    expect(await ingestAdvertFrame(buildGrpTxtFrame(1, 'A: b', SECRET_A), 's', { lastHeardMs: 1 })).toBeNull();
    expect(upsertNode).not.toHaveBeenCalled();
  });
});
