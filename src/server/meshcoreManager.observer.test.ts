/**
 * MeshCore Analyzer Observer — manager lifecycle integration (#4457 Phase 2,
 * WP5). Covers startObserver()/stopObserver()/getObserverStatus(), the four
 * lifecycle call sites' effect on the bound 'ota_packet' listener, the D-11
 * "ungated" invariant (the observer receives packets regardless of the
 * opt-in packet-monitor setting), and the getStatus() conditional spread.
 *
 * `MeshCoreObserverPublisher` itself is mocked — its own behaviour (mint,
 * connect, publish, renewal, ...) is covered by
 * meshcoreObserverPublisher.test.ts. This file only asserts the manager
 * constructs/destroys/wires it correctly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const isEnabled = vi.fn();
const logPacket = vi.fn().mockResolvedValue(undefined);
const emitMeshCoreOtaPacket = vi.fn();

vi.mock('../services/database.js', () => ({
  default: { meshcore: {} },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreOtaPacket: (...args: unknown[]) => emitMeshCoreOtaPacket(...args),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreStatusUpdated: vi.fn(),
    emitMeshCoreLocalNodeUpdated: vi.fn(),
  },
}));

vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: {
    isEnabled: (...args: unknown[]) => isEnabled(...args),
    logPacket: (...args: unknown[]) => logPacket(...args),
  },
}));

// Fake MeshCoreObserverPublisher. Tracks every constructed instance on a
// static array so tests can inspect start()/stop()/handleOtaPacket() calls.
// `nextStartError` lets one test force the next-constructed instance's
// start() to reject, to exercise startObserver()'s catch/cleanup path.
vi.mock('./services/meshcoreObserverPublisher.js', () => {
  class MeshCoreObserverPublisher {
    static instances: MeshCoreObserverPublisher[] = [];
    static nextStartError: Error | null = null;
    options: unknown;
    start: ReturnType<typeof vi.fn>;
    stop = vi.fn().mockResolvedValue(undefined);
    handleOtaPacket = vi.fn();
    getStatus = vi.fn().mockReturnValue({
      configured: true,
      keyStored: true,
      connected: true,
      publishes: 0,
      dropped: 0,
      lastPublishAt: null,
      lastError: null,
      tokenExpiresAt: null,
    });
    isRunning = vi.fn().mockReturnValue(true);
    constructor(options: unknown) {
      this.options = options;
      const err = MeshCoreObserverPublisher.nextStartError;
      MeshCoreObserverPublisher.nextStartError = null;
      this.start = err ? vi.fn().mockRejectedValue(err) : vi.fn().mockResolvedValue(undefined);
      MeshCoreObserverPublisher.instances.push(this);
    }
  }
  return { MeshCoreObserverPublisher };
});

import { MeshCoreManager } from './meshcoreManager.js';
import { MeshCoreObserverPublisher } from './services/meshcoreObserverPublisher.js';

type FakeInstance = {
  options: unknown;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  handleOtaPacket: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
};
type FakePublisherCtor = typeof MeshCoreObserverPublisher & {
  instances: FakeInstance[];
  nextStartError: Error | null;
};
const FakePublisher = MeshCoreObserverPublisher as unknown as FakePublisherCtor;

const EXPECTED_STATUS = {
  configured: true,
  keyStored: true,
  connected: true,
  publishes: 0,
  dropped: 0,
  lastPublishAt: null,
  lastError: null,
  tokenExpiresAt: null,
};

const COMPLETE_OBSERVER_CONFIG = {
  enabled: true,
  brokerUrl: 'ws://localhost:8883',
  iataCode: 'test',
  tokenAudience: 'aud',
};

const SAMPLE_OTA_EVENT = {
  payload_type: 0x02,
  payload_type_string: 'TXT_MSG',
  route_type: 0x01,
  route_type_string: 'FLOOD',
  path_len_raw: 0x02,
  hop_count: 2,
  path_hops: ['a3', '7f'],
  snr: 6.25,
  rssi: -42,
  payload_size: 24,
  raw_hex: 'deadbeef',
};

function dispatchOtaPacket(m: MeshCoreManager, data: Record<string, unknown>): void {
  // @ts-expect-error - exercising private method, same idiom as
  // meshcoreManager.otaPacket.test.ts.
  m.handleBridgeEvent({ event_type: 'ota_packet', data });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MeshCoreManager — Analyzer Observer lifecycle (#4457 Phase 2)', () => {
  beforeEach(() => {
    FakePublisher.instances.length = 0;
    FakePublisher.nextStartError = null;
    isEnabled.mockReset().mockResolvedValue(false);
    logPacket.mockClear();
    emitMeshCoreOtaPacket.mockClear();
  });

  describe('construction gating', () => {
    it('does not construct a publisher when observer config is absent', async () => {
      const m = new MeshCoreManager('src-a');
      (m as any).config = {};
      (m as any).nativeBackend = {};

      await (m as any).startObserver();

      expect(FakePublisher.instances).toHaveLength(0);
      expect(m.getStatus()).not.toHaveProperty('observer');
    });

    it('does not construct a publisher when observer.enabled is false', async () => {
      const m = new MeshCoreManager('src-b');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG, enabled: false } };
      (m as any).nativeBackend = {};

      await (m as any).startObserver();

      expect(FakePublisher.instances).toHaveLength(0);
      expect(m.getStatus()).not.toHaveProperty('observer');
    });

    it('does not construct a publisher for an incomplete observer block (no `enabled`)', async () => {
      const m = new MeshCoreManager('src-c');
      (m as any).config = { observer: {} };
      (m as any).nativeBackend = {};

      await (m as any).startObserver();

      expect(FakePublisher.instances).toHaveLength(0);
      expect(m.getStatus()).not.toHaveProperty('observer');
    });

    it('does not construct a publisher without a native backend (repeater/serial)', async () => {
      const m = new MeshCoreManager('src-d');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = null; // repeater/serial never emits ota_packet

      await (m as any).startObserver();

      expect(FakePublisher.instances).toHaveLength(0);
      expect(m.getStatus()).not.toHaveProperty('observer');
    });

    it('constructs exactly one publisher for a Companion source with a complete, enabled config', async () => {
      const m = new MeshCoreManager('src-e');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = {};

      await (m as any).startObserver();

      expect(FakePublisher.instances).toHaveLength(1);
      expect(FakePublisher.instances[0].start).toHaveBeenCalledTimes(1);
    });

    it('wires a stats seam that merges getStatsCore() and getStatsRadio() (#4556)', async () => {
      const m = new MeshCoreManager('src-e2');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = {};
      const getStatsCore = vi.fn().mockResolvedValue({ batteryMv: 4021, uptimeSecs: 3600 });
      const getStatsRadio = vi.fn().mockResolvedValue({ noiseFloor: -95, lastRssi: -70 });
      (m as any).getStatsCore = getStatsCore;
      (m as any).getStatsRadio = getStatsRadio;

      await (m as any).startObserver();

      const { stats } = FakePublisher.instances[0].options as { stats: () => Promise<unknown> };
      await expect(stats()).resolves.toEqual({
        batteryMv: 4021,
        uptimeSecs: 3600,
        noiseFloor: -95,
        lastRssi: -70,
      });
      expect(getStatsCore).toHaveBeenCalledTimes(1);
      expect(getStatsRadio).toHaveBeenCalledTimes(1);
    });

    it('stats seam resolves null when the device answers neither stats call (#4556)', async () => {
      const m = new MeshCoreManager('src-e3');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = {};
      // Both getters swallow their own errors and return null — that is what a
      // companion that didn't answer looks like from here.
      (m as any).getStatsCore = vi.fn().mockResolvedValue(null);
      (m as any).getStatsRadio = vi.fn().mockResolvedValue(null);

      await (m as any).startObserver();

      const { stats } = FakePublisher.instances[0].options as { stats: () => Promise<unknown> };
      await expect(stats()).resolves.toBeNull();
    });

    it('is idempotent — calling startObserver() twice constructs only one publisher', async () => {
      const m = new MeshCoreManager('src-f');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = {};

      await (m as any).startObserver();
      await (m as any).startObserver();

      expect(FakePublisher.instances).toHaveLength(1);
    });
  });

  describe('ota_packet wiring', () => {
    it('reaches publisher.handleOtaPacket via the manager ota_packet event', async () => {
      const m = new MeshCoreManager('src-g');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = {};
      await (m as any).startObserver();

      dispatchOtaPacket(m, { ...SAMPLE_OTA_EVENT });
      await flush();

      const publisher = FakePublisher.instances[0];
      expect(publisher.handleOtaPacket).toHaveBeenCalledTimes(1);
      expect(publisher.handleOtaPacket).toHaveBeenCalledWith(
        expect.objectContaining({ snr: 6.25, rssi: -42, raw_hex: 'deadbeef' }),
      );
    });

    it('D-11: the observer still receives the packet when the packet-monitor capture setting is disabled', async () => {
      isEnabled.mockResolvedValue(false);
      const m = new MeshCoreManager('src-h');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = {};
      await (m as any).startObserver();

      dispatchOtaPacket(m, { ...SAMPLE_OTA_EVENT });
      await flush();

      // Capture is off, so the packet-monitor persistence path is a no-op...
      expect(logPacket).not.toHaveBeenCalled();
      // ...but the observer — a second, unconditional consumer of the same
      // 'ota_packet' event (same posture as the Virtual Node bridge, #3963) —
      // still receives it.
      const publisher = FakePublisher.instances[0];
      expect(publisher.handleOtaPacket).toHaveBeenCalledTimes(1);
    });

    it('does not reach the publisher when no observer is running', async () => {
      const m = new MeshCoreManager('src-i');
      // No config.observer at all — startObserver() never called/never constructs.
      dispatchOtaPacket(m, { ...SAMPLE_OTA_EVENT });
      await flush();

      expect(FakePublisher.instances).toHaveLength(0);
    });
  });

  describe('listener-leak guard', () => {
    it('leaves listenerCount("ota_packet") at its baseline after start -> stop -> start', async () => {
      const m = new MeshCoreManager('src-j');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = {};
      const baseline = m.listenerCount('ota_packet');

      await (m as any).startObserver();
      expect(m.listenerCount('ota_packet')).toBe(baseline + 1);

      await (m as any).stopObserver();
      expect(m.listenerCount('ota_packet')).toBe(baseline);

      await (m as any).startObserver();
      expect(m.listenerCount('ota_packet')).toBe(baseline + 1);
    });

    it('removes the listener and nulls the field when start() throws', async () => {
      const m = new MeshCoreManager('src-k');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = {};
      const baseline = m.listenerCount('ota_packet');
      FakePublisher.nextStartError = new Error('boom');

      await (m as any).startObserver();

      expect(m.listenerCount('ota_packet')).toBe(baseline);
      expect((m as any).observerPublisher).toBeNull();
      expect(FakePublisher.instances).toHaveLength(1);
      expect(FakePublisher.instances[0].start).toHaveBeenCalledTimes(1);
    });
  });

  describe('disconnect() integration', () => {
    it('calls publisher.stop() during disconnect()', async () => {
      const m = new MeshCoreManager('src-l');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = { disconnect: vi.fn().mockResolvedValue(undefined) };
      await (m as any).startObserver();
      const publisher = FakePublisher.instances[0];

      await m.disconnect();

      expect(publisher.stop).toHaveBeenCalledTimes(1);
      expect((m as any).observerPublisher).toBeNull();
    });
  });

  describe('getStatus()', () => {
    it('embeds the observer sub-object when the publisher is running', async () => {
      const m = new MeshCoreManager('src-m');
      (m as any).config = { observer: { ...COMPLETE_OBSERVER_CONFIG } };
      (m as any).nativeBackend = {};
      await (m as any).startObserver();

      const status = m.getStatus('My Source');

      expect(status.observer).toEqual(EXPECTED_STATUS);
      expect(status.sourceId).toBe('src-m');
      expect(status.sourceName).toBe('My Source');
    });

    it('omits the observer key entirely for a source with no observer (byte-identical JSON)', () => {
      const m = new MeshCoreManager('src-n');
      const status = m.getStatus('Plain Source');
      expect(status).not.toHaveProperty('observer');
      expect(JSON.stringify(status)).toBe(
        JSON.stringify({
          sourceId: 'src-n',
          sourceName: 'Plain Source',
          sourceType: 'meshcore',
          connected: false,
        }),
      );
    });
  });
});
