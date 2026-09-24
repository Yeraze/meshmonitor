/**
 * Unit coverage for the transport-traffic writer (#5101 Phase 3 WP3).
 *
 * See docs/internal/dev-notes/TRANSPORT_BREAKDOWN_P3_SPEC.md §3.4 / §7 for
 * the rules this file pins: the two independently-armed timers, restore vs.
 * recovery on start(), invariant I1 (never write a bin before it closes),
 * single-flight flush, per-source error isolation, and the checkpoint's
 * crash-loss bound.
 *
 * The real `databaseService` singleton is mocked purely so importing the
 * module under test (which constructs a default `transportTrafficService`
 * singleton at module scope) has no side effects — every test constructs its
 * own `TransportTrafficService` with injected `deps`, never the singleton.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/database.js', () => ({ default: {} }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import { TransportTrafficService, type TransportTrafficServiceDeps } from './transportTrafficService.js';
import {
  TRANSPORT_SERIES_BIN_MS,
  TRANSPORT_CHECKPOINT_INTERVAL_MS,
  TRANSPORT_CHECKPOINT_SETTING_KEY,
  TRANSPORT_SERIES_TYPES,
  encodeTransportCheckpoint,
  type TransportCounts,
} from '../../utils/transportSeries.js';
import type { ISourceManager, SourceStatus } from '../sourceManagerRegistry.js';
import { logger } from '../../utils/logger.js';

const BIN = TRANSPORT_SERIES_BIN_MS;
// A wall-clock instant already aligned to a bin boundary, for deterministic tests.
const T0 = 1_700_000 * BIN;

function makeManager(overrides: Partial<{
  sourceId: string;
  sourceType: ISourceManager['sourceType'];
  connected: boolean;
  identity: { nodeNum: number; nodeId: string } | null;
}> = {}): ISourceManager {
  const sourceId = overrides.sourceId ?? 'src-a';
  const sourceType = overrides.sourceType ?? 'meshtastic_tcp';
  const connected = overrides.connected ?? true;
  const identity = overrides.identity === undefined
    ? { nodeNum: 1, nodeId: '!00000001' }
    : overrides.identity;

  return {
    sourceId,
    sourceType,
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn(
      (): SourceStatus => ({ sourceId, sourceName: sourceId, sourceType, connected }),
    ),
    getLocalNodeInfo: vi.fn(() =>
      identity ? { ...identity, longName: 'Node', shortName: 'NODE' } : null,
    ),
  } as unknown as ISourceManager;
}

interface Harness {
  service: TransportTrafficService;
  deps: TransportTrafficServiceDeps;
  managers: ISourceManager[];
  insertTelemetryAsync: ReturnType<typeof vi.fn>;
  countNodesHeardByTransport: ReturnType<typeof vi.fn>;
  getAllSources: ReturnType<typeof vi.fn>;
  getSettingForSources: ReturnType<typeof vi.fn>;
  setSourceSetting: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  managers?: ISourceManager[];
  sourceIds?: string[];
  checkpoints?: Map<string, string>;
  nodesHeard?: TransportCounts;
} = {}): Harness {
  const managers = opts.managers ?? [makeManager()];
  const sourceIds = opts.sourceIds ?? managers.map((m) => m.sourceId);
  const insertTelemetryAsync = vi.fn().mockResolvedValue(undefined);
  const countNodesHeardByTransport = vi.fn().mockResolvedValue(opts.nodesHeard ?? { rf: 0, udp: 0, mqtt: 0 });
  const getAllSources = vi.fn().mockResolvedValue(sourceIds.map((id) => ({ id, name: id, type: 'meshtastic_tcp', config: {} })));
  const getSettingForSources = vi.fn().mockResolvedValue(opts.checkpoints ?? new Map<string, string>());
  const setSourceSetting = vi.fn().mockResolvedValue(undefined);

  const deps: TransportTrafficServiceDeps = {
    getManagers: () => managers,
    db: {
      insertTelemetryAsync,
      nodes: { countNodesHeardByTransport } as any,
      settings: { getSettingForSources, setSourceSetting } as any,
      sources: { getAllSources } as any,
    },
  };

  return {
    service: new TransportTrafficService(deps),
    deps,
    managers,
    insertTelemetryAsync,
    countNodesHeardByTransport,
    getAllSources,
    getSettingForSources,
    setSourceSetting,
  };
}

/** telemetryType -> value map from the six rows of one insertTelemetryAsync-per-row call set. */
function rowsByType(insertTelemetryAsync: ReturnType<typeof vi.fn>): Map<string, number> {
  const out = new Map<string, number>();
  for (const call of insertTelemetryAsync.mock.calls) {
    const row = call[0] as { telemetryType: string; value: number };
    out.set(row.telemetryType, row.value);
  }
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('TransportTrafficService — timers', () => {
  it('the first flush lands on the boundary + 2s slack, and re-arms aligned (no drift)', async () => {
    const h = makeHarness();
    const flushSpy = vi.spyOn(h.service, 'flush');
    await h.service.start();

    // Not yet due just before the boundary + slack.
    await vi.advanceTimersByTimeAsync(BIN + 1_999);
    expect(flushSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledWith(T0 + BIN);

    // Re-armed for exactly one bin later, not drifted by the 2s slack.
    await vi.advanceTimersByTimeAsync(BIN);
    expect(flushSpy).toHaveBeenCalledTimes(2);
    expect(flushSpy).toHaveBeenLastCalledWith(T0 + 2 * BIN);
  });

  it('the checkpoint fires every 30s and writes only dirty current bins', async () => {
    const h = makeHarness();
    await h.service.start();
    h.service.recordRx('src-a', 'rf');

    await vi.advanceTimersByTimeAsync(TRANSPORT_CHECKPOINT_INTERVAL_MS);
    expect(h.setSourceSetting).toHaveBeenCalledTimes(1);
    expect(h.setSourceSetting).toHaveBeenCalledWith(
      'src-a',
      TRANSPORT_CHECKPOINT_SETTING_KEY,
      expect.any(String),
    );

    // Nothing changed since the last checkpoint: the next tick is silent.
    await vi.advanceTimersByTimeAsync(TRANSPORT_CHECKPOINT_INTERVAL_MS);
    expect(h.setSourceSetting).toHaveBeenCalledTimes(1);
  });

  it('skips a dirty bin whose identity is unknown, and logs a warning', async () => {
    const h = makeHarness({ managers: [], sourceIds: [] });
    await h.service.start();
    // No manager and no restored identity — recordRx still tracks counts.
    h.service.recordRx('src-a', 'rf');

    await vi.advanceTimersByTimeAsync(TRANSPORT_CHECKPOINT_INTERVAL_MS);
    expect(h.setSourceSetting).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('identity unknown'));
  });

  it('stays silent when idle (no dirty bins at all)', async () => {
    const h = makeHarness();
    await h.service.start();

    await vi.advanceTimersByTimeAsync(TRANSPORT_CHECKPOINT_INTERVAL_MS * 3);
    expect(h.setSourceSetting).not.toHaveBeenCalled();
  });
});

describe('TransportTrafficService — restore', () => {
  it('seeds counts + identity from a current-bin checkpoint; later recordRx adds to them; one write at the boundary', async () => {
    const checkpoint = encodeTransportCheckpoint({
      v: 1, binStartMs: T0, nodeId: '!00000001', nodeNum: 1, rf: 2, udp: 0, mqtt: 0,
    });
    const h = makeHarness({ checkpoints: new Map([['src-a', checkpoint]]) });
    await h.service.start();

    // Restoring must not itself write anything (the bin has not closed).
    expect(h.insertTelemetryAsync).not.toHaveBeenCalled();

    h.service.recordRx('src-a', 'rf');

    await vi.advanceTimersByTimeAsync(BIN + 2_000);
    const rows = rowsByType(h.insertTelemetryAsync);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.rf)).toBe(3); // 2 restored + 1 new
    // Written exactly once — six rows, not twelve.
    expect(h.insertTelemetryAsync).toHaveBeenCalledTimes(6);
  });
});

