/** Per-source isolation of the MQTT clock-agreement buffer and rows (#6341 P5). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ingestAdvertFrame = vi.hoisted(() => vi.fn());
const rows = vi.hoisted(() => [] as Array<{ nodeId: string; value: number; timestamp: number; sourceId?: string }>);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: { getNodeByPublicKeyAndSource: vi.fn(), upsertNode: vi.fn(), insertPacket: vi.fn() },
    sources: { getSource: vi.fn().mockResolvedValue({ name: 'Feed' }) },
    getSettingAsync: vi.fn().mockResolvedValue('0'),
    telemetry: {
      getTelemetryByNode: vi.fn(async (nodeId: string, _l: number, _s: unknown, _b: unknown, _o: unknown, _t: unknown, sourceId: string) =>
        rows.filter((r) => r.nodeId === nodeId && r.sourceId === sourceId)),
      insertTelemetry: vi.fn(async (r: { nodeId: string; value: number; timestamp: number }, sourceId: string) => {
        rows.push({ ...r, sourceId });
        return true;
      }),
    },
  },
}));
vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), emitNodeClockOffset: vi.fn() },
}));
vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));
vi.mock('./services/meshcoreFrameIngest.js', async (orig) => ({
  ...(await orig<typeof import('./services/meshcoreFrameIngest.js')>()),
  ingestAdvertFrame,
  verifyAdvertSignature: vi.fn().mockResolvedValue(true),
}));

import { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import { resetClockOffsetThrottleForTests } from './services/meshcoreDeviceHealth.js';

const NODE = 'ab'.repeat(32);
const obs = (n: number) => n.toString(16).padStart(2, '0').repeat(32).toUpperCase();
const T0 = 1_800_000_000_000;
const SENDER = T0 / 1000 - 3600;
const mk = (id: string) => new MeshCoreMqttManager(id, id, { brokerUrl: 'wss://b.example', region: 'MCO' });

async function feed(m: MeshCoreMqttManager, origin: number) {
  ingestAdvertFrame.mockResolvedValueOnce({
    advert: { publicKey: NODE, timestamp: SENDER }, inserted: false, signatureVerified: false, signatureChecked: false,
  });
  await (m as unknown as { ingestAdvert(d: unknown): Promise<void> }).ingestAdvert({
    event: { raw_hex: 'aa' }, originId: obs(origin), timestamp: new Date(Date.now()).toISOString(),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  rows.length = 0;
  ingestAdvertFrame.mockReset();
  resetClockOffsetThrottleForTests();
});
afterEach(() => vi.useRealTimers());

describe('MQTT clock samples per source (#6341 P5)', () => {
  it('observers on different sources never pair up', async () => {
    const a = mk('feed-a');
    const b = mk('feed-b');
    await feed(a, 1);
    await feed(b, 2);
    expect(rows).toHaveLength(0);
  });

  it('the same node on two sources keeps separate rows', async () => {
    const a = mk('feed-a');
    const b = mk('feed-b');
    await feed(a, 1); await feed(a, 2);
    await feed(b, 3); await feed(b, 4);
    expect(rows.map((r) => r.sourceId).sort()).toEqual(['feed-a', 'feed-b']);
  });

  it('a throttled source does not hold the other back', async () => {
    const a = mk('feed-a');
    const b = mk('feed-b');
    await feed(a, 1); await feed(a, 2);
    await feed(b, 3); await feed(b, 4);
    expect(rows).toHaveLength(2);
  });
});
