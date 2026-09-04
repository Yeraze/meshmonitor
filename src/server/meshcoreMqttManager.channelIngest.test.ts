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
    // Called with the ALL_SOURCES sentinel, not this source's id.
    expect(getAllChannels.mock.calls[0][0]).not.toBe('src-mqtt');
  });

  it('ignores non-GRP_TXT frames', async () => {
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`, msg('0500deadbeef'));
    await settle();
    expect(insertMessage).not.toHaveBeenCalled();
  });
});
