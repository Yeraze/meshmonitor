/**
 * MQTT feed clock samples (#6341 P5, D6). Ingest and signature check are
 * stubbed; the agreement buffer, throttle and recordClockSample are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ingestAdvertFrame = vi.hoisted(() => vi.fn());
const verifyAdvertSignature = vi.hoisted(() => vi.fn());
const rows = vi.hoisted(() => [] as Array<{ nodeId: string; value: number; timestamp: number; sourceId?: string }>);
const emitNodeClockOffset = vi.hoisted(() => vi.fn());

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
  dataEventEmitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), emitNodeClockOffset },
}));
vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));
vi.mock('./services/meshcoreFrameIngest.js', async (orig) => ({
  ...(await orig<typeof import('./services/meshcoreFrameIngest.js')>()),
  ingestAdvertFrame,
  verifyAdvertSignature,
}));

import { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import { MeshCoreMqttBrokerManager } from './meshcoreMqttBrokerManager.js';
import { resetClockOffsetThrottleForTests } from './services/meshcoreDeviceHealth.js';

const NODE = 'ab'.repeat(32);
const obs = (n: number) => n.toString(16).padStart(2, '0').repeat(32).toUpperCase();
const T0 = 1_800_000_000_000;

function mk(id = 'feed-a') {
  return new MeshCoreMqttManager(id, 'Feed', { brokerUrl: 'wss://b.example', region: 'MCO' });
}

function advert(o: { verified?: boolean; checked?: boolean; senderSec: number }) {
  ingestAdvertFrame.mockResolvedValueOnce({
    advert: { publicKey: NODE, timestamp: o.senderSec },
    inserted: false,
    signatureVerified: o.verified ?? false,
    signatureChecked: o.checked ?? false,
  });
}

const feed = (m: unknown, origin: number) =>
  (m as { ingestAdvert(d: unknown): Promise<void> }).ingestAdvert({
    event: { raw_hex: 'aa' },
    originId: obs(origin),
    timestamp: new Date(Date.now()).toISOString(),
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  rows.length = 0;
  ingestAdvertFrame.mockReset();
  verifyAdvertSignature.mockReset().mockResolvedValue(true);
  emitNodeClockOffset.mockClear();
  resetClockOffsetThrottleForTests();
});
afterEach(() => vi.useRealTimers());

describe('MQTT clock samples (#6341 P5)', () => {
  it('one observer stores nothing', async () => {
    const m = mk();
    advert({ senderSec: T0 / 1000 - 3600 });
    await feed(m, 1);
    expect(rows).toHaveLength(0);
  });

  it('an advert whose signature fails stores nothing', async () => {
    verifyAdvertSignature.mockResolvedValue(false);
    const m = mk();
    for (const o of [1, 2]) { advert({ senderSec: T0 / 1000 - 3600 }); await feed(m, o); }
    expect(rows).toHaveLength(0);
    expect(emitNodeClockOffset).not.toHaveBeenCalled();
  });

  it('verifies once for three observers and stores one row that rebuilds senderSec', async () => {
    const m = mk();
    const sender = T0 / 1000 - 3600;
    for (const o of [1, 2, 3]) { advert({ senderSec: sender }); await feed(m, o); }
    expect(verifyAdvertSignature).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(3600);
    expect(rows[0].timestamp / 1000 - rows[0].value).toBe(sender);
    expect(emitNodeClockOffset).toHaveBeenCalledTimes(1);
  });

  it('skips the verify when the ingest already checked the signature', async () => {
    const m = mk();
    for (const o of [1, 2]) { advert({ senderSec: T0 / 1000 - 3600, verified: true, checked: true }); await feed(m, o); }
    expect(verifyAdvertSignature).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('two adverts an hour apart each confirmed by two observers store two rows', async () => {
    const m = mk();
    for (const o of [1, 2]) { advert({ senderSec: T0 / 1000 - 3600 }); await feed(m, o); }
    vi.setSystemTime(T0 + 3600_000 + 1000);
    for (const o of [1, 2]) { advert({ senderSec: T0 / 1000 + 1 - 3600 + 3600 }); await feed(m, o); }
    expect(rows).toHaveLength(2);
    expect(emitNodeClockOffset).toHaveBeenCalledTimes(2);
  });

  it('the broker subclass stores too', async () => {
    const m = new MeshCoreMqttBrokerManager('broker-a', 'Broker', {} as never);
    for (const o of [1, 2]) { advert({ senderSec: T0 / 1000 - 3600 }); await feed(m, o); }
    expect(rows).toHaveLength(1);
  });
});
