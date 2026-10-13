/**
 * End-to-end channel-message ingest (#5040 Phase 4).
 *
 * Builds a GENUINELY ENCRYPTED GRP_TXT frame — AES-128-ECB with the 2-byte
 * HMAC-SHA256 prefix MeshCore uses — so the whole path runs for real: frame
 * parse, channel-hash key selection, decrypt, id derivation, insert-or-ignore,
 * and the gated event emit. Stubbing the decrypt would leave the part most
 * likely to be wrong untested.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac, createCipheriv } from 'node:crypto';
import { ChannelCrypto } from '@michaelhart/meshcore-decoder';
import { ALL_SOURCES } from '../db/repositories/base.js';

const insertMessage = vi.fn().mockResolvedValue(true);
const getAllChannels = vi.fn();
const emitMeshCoreMessage = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      insertMessage: (...a: unknown[]) => insertMessage(...a),
      upsertNode: vi.fn().mockResolvedValue(undefined),
    },
    channels: { getAllChannels: (...a: unknown[]) => getAllChannels(...a) },
  },
}));
vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: { emitMeshCoreMessage: (...a: unknown[]) => emitMeshCoreMessage(...a) },
}));
const isReactionsInboundEnabled = vi.fn();
const resolveInboundReaction = vi.fn();
const notePendingReaction = vi.fn();
const resolvePendingReactionsFor = vi.fn();
const emitReactionResolutions = vi.fn();
vi.mock('./services/meshcoreReactionIngest.js', () => ({
  isReactionsInboundEnabled: (...a: unknown[]) => isReactionsInboundEnabled(...a),
  resolveInboundReaction: (...a: unknown[]) => resolveInboundReaction(...a),
  notePendingReaction: (...a: unknown[]) => notePendingReaction(...a),
  resolvePendingReactionsFor: (...a: unknown[]) => resolvePendingReactionsFor(...a),
  emitReactionResolutions: (...a: unknown[]) => emitReactionResolutions(...a),
}));
vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));

let lastClient: FakeClient | null = null;
class FakeClient {
  handlers = new Map<string, (a: unknown) => void>();
  connect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn().mockResolvedValue(undefined);
  isConnected = () => true;
  on(e: string, fn: (a: unknown) => void) { this.handlers.set(e, fn); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  deliver(topic: string, b: unknown) {
    this.handlers.get('message')?.({ topic, payload: Buffer.from(JSON.stringify(b)) });
  }
}
vi.mock('./transports/mqttBrokerClient.js', () => ({
  MqttBrokerClient: class { constructor() { lastClient = new FakeClient(); return lastClient as unknown as object; } },
}));

import { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import { mc1HashForChannelWire } from '../utils/meshcoreReactionTarget.js';
import { calculateMeshCorePacketHash } from './services/meshcoreObserverPacket.js';

const SECRET_HEX = '0123456789abcdef0123456789abcdef'; // 16 bytes
const SECRET_B64 = Buffer.from(SECRET_HEX, 'hex').toString('base64');
/** A second, distinct channel key so channel ROUTING can be proven. */
const SECRET3_HEX = 'fedcba9876543210fedcba9876543210';
const SECRET3_B64 = Buffer.from(SECRET3_HEX, 'hex').toString('base64');
const OBSERVER_A = 'AA'.repeat(32);
const OBSERVER_B = 'BB'.repeat(32);

/** Encrypt exactly as MeshCore does, so the shipping decrypt accepts it. */
function encryptChannelBody(
  timestampSec: number,
  body: string,
  secretHex: string = SECRET_HEX,
): { macHex: string; ctHex: string } {
  const text = Buffer.from(body, 'utf8');
  const plain = Buffer.alloc(5 + text.length);
  plain.writeUInt32LE(timestampSec, 0);
  plain[4] = 0; // flags
  text.copy(plain, 5);
  // AES-ECB with NoPadding needs a block multiple.
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16);
  plain.copy(padded);

  const cipher = createCipheriv('aes-128-ecb', Buffer.from(secretHex, 'hex'), null);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);

  // MAC: HMAC-SHA256 over the ciphertext, keyed with the 16-byte secret
  // zero-padded to 32 — first two bytes.
  const key32 = Buffer.alloc(32);
  Buffer.from(secretHex, 'hex').copy(key32);
  const mac = createHmac('sha256', key32).update(ct).digest();
  return { macHex: mac.subarray(0, 2).toString('hex'), ctHex: ct.toString('hex') };
}

