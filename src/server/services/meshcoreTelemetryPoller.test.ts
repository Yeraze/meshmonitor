/**
 * Tests for MeshCoreTelemetryPoller.
 *
 * Verifies:
 *   - Connected companions get sampled; disconnected/non-companion are skipped.
 *   - All six bridge-derived metrics (battery, queue, RSSI, drift, etc.) are
 *     emitted as `mc_*` telemetry rows with the source's id stamped on them.
 *   - The second poll computes duty-cycle and rate fields from cumulative
 *     counters, and the snapshot reflects the latest values.
 *   - Failures in one source do not abort the poll for other sources.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MeshCoreTelemetryPoller,
  nodeNumFromPubkey,
  resolvePollIntervalMs,
  DEFAULT_POLL_INTERVAL_MS,
  MC_TELEMETRY_PREFIX,
} from './meshcoreTelemetryPoller.js';
import type { PollerDatabase } from './meshcoreTelemetryPoller.js';
import type {
  MeshCoreManager,
  MeshCoreStatsCore,
  MeshCoreStatsRadio,
  MeshCoreStatsPackets,
  MeshCoreDeviceInfo,
} from '../meshcoreManager.js';
import type { MeshCoreManagerRegistry } from '../meshcoreRegistry.js';

// ============================================================================
// Test doubles
// ============================================================================

interface FakeManagerOpts {
  sourceId: string;
  connected?: boolean;
  publicKey?: string;
  core?: MeshCoreStatsCore | null;
  radio?: MeshCoreStatsRadio | null;
  packets?: MeshCoreStatsPackets | null;
  deviceTime?: number | null;
  deviceInfo?: MeshCoreDeviceInfo | null;
  /** When true, every getter rejects to exercise the per-source try/catch. */
  throws?: boolean;
}

function makeManager(opts: FakeManagerOpts): MeshCoreManager {
  const appliedDeviceInfo: MeshCoreDeviceInfo[] = [];
  const localNode = opts.publicKey
    ? { publicKey: opts.publicKey, name: 'test', advType: 1 as const }
    : null;

  const reject = () => Promise.reject(new Error('bridge boom'));

  const m: any = {
    sourceId: opts.sourceId,
    isConnected: () => opts.connected ?? true,
    getLocalNode: () => localNode,
    getStatsCore: () => (opts.throws ? reject() : Promise.resolve(opts.core ?? null)),
    getStatsRadio: () => (opts.throws ? reject() : Promise.resolve(opts.radio ?? null)),
    getStatsPackets: () => (opts.throws ? reject() : Promise.resolve(opts.packets ?? null)),
    getDeviceTime: () => (opts.throws ? reject() : Promise.resolve(opts.deviceTime ?? null)),
    deviceQuery: () => (opts.throws ? reject() : Promise.resolve(opts.deviceInfo ?? null)),
    applyDeviceInfo: (info: MeshCoreDeviceInfo) => {
      appliedDeviceInfo.push(info);
    },
    appliedDeviceInfo,
  };
  return m as MeshCoreManager;
}

function makeRegistry(...managers: MeshCoreManager[]): MeshCoreManagerRegistry {
  return { list: () => managers } as unknown as MeshCoreManagerRegistry;
}

function makeDatabase(): { db: PollerDatabase; batches: { rows: any[]; sourceId?: string }[] } {
  const batches: { rows: any[]; sourceId?: string }[] = [];
  const db: PollerDatabase = {
    telemetry: {
      insertTelemetryBatch: async (rows, sourceId) => {
        batches.push({ rows: [...rows], sourceId });
        return rows.length;
      },
    },
  };
  return { db, batches };
}

const FULL_PUBKEY = 'a'.repeat(64);

const FULL_CORE: MeshCoreStatsCore = { batteryMv: 4100, uptimeSecs: 3600, errors: 0, queueLen: 2 };
const FULL_RADIO: MeshCoreStatsRadio = { noiseFloor: -123, lastRssi: -88, lastSnr: 7.5, txAirSecs: 100, rxAirSecs: 250 };
const FULL_PACKETS: MeshCoreStatsPackets = { recv: 500, sent: 120, floodTx: 80, directTx: 40, floodRx: 300, directRx: 200, recvErrors: 5 };
const FULL_DEVICE: MeshCoreDeviceInfo = { firmwareVer: 9, firmwareBuild: '2024-11-01', model: 'Heltec V3', ver: '1.2.3' };

// ============================================================================
// Tests
// ============================================================================

describe('resolvePollIntervalMs', () => {
  it('returns the default when env is unset', () => {
    expect(resolvePollIntervalMs(undefined)).toBe(DEFAULT_POLL_INTERVAL_MS);
  });
  it('returns the default for unparseable input', () => {
    expect(resolvePollIntervalMs('not-a-number')).toBe(DEFAULT_POLL_INTERVAL_MS);
  });
  it('returns the default for non-positive input', () => {
    expect(resolvePollIntervalMs('0')).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(resolvePollIntervalMs('-1000')).toBe(DEFAULT_POLL_INTERVAL_MS);
  });
  it('floors values below the 10s minimum', () => {
    expect(resolvePollIntervalMs('1000')).toBe(10_000);
  });
  it('passes through reasonable values', () => {
    expect(resolvePollIntervalMs('60000')).toBe(60_000);
  });
});

