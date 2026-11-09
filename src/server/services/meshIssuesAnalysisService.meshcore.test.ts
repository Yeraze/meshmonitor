/**
 * meshIssuesAnalysisService with MeshCore sources (#6263 S5). The rules run
 * for real here; only the database and the packet-log services are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  sources: { getAllSources: vi.fn() },
  nodes: { getAllNodes: vi.fn() },
  meshcore: { getAllNodes: vi.fn(), getPositionHistory: vi.fn(), getPackets: vi.fn() },
  telemetry: { getTelemetryByTypesSince: vi.fn(), getPositionTelemetryByNode: vi.fn() },
  analysis: { getTraceroutes: vi.fn(), getNeighbors: vi.fn() },
  settings: { getSetting: vi.fn(), getLocalNodeNumForSource: vi.fn() },
  getMeshIssuesAsync: vi.fn(),
  upsertMeshIssueFindingAsync: vi.fn(),
  bumpMeshIssueCleanRunAsync: vi.fn(),
  getMqttDirectReceptionsByGatewayAsync: vi.fn(),
  getPacketHopArrivalCountsAsync: vi.fn(),
  getMqttPacketHopArrivalCountsAsync: vi.fn(),
  getTelemetryCadenceAggregatesAsync: vi.fn(),
  getTelemetryTimestampsAsync: vi.fn(),
  getBroadcastTelemetryTimestampsAsync: vi.fn(),
  getAssetNodesMapAsync: vi.fn(async () => new Map()),
}));
vi.mock('../../services/database.js', () => ({ default: mockDb }));

const mockPacketLog = vi.hoisted(() => ({ isEnabled: vi.fn() }));
vi.mock('./packetLogService.js', () => ({ default: mockPacketLog }));
const mockMqttLog = vi.hoisted(() => ({ isEnabled: vi.fn() }));
vi.mock('./mqttPacketLogService.js', () => ({ default: mockMqttLog }));
const mockMcLog = vi.hoisted(() => ({ isEnabled: vi.fn() }));
vi.mock('./meshcorePacketLogService.js', () => ({ default: mockMcLog }));

import { meshIssuesAnalysisService } from './meshIssuesAnalysisService.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const PK = 'ab'.repeat(32);

function source(id: string, type: string) {
  return { id, name: id, type, config: {}, enabled: true, displayOrder: 0, createdAt: 0, updatedAt: 0, createdBy: null };
}

function mcNode(overrides: Record<string, unknown> = {}) {
  return {
    publicKey: PK.toUpperCase(),
    sourceId: 'mc-1',
    name: 'Hill Repeater',
    advType: 2,
    latitude: 30,
    longitude: -90,
    lastHeard: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

// ~11 km north-south: well past the 500 m mobile threshold.
const MOVING = [
  { latitude: 30, longitude: -90 },
  { latitude: 30.1, longitude: -90 },
];

async function run() {
  return meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });
}

function persisted() {
  return mockDb.upsertMeshIssueFindingAsync.mock.calls.map((c) => c[0]);
}

describe('meshIssuesAnalysisService with MeshCore sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.settings.getSetting.mockResolvedValue(null);
    mockDb.settings.getLocalNodeNumForSource.mockResolvedValue(null);
    mockDb.telemetry.getTelemetryByTypesSince.mockResolvedValue([]);
    mockDb.telemetry.getPositionTelemetryByNode.mockResolvedValue([]);
    mockDb.analysis.getTraceroutes.mockResolvedValue({ items: [], pageSize: 2000, hasMore: false, nextCursor: null });
    mockDb.analysis.getNeighbors.mockResolvedValue({ items: [] });
    mockDb.getMeshIssuesAsync.mockResolvedValue([]);
    mockDb.upsertMeshIssueFindingAsync.mockResolvedValue({ issue: {}, outcome: 'created' });
    mockDb.bumpMeshIssueCleanRunAsync.mockResolvedValue({ cleanRuns: 1, closed: false });
    mockDb.getMqttDirectReceptionsByGatewayAsync.mockResolvedValue([]);
    mockDb.getPacketHopArrivalCountsAsync.mockResolvedValue([]);
    mockDb.getMqttPacketHopArrivalCountsAsync.mockResolvedValue([]);
    mockDb.getTelemetryCadenceAggregatesAsync.mockResolvedValue([]);
    mockDb.getTelemetryTimestampsAsync.mockResolvedValue([]);
    mockDb.getBroadcastTelemetryTimestampsAsync.mockResolvedValue([]);
    mockDb.nodes.getAllNodes.mockResolvedValue([]);
    mockDb.meshcore.getAllNodes.mockResolvedValue([mcNode()]);
    mockDb.meshcore.getPositionHistory.mockResolvedValue(MOVING);
    mockDb.meshcore.getPackets.mockResolvedValue([]);
    mockPacketLog.isEnabled.mockResolvedValue(false);
    mockMqttLog.isEnabled.mockResolvedValue(false);
    mockMcLog.isEnabled.mockResolvedValue(false);
  });

  it('a MeshCore-only install persists an A4 finding with mc:<pk>, nodeNum null and evidence identity', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([source('mc-1', 'meshcore')]);

    const result = await run();

    expect(result.findingCount).toBe(1);
    const [f] = persisted();
    expect(f.issueType).toBe('A4_mobile_infra');
    expect(f.subjectKey).toBe(`mc:${PK}`);
    expect(f.nodeNum).toBeNull();
    expect(f.evidence.publicKey).toBe(PK);
    expect(f.evidence.nodeName).toBe('Hill Repeater');
    expect(f.evidence.sourceIds).toEqual(['mc-1']);
    expect(f.sourceIds).toEqual(['mc-1']);
    // The Meshtastic pipeline never ran.
    expect(mockDb.nodes.getAllNodes).not.toHaveBeenCalled();
    expect(mockDb.analysis.getTraceroutes).not.toHaveBeenCalled();
  });

  it('does not flag a companion or a stationary repeater', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([source('mc-1', 'meshcore_mqtt')]);
    mockDb.meshcore.getAllNodes.mockResolvedValue([
      mcNode({ publicKey: 'cd'.repeat(32), advType: 1 }),
      mcNode(),
    ]);
    mockDb.meshcore.getPositionHistory.mockImplementation(async (_s: string, pk: string) =>
      pk === PK ? [MOVING[0], MOVING[0]] : MOVING,
    );

    const result = await run();
    expect(result.findingCount).toBe(0);
    // Position history is read only for infra nodes.
    expect(mockDb.meshcore.getPositionHistory).toHaveBeenCalledTimes(1);
  });

  it('reports a coverage skip and reads no packets when the MeshCore packet log is off', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([source('mc-1', 'meshcore')]);

    const result = await run();

    expect(mockMcLog.isEnabled).toHaveBeenCalled();
    expect(mockDb.meshcore.getPackets).not.toHaveBeenCalled();
    expect(result.coverage.skippedRules.some((s) => s.rule === 'C2' && /packet log/i.test(s.reason))).toBe(true);
  });

  it('flags a fast-advertising repeater from ADVERT rows when the packet log is on', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([source('mc-1', 'meshcore')]);
    mockDb.meshcore.getPositionHistory.mockResolvedValue([]);
    mockMcLog.isEnabled.mockResolvedValue(true);
    mockDb.meshcore.getPackets.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        sourceId: 'mc-1',
        timestamp: NOW - (8 - i) * HOUR,
        routeType: 1,
        hopCount: 2,
        senderPubKey: PK,
      })),
    );

    const result = await run();

    expect(mockDb.meshcore.getPackets).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'mc-1', payloadType: 4 }));
    const c2 = persisted().find((f) => f.issueType === 'C2_over_broadcasting');
    expect(c2).toBeDefined();
    expect(c2.subjectKey).toBe(`mc:${PK}`);
    expect(c2.nodeNum).toBeNull();
    expect(c2.evidence.stream).toBe('advert_flood');
    expect(result.coverage.skippedRules.some((s) => /packet log/i.test(s.reason))).toBe(false);
  });

  it('flags A3 uptime resets from status telemetry', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([source('mc-1', 'meshcore')]);
    mockDb.meshcore.getPositionHistory.mockResolvedValue([]);
    const values = [5000, 9000, 100, 4000, 50];
    mockDb.telemetry.getTelemetryByTypesSince.mockResolvedValue(
      values.map((value, i) => ({
        nodeId: PK,
        nodeNum: 1,
        telemetryType: 'mc_status_uptime_secs',
        value,
        timestamp: NOW - (values.length - i) * HOUR,
        sourceId: 'mc-1',
      })),
    );

    await run();

    const a3 = persisted().find((f) => f.issueType === 'A3_infra_power');
    expect(a3).toBeDefined();
    expect(a3.subjectKey).toBe(`mc:${PK}`);
    expect(a3.evidence.clause).toBe('resets');
  });

  it('a Meshtastic + MeshCore install keeps Meshtastic subjectKeys as node:<nodeNum>', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([source('mt-1', 'meshtastic_tcp'), source('mc-1', 'meshcore')]);
    mockDb.nodes.getAllNodes.mockResolvedValue([
      {
        nodeNum: 100, nodeId: '!00000064', sourceId: 'mt-1', longName: 'Old Repeater', shortName: 'OR', hwModel: 1,
        role: 4, // deprecated REPEATER -> A1
        lastHeard: Math.floor(NOW / 1000), updatedAt: NOW,
      },
    ]);
    mockDb.meshcore.getPositionHistory.mockResolvedValue([]);

    await run();

    const keys = persisted().map((f) => f.subjectKey);
    expect(keys).toContain('node:100');
    expect(keys.filter((k) => k.startsWith('mc:'))).toEqual([]);
    expect(persisted().find((f) => f.subjectKey === 'node:100').nodeNum).toBe(100);
  });

  describe('node-health rules A6-A9 (#6279)', () => {
    const PK2 = 'cd'.repeat(32);
    const PK3 = 'ef'.repeat(32);
    const DAY = 24 * HOUR;
    const types = () => persisted().map((f) => f.issueType);

    // PK: stale 5 d, no position, 3.1 V. PK2: fresh, Null Island. PK3: fresh companion (keeps the source live).
    const nodeSet = () => [
      mcNode({ lastHeard: NOW - 5 * DAY, updatedAt: NOW - 5 * DAY, latitude: null, longitude: null }),
      mcNode({ publicKey: PK2, latitude: 0, longitude: 0 }),
      mcNode({ publicKey: PK3, advType: 1 }),
    ];

    it('a MeshCore-only run emits A6-A9 with mc: subjectKeys and null nodeNum', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([source('mc-1', 'meshcore')]);
      mockDb.meshcore.getPositionHistory.mockResolvedValue([]);
      mockDb.meshcore.getAllNodes.mockResolvedValue(nodeSet());
      mockDb.telemetry.getTelemetryByTypesSince.mockResolvedValue([
        { nodeId: PK, nodeNum: 1, telemetryType: 'mc_status_battery_volts', value: 3.1, timestamp: NOW - HOUR, sourceId: 'mc-1' },
      ]);

      await run();

      expect(mockDb.telemetry.getTelemetryByTypesSince).toHaveBeenCalledWith(
        ['mc_status_uptime_secs', 'mc_battery_mv', 'mc_status_battery_volts'],
        expect.any(Number),
        ['mc-1'],
      );
      const by = (t: string) => persisted().find((f) => f.issueType === t);
      expect(by('A6_stale_node').subjectKey).toBe(`mc:${PK}`);
      expect(by('A7_no_position').subjectKey).toBe(`mc:${PK}`);
      expect(by('A9_bad_position').subjectKey).toBe(`mc:${PK2}`);
      const a8 = by('A8_low_battery');
      expect(a8.subjectKey).toBe(`mc:${PK}`);
      expect(a8.evidence).toMatchObject({ unit: 'mv', latestBatteryMv: 3100, publicKey: PK });
      for (const t of ['A6_stale_node', 'A7_no_position', 'A8_low_battery', 'A9_bad_position']) {
        expect(by(t).nodeNum).toBeNull();
      }
      expect(JSON.stringify(by('A9_bad_position').evidence)).not.toMatch(/"lat|"lon/i);
    });

    it('a silent source yields a skip, not A6 findings', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([source('mc-1', 'meshcore')]);
      mockDb.meshcore.getPositionHistory.mockResolvedValue([]);
      mockDb.meshcore.getAllNodes.mockResolvedValue([
        mcNode({ lastHeard: NOW - 5 * DAY, updatedAt: NOW - 5 * DAY }),
      ]);

      const result = await run();

      expect(types()).not.toContain('A6_stale_node');
      expect(result.coverage.skippedRules).toContainEqual({ rule: 'A6', reason: '1 node(s) skipped, source(s) silent' });
    });

    it('a muted A8 is not emitted and appears in skippedRules', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([source('mc-1', 'meshcore')]);
      mockDb.meshcore.getPositionHistory.mockResolvedValue([]);
      mockDb.meshcore.getAllNodes.mockResolvedValue(nodeSet());
      mockDb.telemetry.getTelemetryByTypesSince.mockResolvedValue([
        { nodeId: PK, nodeNum: 1, telemetryType: 'mc_battery_mv', value: 3000, timestamp: NOW - HOUR, sourceId: 'mc-1' },
      ]);
      mockDb.settings.getSetting.mockImplementation(async (k: string) =>
        k === 'mesh_issues_disabled_rules' ? 'A8_low_battery' : null,
      );

      const result = await run();

      expect(types()).not.toContain('A8_low_battery');
      expect(types()).toContain('A7_no_position');
      expect(result.coverage.skippedRules).toContainEqual({ rule: 'A8', reason: 'muted in settings' });
    });

    it('honours the stale-hours and low-battery tunables', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([source('mc-1', 'meshcore')]);
      mockDb.meshcore.getPositionHistory.mockResolvedValue([]);
      mockDb.meshcore.getAllNodes.mockResolvedValue([
        mcNode({ lastHeard: NOW - 50 * HOUR, updatedAt: NOW - 50 * HOUR }),
        mcNode({ publicKey: PK3, advType: 1 }),
      ]);
      mockDb.telemetry.getTelemetryByTypesSince.mockResolvedValue([
        { nodeId: PK, nodeNum: 1, telemetryType: 'mc_battery_mv', value: 3400, timestamp: NOW - HOUR, sourceId: 'mc-1' },
      ]);
      mockDb.settings.getSetting.mockImplementation(async (k: string) =>
        ({ mesh_issues_stale_hours_meshcore: '24', mesh_issues_low_battery_mv: '3500' } as Record<string, string>)[k] ?? null,
      );

      await run();

      expect(types()).toContain('A6_stale_node');
      expect(types()).toContain('A8_low_battery');
    });

    it('a mixed run pools both protocols and keeps node:<nodeNum> for Meshtastic', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([source('mt-1', 'meshtastic_tcp'), source('mc-1', 'meshcore')]);
      mockDb.meshcore.getPositionHistory.mockResolvedValue([]);
      mockDb.meshcore.getAllNodes.mockResolvedValue(nodeSet());
      mockDb.nodes.getAllNodes.mockResolvedValue([
        // ROUTER at Null Island, fresh -> A9. The local node row keeps mt-1 out of A6 liveness.
        { nodeNum: 100, nodeId: '!00000064', sourceId: 'mt-1', longName: 'Router', role: 2, latitude: 0, longitude: 0,
          lastHeard: Math.floor(NOW / 1000), updatedAt: NOW },
        { nodeNum: 200, nodeId: '!000000c8', sourceId: 'mt-1', longName: 'Quiet Router', role: 2, latitude: 40, longitude: -100,
          lastHeard: Math.floor((NOW - 3 * DAY) / 1000), updatedAt: NOW - 3 * DAY },
      ]);

      await run();

      const a9 = persisted().filter((f) => f.issueType === 'A9_bad_position').map((f) => f.subjectKey).sort();
      expect(a9).toEqual([`mc:${PK2}`, 'node:100'].sort());
      expect(persisted().find((f) => f.subjectKey === 'node:100' && f.issueType === 'A9_bad_position').nodeNum).toBe(100);
      // Node 100 is fresh, so mt-1 is live and the 3-day-old Meshtastic router is stale.
      const a6 = persisted().filter((f) => f.issueType === 'A6_stale_node').map((f) => f.subjectKey);
      expect(a6).toContain('node:200');
      expect(a6).toContain(`mc:${PK}`);
    });
  });
});