/** header | path_len | channel_hash | mac(2) | ciphertext */
function grpTxtFrame(timestampSec: number, body: string, secretHex: string = SECRET_HEX): string {
  const { macHex, ctHex } = encryptChannelBody(timestampSec, body, secretHex);
  const hash = ChannelCrypto.calculateChannelHash(secretHex);
  const header = ((5 & 0x0f) << 2) | 1; // payload GRP_TXT(5), route FLOOD(1)
  return header.toString(16).padStart(2, '0') + '00' + hash + macHex + ctHex;
}

const msg = (raw: string, observer = OBSERVER_A) => ({
  type: 'PACKET', origin: 'Obs', origin_id: observer, raw, SNR: '-5', RSSI: '-88',
});

async function started() {
  const m = new MeshCoreMqttManager('src-mqtt', 'Feed', { brokerUrl: 'wss://b', region: 'MCO' });
  await m.start();
  return m;
}
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  insertMessage.mockClear().mockResolvedValue(true);
  emitMeshCoreMessage.mockClear();
  getAllChannels.mockResolvedValue([{ id: 0, name: 'Public', psk: SECRET_B64 }]);
  lastClient = null;
  isReactionsInboundEnabled.mockReset().mockResolvedValue(true);
  resolveInboundReaction.mockReset().mockResolvedValue({ kind: 'not_reaction' });
  notePendingReaction.mockReset();
  resolvePendingReactionsFor.mockReset().mockResolvedValue([]);
  emitReactionResolutions.mockReset();
});

describe('channel message ingest (#5040 Phase 4)', () => {
  it('decrypts a real GRP_TXT frame and stores it', async () => {
    const mgr = await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`,
      msg(grpTxtFrame(1_700_000_000, 'Alice: hello mesh')));
    await settle();

    expect(insertMessage).toHaveBeenCalledTimes(1);
    const [row, sourceId] = insertMessage.mock.calls[0];
    expect(sourceId).toBe('src-mqtt');
    expect(row).toMatchObject({ text: 'hello mesh', fromName: 'Alice', messageType: 'channel' });
    // Sender's timestamp, not ingest time.
    expect(row.timestamp).toBe(1_700_000_000_000);
    expect(mgr.getIngestStats().channelMessages).toBe(1);
  });

  it('puts the exact packet hash on the emitted message but not on the DB row (#5357)', async () => {
    await started();
    const frame = grpTxtFrame(1_700_000_000, 'Alice: hash me');
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`, msg(frame));
    await settle();

    const expected = calculateMeshCorePacketHash(frame);
    expect(expected).toMatch(/^[0-9A-F]{16}$/);
    expect(emitMeshCoreMessage).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreMessage.mock.calls[0][0].packetHash).toBe(expected);
    // meshcore_messages has no hash column: the insert row keeps its shape.
    const [row] = insertMessage.mock.calls[0];
    expect(row).not.toHaveProperty('packetHash');
    expect(row).toMatchObject({ text: 'hash me', fromName: 'Alice', messageType: 'channel' });
  });

  it('gives two observers of the SAME message one id — so it collapses to one row', async () => {
    await started();
    const frame = grpTxtFrame(1_700_000_000, 'Alice: same message');
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`, msg(frame, OBSERVER_A));
    await settle();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_B}/packets`, msg(frame, OBSERVER_B));
    await settle();

    expect(insertMessage).toHaveBeenCalledTimes(2);
    expect(insertMessage.mock.calls[0][0].id).toBe(insertMessage.mock.calls[1][0].id);
  });

  it('emits ONCE even when many observers relay the message', async () => {
    // The whole point: without the insert-or-ignore gate, twenty observers
    // would mean twenty notifications and twenty automation triggers.
    insertMessage.mockResolvedValueOnce(true).mockResolvedValue(false);
    const mgr = await started();
    const frame = grpTxtFrame(1_700_000_000, 'Alice: broadcast');

    for (const obs of [OBSERVER_A, OBSERVER_B, OBSERVER_A]) {
      lastClient!.deliver(`meshcore/MCO/${obs}/packets`, msg(frame, obs));
      await settle();
    }

    expect(insertMessage).toHaveBeenCalledTimes(3);
    expect(emitMeshCoreMessage).toHaveBeenCalledTimes(1);
    expect(mgr.getIngestStats().channelMessages).toBe(1);
  });

  it('files the message under the channel that decrypted it, not channel 0', async () => {
    // Regression for a bug caught in review on #5063. An empty fromPublicKey
    // does not simply hide these rows — it falls through
    // channelWhereClause(0)'s legacy "null recipient, non-channel sender"
    // branch, so EVERY ingested message would have filed under channel 0
    // whichever channel it actually came from. Silent mis-filing, not absence.
    getAllChannels.mockResolvedValue([
      { id: 0, name: 'Public', psk: SECRET_B64 },
      { id: 3, name: 'Gauntlet', psk: SECRET3_B64 },
    ]);
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`,
      msg(grpTxtFrame(1_700_000_000, 'Alice: on three', SECRET3_HEX)));
    await settle();

    expect(insertMessage).toHaveBeenCalledTimes(1);
    expect(insertMessage.mock.calls[0][0].fromPublicKey).toBe('channel-3');
  });

  it('still files a channel-0 message under channel 0', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, name: 'Public', psk: SECRET_B64 },
      { id: 3, name: 'Gauntlet', psk: SECRET3_B64 },
    ]);
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`,
      msg(grpTxtFrame(1_700_000_000, 'Alice: on zero')));
    await settle();

    expect(insertMessage.mock.calls[0][0].fromPublicKey).toBe('channel-0');
  });

  it('keeps a message with no "Sender: " prefix verbatim', async () => {
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`,
      msg(grpTxtFrame(1_700_000_000, 'no prefix here')));
    await settle();

    // undefined, not null: one object is both inserted and emitted, and the
    // event's MeshCoreMessage type declares `fromName?: string`.
    const row = insertMessage.mock.calls[0][0];
    expect(row.text).toBe('no prefix here');
    expect(row.fromName).toBeUndefined();
  });

  it('ignores a channel we hold no key for, without erroring', async () => {
    // The common case on a region feed: most traffic is for channels we are
    // not in, and that must not log or throw per packet.
    getAllChannels.mockResolvedValue([
      { id: 0, name: 'Other', psk: Buffer.from('ff'.repeat(16), 'hex').toString('base64') },
    ]);
    const mgr = await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`,
      msg(grpTxtFrame(1_700_000_000, 'Alice: secret')));
    await settle();

    expect(insertMessage).not.toHaveBeenCalled();
    expect(mgr.getIngestStats().channelMessages).toBe(0);
  });

  it('reads channel keys across ALL sources, since an ingest source holds none', async () => {
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`,
      msg(grpTxtFrame(1_700_000_000, 'Alice: x')));
    await settle();

    expect(getAllChannels).toHaveBeenCalled();
    // Assert the ALL_SOURCES sentinel POSITIVELY: a negative check would still
    // pass if a regression passed some third value that is neither this source
    // nor the sentinel.
    expect(getAllChannels.mock.calls[0][0]).toBe(ALL_SOURCES);
  });

  it('ignores non-GRP_TXT frames', async () => {
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`, msg('0500deadbeef'));
    await settle();
    expect(insertMessage).not.toHaveBeenCalled();
  });
});

