/**
 * Regression test for issue #4809 — NodeDB config-sync re-inserting remote
 * nodes' position/telemetry as duplicate history.
 *
 * On every config sync the node dumps its whole NodeDB as FromRadio.node_info
 * records, each embedding that node's last-known position and device_metrics.
 * processNodeInfoProtobuf used to write those as telemetry-history rows for
 * EVERY node (with a null packetId that bypasses dedup), so each resync
 * re-inserted the entire database as fresh graph points — badly amplified by
 * Meshtastic 2.8's larger warm NodeDB.
 *
 * The fix records NodeInfo-embedded position/device-metric history for the
 * LOCAL node only (its telemetry never arrives as a live POSITION_APP/
 * TELEMETRY_APP packet over the PhoneAPI). Remote nodes' history comes from
 * those live, packetId-deduped packets instead. These tests drive the REAL
 * processNodeInfoProtobuf and assert on the telemetry-batch it emits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const insertTelemetryBatch = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    settings: {
      getSettingForSource: vi.fn().mockResolvedValue(null),
      getSetting: vi.fn().mockResolvedValue(null),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    ignoredNodes: { isIgnoredCached: vi.fn().mockReturnValue(false) },
    telemetry: {
      insertTelemetry: vi.fn(),
      insertTelemetryBatch: (...args: unknown[]) => insertTelemetryBatch(...args),
    },
    upsertNodeAsync: vi.fn().mockResolvedValue(undefined),
    getLatestTelemetryForTypeAsync: vi.fn().mockResolvedValue(null),
    updateNodeMobilityAsync: vi.fn().mockResolvedValue(null),
    clearKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    logKeyRepairAttemptAsync: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const LOCAL = 0x0a0a0a0a;
const REMOTE = 0x22222222;

// A valid fix with a stable payload time, plus device metrics.
const position = { latitudeI: 407_000_000, longitudeI: -740_000_000, time: 1_600_000_100, altitude: 10 };
const deviceMetrics = { batteryLevel: 80, voltage: 4.0 };

function nodeInfo(num: number) {
  return {
    num,
    user: { id: `!${num.toString(16).padStart(8, '0')}`, longName: 'N', shortName: 'N' },
    position,
    deviceMetrics,
    // deliberately NO snr — snr_remote has its own throttle and would otherwise
    // add a row for every node, muddying the position/device-metric assertion.
  };
}

describe('MeshtasticManager — NodeDB history gate (#4809)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    manager.localNodeInfo = { nodeNum: LOCAL };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT write position/device-metric history for a REMOTE node', async () => {
    await manager.processNodeInfoProtobuf(nodeInfo(REMOTE));
    // With no snr row, the batch would be empty, so it is never flushed.
    expect(insertTelemetryBatch).not.toHaveBeenCalled();
  });

  it('DOES write position + device-metric history for the LOCAL node', async () => {
    await manager.processNodeInfoProtobuf(nodeInfo(LOCAL));
    expect(insertTelemetryBatch).toHaveBeenCalledTimes(1);
    const rows = insertTelemetryBatch.mock.calls[0][0] as Array<{ telemetryType: string }>;
    const types = rows.map((r) => r.telemetryType);
    expect(types).toContain('latitude');
    expect(types).toContain('longitude');
    expect(types).toContain('batteryLevel');
    expect(types).toContain('voltage');
  });
});