describe('TransportTrafficService — recovery', () => {
  it('writes rows at start() for a closed-bin checkpoint, using the checkpoint counts and nodeNum/window', async () => {
    const closedBinStart = T0 - BIN;
    const checkpoint = encodeTransportCheckpoint({
      v: 1, binStartMs: closedBinStart, nodeId: '!00000001', nodeNum: 1, rf: 4, udp: 1, mqtt: 0,
    });
    const h = makeHarness({
      checkpoints: new Map([['src-a', checkpoint]]),
      nodesHeard: { rf: 3, udp: 1, mqtt: 0 },
    });
    await h.service.start();

    expect(h.countNodesHeardByTransport).toHaveBeenCalledWith(
      'src-a',
      Math.floor(closedBinStart / 1000),
      Math.floor(T0 / 1000),
      1,
    );
    const rows = rowsByType(h.insertTelemetryAsync);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.rf)).toBe(4);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.udp)).toBe(1);
    expect(rows.get(TRANSPORT_SERIES_TYPES.nodesHeard.rf)).toBe(3);
  });

  it('skips a recovered bin older than 7 days', async () => {
    const ancientBinStart = T0 - 8 * 24 * 60 * 60 * 1000;
    const checkpoint = encodeTransportCheckpoint({
      v: 1, binStartMs: ancientBinStart, nodeId: '!00000001', nodeNum: 1, rf: 4, udp: 0, mqtt: 0,
    });
    const h = makeHarness({ checkpoints: new Map([['src-a', checkpoint]]) });
    await h.service.start();

    expect(h.insertTelemetryAsync).not.toHaveBeenCalled();
  });

  it('discards a future checkpoint (clock went backwards) without throwing', async () => {
    const futureBinStart = T0 + BIN;
    const checkpoint = encodeTransportCheckpoint({
      v: 1, binStartMs: futureBinStart, nodeId: '!00000001', nodeNum: 1, rf: 4, udp: 0, mqtt: 0,
    });
    const h = makeHarness({ checkpoints: new Map([['src-a', checkpoint]]) });
    await expect(h.service.start()).resolves.toBeUndefined();

    expect(h.insertTelemetryAsync).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('future'));
  });

  it('discards an invalid checkpoint payload without throwing', async () => {
    const h = makeHarness({ checkpoints: new Map([['src-a', '{not json']]) });
    await expect(h.service.start()).resolves.toBeUndefined();

    expect(h.insertTelemetryAsync).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
  });
});

