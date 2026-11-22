/**
 * `selfOrigin` on MQTT feed channel events (#6341 P6): a sibling radio's node
 * name or a recent override name marks the event as ours.
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

// A sibling MeshCore radio whose node is named "Sibling".
vi.mock('./sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getAllManagers: () => [{ getLocalNode: () => ({ name: 'Sibling' }) }],
  },
}));
vi.mock('./sourceManagerTypes.js', () => ({ isMeshCoreManager: () => true }));

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
import { noteSenderNameOverride, __resetSenderNameOverridesForTests } from './services/meshcoreLocalSenderNames.js';

const SECRET_HEX = '0123456789abcdef0123456789abcdef'; // 16 bytes
const SECRET_B64 = Buffer.from(SECRET_HEX, 'hex').toString('base64');
const OBSERVER_A = 'AA'.repeat(32);

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

beforeEach(() => {
  __resetSenderNameOverridesForTests();
  insertMessage.mockClear().mockResolvedValue(true);
  emitMeshCoreMessage.mockClear();
  getAllChannels.mockResolvedValue([{ id: 0, name: 'Public', psk: SECRET_B64 }]);
  lastClient = null;
  isReactionsInboundEnabled.mockReset().mockResolvedValue(false);
  resolveInboundReaction.mockReset().mockResolvedValue({ kind: 'not_reaction' });
  notePendingReaction.mockReset();
  resolvePendingReactionsFor.mockReset().mockResolvedValue([]);
  emitReactionResolutions.mockReset();
});

const deliver = async (body: string) => {
  await started();
  lastClient!.deliver(`meshcore/MCO/${OBSERVER_A}/packets`, msg(grpTxtFrame(1_700_000_000, body)));
  await vi.waitFor(() => expect(emitMeshCoreMessage).toHaveBeenCalledTimes(1));
  return emitMeshCoreMessage.mock.calls[0][0];
};

describe('selfOrigin on a feed channel message (#6341 P6)', () => {
  it('flags a message from a sibling radio node name', async () => {
    const event = await deliver('Sibling: hi');
    expect(event.selfOrigin).toBe(true);
    // The event flag never reaches the stored row.
    expect(insertMessage.mock.calls[0][0]).not.toHaveProperty('selfOrigin');
  });

  it('flags a message from a recent override name', async () => {
    noteSenderNameOverride('Bot');
    expect((await deliver('Bot: hi')).selfOrigin).toBe(true);
  });

  it('does not flag a stranger', async () => {
    expect(await deliver('Stranger: hi')).not.toHaveProperty('selfOrigin');
  });
});