describe('reactions on the MQTT ingest path (#5759)', () => {
  const TS = 1_700_000_000;
  const topic = `meshcore/MCO/${OBSERVER_A}/packets`;
  const REACTION_BODY = '@[Alice]\u{1F44D}\nb45pc4ek';
  const fields = (targetId: string | null) => ({
    reactionEmoji: '\u{1F44D}',
    reactionFormat: 'mc1-channel',
    reactionTargetHash: 'b45pc4ek',
    reactionTargetSender: 'Alice',
    reactionTargetId: targetId,
    reactionRawText: REACTION_BODY,
  });

  it('stores senderTimestamp and the MC1 hash on an ordinary row, and keeps the hash off the event', async () => {
    await started();
    lastClient!.deliver(topic, msg(grpTxtFrame(TS, 'Alice: Hello')));
    await settle();

    const [row] = insertMessage.mock.calls[0];
    expect(row.senderTimestamp).toBe(TS);
    expect(row.mc1Hash).toBe(mc1HashForChannelWire('Alice: Hello', TS));
    expect(row.mc1Hash).toMatch(/^[0-9a-z]{8}$/);
    const emitted = emitMeshCoreMessage.mock.calls[0][0];
    expect(emitted.senderTimestamp).toBe(TS);
    expect(emitted).not.toHaveProperty('mc1Hash');
    expect(resolveInboundReaction).not.toHaveBeenCalled();
    expect(resolvePendingReactionsFor).toHaveBeenCalledTimes(1);
    expect(resolvePendingReactionsFor.mock.calls[0][0]).toBe('src-mqtt');
    expect(resolvePendingReactionsFor.mock.calls[0][1]).toMatchObject({
      id: row.id, mc1Hash: row.mc1Hash, senderTimestamp: TS, fromName: 'Alice',
    });
  });

  it('stores a matched reaction as an emoji row with the target, keeping the raw-text id', async () => {
    // Same frame, once as chat and once as a reaction: the id must not move.
    await started();
    lastClient!.deliver(topic, msg(grpTxtFrame(TS, `Bob: ${REACTION_BODY}`)));
    await settle();
    const chatId = insertMessage.mock.calls[0][0].id;
    insertMessage.mockClear();
    emitMeshCoreMessage.mockClear();
    resolvePendingReactionsFor.mockClear();

    resolveInboundReaction.mockResolvedValue({ kind: 'reaction', fields: fields('tgt-1') });
    await started();
    lastClient!.deliver(topic, msg(grpTxtFrame(TS, `Bob: ${REACTION_BODY}`)));
    await settle();

    expect(resolveInboundReaction).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'src-mqtt', scope: 'channel', channelIdx: 0, body: REACTION_BODY,
      reactorName: 'Bob', selfName: null, selfKey: null,
    }));
    const [row] = insertMessage.mock.calls[0];
    expect(row.id).toBe(chatId);
    expect(row).toMatchObject({ text: '\u{1F44D}', fromName: 'Bob', senderTimestamp: TS, ...fields('tgt-1') });
    expect(row.mc1Hash).toBeNull();
    const emitted = emitMeshCoreMessage.mock.calls[0][0];
    expect(emitted).toMatchObject({ text: '\u{1F44D}', reactionEmoji: '\u{1F44D}', reactionTargetId: 'tgt-1' });
    expect(emitted).not.toHaveProperty('mc1Hash');
    expect(notePendingReaction).not.toHaveBeenCalled();
    expect(resolvePendingReactionsFor).not.toHaveBeenCalled();
  });

  it('records an unmatched reaction as pending', async () => {
    resolveInboundReaction.mockResolvedValue({ kind: 'reaction', fields: fields(null) });
    await started();
    lastClient!.deliver(topic, msg(grpTxtFrame(TS, `Bob: ${REACTION_BODY}`)));
    await settle();

    const [row] = insertMessage.mock.calls[0];
    expect(notePendingReaction).toHaveBeenCalledWith('src-mqtt', {
      id: row.id, reactionFormat: 'mc1-channel', reactionTargetHash: 'b45pc4ek',
    });
  });

  it('stores nothing and emits nothing for a duplicate reaction', async () => {
    resolveInboundReaction.mockResolvedValue({ kind: 'duplicate', existingId: 'x' });
    await started();
    lastClient!.deliver(topic, msg(grpTxtFrame(TS, `Bob: ${REACTION_BODY}`)));
    await settle();

    expect(insertMessage).not.toHaveBeenCalled();
    expect(emitMeshCoreMessage).not.toHaveBeenCalled();
  });

  it('stores reaction-shaped text as chat when inbound reactions are off', async () => {
    isReactionsInboundEnabled.mockResolvedValue(false);
    await started();
    lastClient!.deliver(topic, msg(grpTxtFrame(TS, `Bob: ${REACTION_BODY}`)));
    await settle();

    expect(resolveInboundReaction).not.toHaveBeenCalled();
    const [row] = insertMessage.mock.calls[0];
    expect(row.text).toBe(REACTION_BODY);
    expect(row.reactionEmoji).toBeUndefined();
    expect(row.mc1Hash).toMatch(/^[0-9a-z]{8}$/);
  });

  it('a second observer copy of a reaction is still one row and no extra bookkeeping', async () => {
    resolveInboundReaction.mockResolvedValue({ kind: 'reaction', fields: fields(null) });
    insertMessage.mockResolvedValueOnce(true).mockResolvedValue(false);
    await started();
    const frame = grpTxtFrame(TS, `Bob: ${REACTION_BODY}`);
    lastClient!.deliver(topic, msg(frame, OBSERVER_A));
    await settle();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_B}/packets`, msg(frame, OBSERVER_B));
    await settle();

    expect(insertMessage.mock.calls[0][0].id).toBe(insertMessage.mock.calls[1][0].id);
    expect(emitMeshCoreMessage).toHaveBeenCalledTimes(1);
    expect(notePendingReaction).toHaveBeenCalledTimes(1);
  });

  it('emits late resolutions when an ordinary row lets a waiting reaction resolve', async () => {
    const resolved = [{ reactionId: 'r1', targetId: 't1', droppedDuplicate: false, row: {} }];
    resolvePendingReactionsFor.mockResolvedValue(resolved);
    await started();
    lastClient!.deliver(topic, msg(grpTxtFrame(TS, 'Alice: Hello')));
    await settle();

    expect(emitReactionResolutions).toHaveBeenCalledWith('src-mqtt', resolved);
  });

  it('keeps the senderTimestamp off a clock-less sender (no wire second)', async () => {
    await started();
    lastClient!.deliver(topic, msg(grpTxtFrame(0, 'Alice: no clock')));
    await settle();

    const [row] = insertMessage.mock.calls[0];
    expect(row).not.toHaveProperty('senderTimestamp');
    expect(row.mc1Hash).toBeNull();
  });
});