describe('TransportTrafficService — flush', () => {
  it('writes a real zero when connected with zero packets', async () => {
    const h = makeHarness();
    await h.service.start();

    await h.service.flush(T0 + BIN);
    const rows = rowsByType(h.insertTelemetryAsync);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.rf)).toBe(0);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.udp)).toBe(0);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.mqtt)).toBe(0);
  });

  it('writes from the BinState identity when disconnected but counts exist', async () => {
    const checkpoint = encodeTransportCheckpoint({
      v: 1, binStartMs: T0, nodeId: '!00000001', nodeNum: 1, rf: 5, udp: 0, mqtt: 0,
    });
    const manager = makeManager({ connected: false });
    const h = makeHarness({ managers: [manager], checkpoints: new Map([['src-a', checkpoint]]) });
    await h.service.start();

    await h.service.flush(T0 + BIN);
    const rows = rowsByType(h.insertTelemetryAsync);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.rf)).toBe(5);
  });

  it('skips a source with no manager identity and no BinState identity', async () => {
    const manager = makeManager({ connected: false, identity: null });
    const h = makeHarness({ managers: [manager] });
    await h.service.start();

    await h.service.flush(T0 + BIN);
    expect(h.insertTelemetryAsync).not.toHaveBeenCalled();
  });

  it('never includes an MQTT-bridge or MeshCore manager', async () => {
    const mqtt = makeManager({ sourceId: 'src-mqtt', sourceType: 'mqtt_bridge' });
    const meshcore = makeManager({ sourceId: 'src-mc', sourceType: 'meshcore' });
    const tcp = makeManager({ sourceId: 'src-a' });
    const h = makeHarness({ managers: [mqtt, meshcore, tcp], sourceIds: ['src-a'] });
    await h.service.start();

    await h.service.flush(T0 + BIN);
    const sourceIdsWritten = new Set(h.insertTelemetryAsync.mock.calls.map((c) => c[1]));
    expect(sourceIdsWritten).toEqual(new Set(['src-a']));
  });

  it('a packet recorded after the boundary but before its flush lands in the new bin, not the closed one', async () => {
    const h = makeHarness();
    await h.service.start();
    h.service.recordRx('src-a', 'rf'); // lands in the bin starting at T0

    // Jump straight to the next boundary and record another packet — this
    // must land in the NEW current bin, not the one about to be flushed.
    vi.setSystemTime(T0 + BIN);
    h.service.recordRx('src-a', 'udp');

    await h.service.flush(T0 + BIN); // closes [T0, T0+BIN)
    let rows = rowsByType(h.insertTelemetryAsync);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.rf)).toBe(1);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.udp)).toBe(0);

    h.insertTelemetryAsync.mockClear();
    await h.service.flush(T0 + 2 * BIN); // closes [T0+BIN, T0+2BIN) — the udp packet's bin
    rows = rowsByType(h.insertTelemetryAsync);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.udp)).toBe(1);
  });

  it('a DB error on one source does not block another source\'s write', async () => {
    const a = makeManager({ sourceId: 'src-a' });
    const b = makeManager({ sourceId: 'src-b' });
    const h = makeHarness({ managers: [a, b], sourceIds: ['src-a', 'src-b'] });
    h.countNodesHeardByTransport.mockImplementation(async (sourceId: string) => {
      if (sourceId === 'src-a') throw new Error('boom');
      return { rf: 0, udp: 0, mqtt: 0 };
    });
    await h.service.start();

    await h.service.flush(T0 + BIN);
    const sourceIdsWritten = new Set(h.insertTelemetryAsync.mock.calls.map((c) => c[1]));
    expect(sourceIdsWritten.has('src-b')).toBe(true);
    expect(sourceIdsWritten.has('src-a')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('flush failed for source src-a'),
      expect.anything(),
    );
  });

  it('is single-flight: a concurrent flush call is a no-op', async () => {
    const h = makeHarness();
    await h.service.start();

    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    h.countNodesHeardByTransport.mockImplementationOnce(async () => {
      await gate;
      return { rf: 0, udp: 0, mqtt: 0 };
    });

    const first = h.service.flush(T0 + BIN);
    const second = h.service.flush(T0 + BIN); // should return immediately, doing nothing
    await second;
    expect(h.insertTelemetryAsync).not.toHaveBeenCalled(); // first still gated

    releaseFirst();
    await first;
    expect(h.insertTelemetryAsync).toHaveBeenCalledTimes(6); // exactly one flush's worth
  });
});

