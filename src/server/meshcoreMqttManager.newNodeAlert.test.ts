/**
 * Gated new-node alerts for an MQTT feed source (#6341 P2).
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
import { MeshCoreMqttBrokerManager } from './meshcoreMqttBrokerManager.js';
import { CAP_PER_HOUR, CAP_WINDOW_MS, LEARN_MS } from './services/newNodeAlertGate.js';

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

describe('MQTT feed new-node alerts (#6341 P2)', () => {
  it('stays silent while the source is learning', async () => {
    env.earliest.set('feed-a', null);
    setAdvert(key(1));
    await feed(mkManager());
    expect(notifyNewMeshCoreNode).not.toHaveBeenCalled();
  });

  it('alerts once armed, with the stored name and device type label', async () => {
    setAdvert(key(1), { name: 'Hill Repeater' });
    await feed(mkManager());
    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(1);
    expect(notifyNewMeshCoreNode).toHaveBeenCalledWith(key(1), 'Hill Repeater', 'Repeater', 'feed-a', 'Feed');
  });

  it('drops the 11th in an hour, and the next hour carries "(+N more)"', async () => {
    const mgr = mkManager();
    for (let i = 1; i <= CAP_PER_HOUR + 1; i++) { setAdvert(key(i)); await feed(mgr); }
    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(CAP_PER_HOUR);
    env.clock += CAP_WINDOW_MS + 1;
    setAdvert(key(50));
    await feed(mgr);
    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(CAP_PER_HOUR + 1);
    expect(notifyNewMeshCoreNode.mock.calls[CAP_PER_HOUR][5]).toBe(1);
  });

  it('refuses an unverified advert; verifies once; never writes the marker', async () => {
    verifyAdvertSignature.mockResolvedValue(false);
    setAdvert(key(1), { verified: false, checked: false });
    await feed(mkManager());
    expect(verifyAdvertSignature).toHaveBeenCalledTimes(1);
    expect(notifyNewMeshCoreNode).not.toHaveBeenCalled();
    expect(upsertNode).not.toHaveBeenCalled();
    expect(ingestAdvertFrame.mock.calls[0][2]).toMatchObject({ verifySignature: 'toggle' });
  });

  it('does not re-verify an advert the ingest already checked', async () => {
    setAdvert(key(1), { verified: true, checked: true });
    await feed(mkManager());
    setAdvert(key(2), { verified: false, checked: true });
    await feed(mkManager());
    expect(verifyAdvertSignature).not.toHaveBeenCalled();
    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(1);
  });

  it('8 concurrent copies of one new advert take one cap slot and send one alert', async () => {
    const mgr = mkManager();
    verifyAdvertSignature.mockImplementation(() => new Promise(r => setTimeout(() => r(true), 5)));
    for (let i = 0; i < 8; i++) setAdvert(key(1), { verified: false, checked: false });
    await Promise.all(Array.from({ length: 8 }, () => feed(mgr)));
    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(1);
    const rate = JSON.parse(env.store.get('feed-a:newNodeAlertRate')!);
    expect(rate.sent).toBe(1);
  });

  it('ignores a duplicate advert for a known key (inserted:false)', async () => {
    setAdvert(key(1), { inserted: false });
    await feed(mkManager());
    expect(notifyNewMeshCoreNode).not.toHaveBeenCalled();
  });

  it('alerts when a nameless key later arrives named (armed)', async () => {
    const mgr = mkManager();
    setAdvert(key(1), { name: '' });
    await feed(mgr);
    expect(notifyNewMeshCoreNode).not.toHaveBeenCalled();
    setAdvert(key(1), { inserted: false, name: 'Now Named' });
    await feed(mgr);
    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(1);
    expect(notifyNewMeshCoreNode.mock.calls[0][1]).toBe('Now Named');
  });

  it('a nameless key seen while learning is not parked, so it never alerts later', async () => {
    env.earliest.set('feed-a', null);
    const mgr = mkManager();
    setAdvert(key(1), { name: '' });
    await feed(mgr);
    env.clock += LEARN_MS + 1;
    setAdvert(key(1), { inserted: false, name: 'Late' });
    await feed(mgr);
    expect(notifyNewMeshCoreNode).not.toHaveBeenCalled();
  });

  it('emits no automation event and never runs Auto Welcome', async () => {
    setAdvert(key(1));
    await feed(mkManager());
    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('the broker source inherits the same ingest path', () => {
    expect(Object.getPrototypeOf(MeshCoreMqttBrokerManager.prototype)).toBe(MeshCoreMqttManager.prototype);
    expect(Object.prototype.hasOwnProperty.call(MeshCoreMqttBrokerManager.prototype, 'ingestAdvert')).toBe(false);
  });
});
