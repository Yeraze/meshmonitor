/**
 * MeshCore MQTT ingest — Ignore / Block (#5408). A real encrypted GRP_TXT
 * frame runs the whole ingest path; only the DB and the event bus are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac, createCipheriv } from 'node:crypto';
import { ChannelCrypto } from '@michaelhart/meshcore-decoder';

const insertMessage = vi.fn().mockResolvedValue(true);
const emitMeshCoreMessage = vi.fn();
const listNodes = vi.fn().mockResolvedValue([]);
const listRules = vi.fn().mockResolvedValue([]);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      insertMessage: (...a: unknown[]) => insertMessage(...a),
      upsertNode: vi.fn().mockResolvedValue(undefined),
    },
    channels: { getAllChannels: vi.fn().mockResolvedValue([{ id: 0, name: 'Public', psk: Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64') }]) },
    getMeshCoreIgnoredNodesAsync: (...a: unknown[]) => listNodes(...a),
    getMeshCoreMessageFiltersAsync: (...a: unknown[]) => listRules(...a),
    addMeshCoreIgnoredNodeHitsAsync: vi.fn().mockResolvedValue(undefined),
    addMeshCoreMessageFilterHitsAsync: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: { emitMeshCoreMessage: (...a: unknown[]) => emitMeshCoreMessage(...a), emitMeshCoreFiltersChanged: vi.fn() },
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
import { meshcoreMessageFilter } from './services/meshcoreMessageFilter.js';

const SECRET_HEX = '0123456789abcdef0123456789abcdef';
const OBSERVER = 'AA'.repeat(32);

function grpTxtFrame(timestampSec: number, body: string): string {
  const text = Buffer.from(body, 'utf8');
  const plain = Buffer.alloc(5 + text.length);
  plain.writeUInt32LE(timestampSec, 0);
  text.copy(plain, 5);
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16);
  plain.copy(padded);
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(SECRET_HEX, 'hex'), null);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  const key32 = Buffer.alloc(32);
  Buffer.from(SECRET_HEX, 'hex').copy(key32);
  const mac = createHmac('sha256', key32).update(ct).digest().subarray(0, 2).toString('hex');
  const header = ((5 & 0x0f) << 2) | 1;
  return header.toString(16).padStart(2, '0') + '00' + ChannelCrypto.calculateChannelHash(SECRET_HEX) + mac + ct.toString('hex');
}

const deliver = (raw: string) =>
  lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, { type: 'PACKET', origin: 'Obs', origin_id: OBSERVER, raw, SNR: '-5', RSSI: '-88' });
const settle = () => new Promise(r => setTimeout(r, 0));

function rule(mode: 'ignore' | 'block', pattern: string) {
  return {
    id: `r-${mode}`, sourceId: 'src-mqtt', mode, matchType: 'wildcard', pattern, caseSensitive: false,
    fields: 'both', enabled: true, createdAt: 1, createdBy: null, hitCount: 0, lastHitAt: null,
  };
}

beforeEach(() => {
  meshcoreMessageFilter.resetForTests();
  insertMessage.mockClear().mockResolvedValue(true);
  emitMeshCoreMessage.mockClear();
  listNodes.mockResolvedValue([]);
  listRules.mockResolvedValue([]);
  lastClient = null;
});

describe('MQTT channel ingest — Ignore / Block (#5408)', () => {
  it('loads the lists on start and drops a blocked message before storing it', async () => {
    listRules.mockResolvedValue([rule('block', '*casino*')]);
    const mgr = new MeshCoreMqttManager('src-mqtt', 'Feed', { brokerUrl: 'wss://b', region: 'MCO' });
    await mgr.start();
    expect(listRules).toHaveBeenCalledWith('src-mqtt');
    deliver(grpTxtFrame(1_700_000_000, 'Bob: online casino'));
    await settle();
    expect(insertMessage).not.toHaveBeenCalled();
    expect(emitMeshCoreMessage).not.toHaveBeenCalled();
  });

  it('stores an ignored message and flags the emitted event', async () => {
    listRules.mockResolvedValue([rule('ignore', 'bob')]);
    const mgr = new MeshCoreMqttManager('src-mqtt', 'Feed', { brokerUrl: 'wss://b', region: 'MCO' });
    await mgr.start();
    deliver(grpTxtFrame(1_700_000_001, 'Bob: hello'));
    await settle();
    expect(insertMessage).toHaveBeenCalledTimes(1);
    expect(insertMessage.mock.calls[0][0]).not.toHaveProperty('filtered');
    expect(emitMeshCoreMessage.mock.calls[0][0]).toMatchObject({ filtered: 'ignore', fromName: 'Bob' });
  });
});