describe('TransportTrafficService — invariant I1 (never write the bin in progress)', () => {
  it('no telemetry insert targets the current, not-yet-closed bin', async () => {
    const h = makeHarness();
    await h.service.start();
    h.service.recordRx('src-a', 'rf');

    // Well short of the boundary — the flush timer must not have fired.
    await vi.advanceTimersByTimeAsync(BIN / 2);
    expect(h.insertTelemetryAsync).not.toHaveBeenCalled();
  });
});

describe('TransportTrafficService — stop', () => {
  it('clears both timers, checkpoints dirty bins, and never fires again', async () => {
    const h = makeHarness();
    const flushSpy = vi.spyOn(h.service, 'flush');
    await h.service.start();
    h.service.recordRx('src-a', 'rf');

    await h.service.stop();
    expect(h.setSourceSetting).toHaveBeenCalledTimes(1);

    flushSpy.mockClear();
    h.setSourceSetting.mockClear();
    await vi.advanceTimersByTimeAsync(BIN * 3);
    expect(flushSpy).not.toHaveBeenCalled();
    expect(h.setSourceSetting).not.toHaveBeenCalled();
  });

  it('resolves even when the DB throws during the final checkpoint', async () => {
    const h = makeHarness();
    await h.service.start();
    h.service.recordRx('src-a', 'rf');
    h.setSourceSetting.mockRejectedValueOnce(new Error('db is gone'));

    await expect(h.service.stop()).resolves.toBeUndefined();
  });
});

describe('TransportTrafficService — checkpoint crash-loss bound', () => {
  it('counts recorded after the last checkpoint are lost; earlier ones survive a simulated restart', async () => {
    const h = makeHarness();
    await h.service.start();

    h.service.recordRx('src-a', 'rf');
    h.service.recordRx('src-a', 'rf');
    await vi.advanceTimersByTimeAsync(TRANSPORT_CHECKPOINT_INTERVAL_MS); // checkpoint: rf=2 persisted
    const persisted = h.setSourceSetting.mock.calls[0][2] as string;

    // More traffic arrives, then the process is hard-killed before the next
    // checkpoint — these two never made it to disk.
    h.service.recordRx('src-a', 'rf');
    h.service.recordRx('src-a', 'rf');

    // "Restart": a fresh service instance sees only the persisted checkpoint.
    const h2 = makeHarness({ checkpoints: new Map([['src-a', persisted]]) });
    await h2.service.start();
    await vi.advanceTimersByTimeAsync(BIN + 2_000);

    const rows = rowsByType(h2.insertTelemetryAsync);
    expect(rows.get(TRANSPORT_SERIES_TYPES.packetsRx.rf)).toBe(2); // not 4
  });
});
