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
});