describe('nodeNumFromPubkey', () => {
  it('returns 0 for empty input', () => {
    expect(nodeNumFromPubkey('')).toBe(0);
  });
  it('strips an optional 0x prefix and parses the low 4 bytes', () => {
    expect(nodeNumFromPubkey('0x' + 'f'.repeat(56) + 'deadbeef')).toBe(0xdeadbeef & 0x7fffffff);
  });
  it('clamps to a 31-bit non-negative integer', () => {
    const n = nodeNumFromPubkey('0'.repeat(56) + 'ffffffff');
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBe(0x7fffffff);
  });
});

describe('MeshCoreTelemetryPoller.pollOnce', () => {
  let now = 1700_000_000_000;
  beforeEach(() => {
    now = 1700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  it('emits all expected metrics for a healthy companion', async () => {
    const manager = makeManager({
      sourceId: 'src-a',
      publicKey: FULL_PUBKEY,
      core: FULL_CORE,
      radio: FULL_RADIO,
      packets: FULL_PACKETS,
      // Device time in seconds; server time is now/1000 → drift = 0.
      deviceTime: Math.floor(now / 1000),
      deviceInfo: FULL_DEVICE,
    });
    const { db, batches } = makeDatabase();
    const poller = new MeshCoreTelemetryPoller({
      registry: makeRegistry(manager),
      database: db,
      intervalMs: 60_000,
    });

    await poller.pollOnce();

    expect(batches).toHaveLength(1);
    expect(batches[0].sourceId).toBe('src-a');

    const types = batches[0].rows.map((r) => r.telemetryType).sort();
    // Spot-check every category lands at least one mc_ row.
    for (const expected of [
      `${MC_TELEMETRY_PREFIX}battery_mv`,
      `${MC_TELEMETRY_PREFIX}battery_volts`,
      `${MC_TELEMETRY_PREFIX}uptime_secs`,
      `${MC_TELEMETRY_PREFIX}queue_len`,
      `${MC_TELEMETRY_PREFIX}noise_floor`,
      `${MC_TELEMETRY_PREFIX}last_rssi`,
      `${MC_TELEMETRY_PREFIX}last_snr`,
      `${MC_TELEMETRY_PREFIX}tx_air_secs`,
      `${MC_TELEMETRY_PREFIX}rx_air_secs`,
      `${MC_TELEMETRY_PREFIX}pkt_recv`,
      `${MC_TELEMETRY_PREFIX}pkt_sent`,
      `${MC_TELEMETRY_PREFIX}pkt_recv_errors`,
      `${MC_TELEMETRY_PREFIX}rtc_drift_secs`,
      `${MC_TELEMETRY_PREFIX}firmware_ver`,
    ]) {
      expect(types).toContain(expected);
    }

    // Every row should be stamped with the same timestamp and the local node's pubkey.
    for (const row of batches[0].rows) {
      expect(row.timestamp).toBe(now);
      expect(row.nodeId).toBe(FULL_PUBKEY);
      expect(row.nodeNum).toBe(nodeNumFromPubkey(FULL_PUBKEY));
    }

    // The poll should have stamped DeviceInfo onto the manager via applyDeviceInfo.
    expect((manager as any).appliedDeviceInfo).toEqual([FULL_DEVICE]);

    // First poll has no prior sample — no duty / rate rows yet.
    expect(types).not.toContain(`${MC_TELEMETRY_PREFIX}tx_duty_pct`);
    expect(types).not.toContain(`${MC_TELEMETRY_PREFIX}pkt_recv_rate`);

    // Snapshot is cached for the Info endpoint.
    const snap = poller.getLastSnapshot('src-a');
    expect(snap).toBeDefined();
    expect(snap!.batteryMv).toBe(4100);
    expect(snap!.lastRssi).toBe(-88);
    expect(snap!.rtcDriftSecs).toBe(0);
    expect(snap!.deviceInfo?.model).toBe('Heltec V3');
  });

  it('computes duty-cycle and packet rates after the second sample', async () => {
    const manager: any = makeManager({
      sourceId: 'src-rate',
      publicKey: FULL_PUBKEY,
      core: FULL_CORE,
      radio: { ...FULL_RADIO, txAirSecs: 100, rxAirSecs: 250 },
      packets: { ...FULL_PACKETS, recv: 500, sent: 120 },
      deviceTime: Math.floor(now / 1000),
    });

    const { db, batches } = makeDatabase();
    const poller = new MeshCoreTelemetryPoller({
      registry: makeRegistry(manager),
      database: db,
    });

    await poller.pollOnce(); // seed prev sample

    // Second poll: advance clock 60s, bump counters.
    now += 60_000;
    manager.getStatsRadio = () => Promise.resolve({ ...FULL_RADIO, txAirSecs: 106, rxAirSecs: 280 });
    manager.getStatsPackets = () =>
      Promise.resolve({ ...FULL_PACKETS, recv: 530, sent: 126 });
    manager.getDeviceTime = () => Promise.resolve(Math.floor(now / 1000));

    await poller.pollOnce();

    expect(batches).toHaveLength(2);
    const second = batches[1].rows;
    const find = (type: string) => second.find((r) => r.telemetryType === type);

    // tx air-time delta: (106 - 100) / 60 = 10% duty.
    expect(find(`${MC_TELEMETRY_PREFIX}tx_duty_pct`)?.value).toBeCloseTo(10, 2);
    // rx air-time delta: (280 - 250) / 60 = 50% duty.
    expect(find(`${MC_TELEMETRY_PREFIX}rx_duty_pct`)?.value).toBeCloseTo(50, 2);
    // Packet rates expressed per minute → recv +30 / 60s * 60s = 30/min.
    expect(find(`${MC_TELEMETRY_PREFIX}pkt_recv_rate`)?.value).toBeCloseTo(30, 2);
    expect(find(`${MC_TELEMETRY_PREFIX}pkt_sent_rate`)?.value).toBeCloseTo(6, 2);

    const snap = poller.getLastSnapshot('src-rate');
    expect(snap!.txDutyPct).toBeCloseTo(10, 2);
    expect(snap!.packetsRecvRatePerMin).toBeCloseTo(30, 2);
  });

  it('skips counter-reset deltas (negative delta) instead of emitting bogus negatives', async () => {
    const manager: any = makeManager({
      sourceId: 'src-reset',
      publicKey: FULL_PUBKEY,
      radio: { txAirSecs: 100, rxAirSecs: 200 },
      packets: { recv: 1000, sent: 500 },
    });
    const { db, batches } = makeDatabase();
    const poller = new MeshCoreTelemetryPoller({ registry: makeRegistry(manager), database: db });

    await poller.pollOnce();

    now += 60_000;
    // Counter reset — values dropped below the prior sample.
    manager.getStatsRadio = () => Promise.resolve({ txAirSecs: 5, rxAirSecs: 10 });
    manager.getStatsPackets = () => Promise.resolve({ recv: 0, sent: 0 });

    await poller.pollOnce();

    const second = batches[1].rows.map((r) => r.telemetryType);
    expect(second).not.toContain(`${MC_TELEMETRY_PREFIX}tx_duty_pct`);
    expect(second).not.toContain(`${MC_TELEMETRY_PREFIX}rx_duty_pct`);
    expect(second).not.toContain(`${MC_TELEMETRY_PREFIX}pkt_recv_rate`);
    expect(second).not.toContain(`${MC_TELEMETRY_PREFIX}pkt_sent_rate`);
  });

  it('skips disconnected managers', async () => {
    const offline = makeManager({
      sourceId: 'src-off',
      connected: false,
      publicKey: FULL_PUBKEY,
      core: FULL_CORE,
    });
    const { db, batches } = makeDatabase();
    const poller = new MeshCoreTelemetryPoller({ registry: makeRegistry(offline), database: db });

    await poller.pollOnce();

    expect(batches).toHaveLength(0);
  });

  it('skips managers whose localNode has not been resolved', async () => {
    const noLocal = makeManager({ sourceId: 'src-pre', publicKey: undefined, core: FULL_CORE });
    const { db, batches } = makeDatabase();
    const poller = new MeshCoreTelemetryPoller({ registry: makeRegistry(noLocal), database: db });

    await poller.pollOnce();

    expect(batches).toHaveLength(0);
  });

  it('does not abort the loop when one manager throws', async () => {
    const broken = makeManager({ sourceId: 'broken', publicKey: FULL_PUBKEY, throws: true });
    const healthy = makeManager({
      sourceId: 'healthy',
      publicKey: 'b'.repeat(64),
      core: FULL_CORE,
    });
    const { db, batches } = makeDatabase();
    const poller = new MeshCoreTelemetryPoller({
      registry: makeRegistry(broken, healthy),
      database: db,
    });

    await poller.pollOnce();

    // The healthy manager still emitted its sample.
    expect(batches).toHaveLength(1);
    expect(batches[0].sourceId).toBe('healthy');
  });

  it('does not insert when no metrics are available', async () => {
    const empty = makeManager({
      sourceId: 'src-empty',
      publicKey: FULL_PUBKEY,
      // All getters return null — repeater-style or pre-pop state.
      core: null,
      radio: null,
      packets: null,
      deviceTime: null,
      deviceInfo: null,
    });
    const { db, batches } = makeDatabase();
    const poller = new MeshCoreTelemetryPoller({ registry: makeRegistry(empty), database: db });

    await poller.pollOnce();

    expect(batches).toHaveLength(0);
  });
});
