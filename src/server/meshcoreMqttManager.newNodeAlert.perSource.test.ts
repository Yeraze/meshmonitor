/**
 * Per-source isolation of the gated new-node alerts on two MQTT feeds (#6341 P2).
 *
 * The ingest pipeline and signature check are stubbed so each test picks what an
 * advert looks like; the tracker, gate (fake clock and settings store) and the
 * alert helper are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const env = vi.hoisted(() => ({
  clock: 1_800_000_000_000,
  store: new Map<string, string>(),
  earliest: new Map<string, number | null>(),
}));

const ingestAdvertFrame = vi.hoisted(() => vi.fn());
const verifyAdvertSignature = vi.hoisted(() => vi.fn());
const getNodeByPublicKeyAndSource = vi.hoisted(() => vi.fn());
const upsertNode = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const notifyNewMeshCoreNode = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const emit = vi.hoisted(() => vi.fn());

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: { getNodeByPublicKeyAndSource, upsertNode, insertPacket: vi.fn() },
    sources: { getSource: vi.fn().mockResolvedValue({ name: 'Feed' }) },
    getSettingAsync: vi.fn().mockResolvedValue('0'),
  },
}));
vi.mock('./services/notificationService.js', () => ({
  notificationService: { notifyNewMeshCoreNode },
}));
vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: { emit, on: vi.fn(), off: vi.fn() },
}));
vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));
vi.mock('./services/meshcoreFrameIngest.js', async (orig) => ({
  ...(await orig<typeof import('./services/meshcoreFrameIngest.js')>()),
  ingestAdvertFrame,
  verifyAdvertSignature,
}));
vi.mock('./services/newNodeAlertGate.js', async (orig) => {
  const actual = await orig<typeof import('./services/newNodeAlertGate.js')>();
  return {
    ...actual,
    newNodeAlertGate: new actual.NewNodeAlertGate({
      now: () => env.clock,
      getSourceSetting: async (s, k) => env.store.get(`${s}:${k}`) ?? null,
      setSourceSetting: async (s, k, v) => { env.store.set(`${s}:${k}`, v); },
      getEarliestNodeCreatedAt: async (s) => env.earliest.get(s) ?? null,
    }),
  };
});

import { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import { CAP_PER_HOUR, LEARN_MS } from './services/newNodeAlertGate.js';

const DAY = 24 * 3600_000;
const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

function mkManager(id = 'feed-a') {
  return new MeshCoreMqttManager(id, 'Feed', { brokerUrl: 'wss://b.example', region: 'MCO' });
}

function setAdvert(k: string, o: { inserted?: boolean; verified?: boolean; checked?: boolean; name?: string } = {}) {
  ingestAdvertFrame.mockResolvedValueOnce({
    advert: { publicKey: k },
    inserted: o.inserted ?? true,
    signatureVerified: o.verified ?? true,
    signatureChecked: o.checked ?? true,
  });
  getNodeByPublicKeyAndSource.mockResolvedValueOnce({ name: o.name ?? 'Node', advType: 2 });
}

const feed = (mgr: MeshCoreMqttManager) =>
  (mgr as unknown as { ingestAdvert(d: unknown): Promise<void> }).ingestAdvert({ event: { raw_hex: 'aa' } });

beforeEach(() => {
  env.clock = 1_800_000_000_000;
  env.store.clear();
  env.earliest.clear();
  env.earliest.set('feed-a', env.clock - 30 * DAY);
  env.earliest.set('feed-b', env.clock - 30 * DAY);
  ingestAdvertFrame.mockReset();
  verifyAdvertSignature.mockReset().mockResolvedValue(true);
  getNodeByPublicKeyAndSource.mockReset();
  notifyNewMeshCoreNode.mockClear();
  upsertNode.mockClear();
  emit.mockClear();
});

describe('MQTT feed new-node alerts are per source (#6341 P2)', () => {
  it('dedups per source: one advert key alerts once on each feed', async () => {
    const a = mkManager('feed-a');
    const b = mkManager('feed-b');
    setAdvert(key(1)); await feed(a);
    setAdvert(key(1), { inserted: false }); await feed(a);
    setAdvert(key(1)); await feed(b);
    const sources = notifyNewMeshCoreNode.mock.calls.map(c => c[3]);
    expect(sources).toEqual(['feed-a', 'feed-b']);
  });

  it('learning and the hourly cap are separate per source', async () => {
    env.earliest.set('feed-b', null); // b is brand new and learning
    const a = mkManager('feed-a');
    const b = mkManager('feed-b');
    for (let i = 1; i <= CAP_PER_HOUR + 2; i++) { setAdvert(key(i)); await feed(a); }
    setAdvert(key(100)); await feed(b);
    const bySource = (id: string) => notifyNewMeshCoreNode.mock.calls.filter(c => c[3] === id).length;
    expect(bySource('feed-a')).toBe(CAP_PER_HOUR);
    expect(bySource('feed-b')).toBe(0);
    // b's window opens on its own clock, untouched by a's traffic
    env.clock += LEARN_MS + 1;
    env.earliest.set('feed-a', env.clock - 30 * DAY);
    setAdvert(key(101)); await feed(b);
    expect(bySource('feed-b')).toBe(1);
  });
});
