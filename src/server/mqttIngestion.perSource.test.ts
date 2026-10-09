/**
 * Per-source isolation tests for the MQTT geo-ignore flow (MQTT Geo-Ignore
 * epic, Phase 2 / WP4).
 *
 * Unlike `mqttIngestion.test.ts` (which mocks `../services/database.js`
 * wholesale to pin the wiring/branching of `ingestServiceEnvelope`), this
 * file exercises the REAL singleton `databaseService` against its
 * `:memory:` SQLite backend (see `src/server/test-helpers/routeTestApp.ts`
 * for the same singleton-DB rationale). Per-source isolation is exactly
 * the kind of thing a database mock can't prove — only a real repository,
 * scoped by `sourceId`, can demonstrate that a geo-ignore/purge on one
 * source never leaks to another.
 *
 * `meshtasticProtobufService` IS still mocked here (as in
 * `mqttIngestion.test.ts`) — that module's protobuf decoding isn't what's
 * under test, and mocking it lets each case control the decoded
 * lat/lng deterministically.
 *
 * IMPORTANT: several of the DB writes exercised here are fire-and-forget
 * inside `ingestServiceEnvelope` (`void databaseService.upsertNodeAsync(...)`,
 * `void databaseService.deleteNodeAsync(...)` for the geo-purge). Tests that
 * assert on those rows must `vi.waitFor(...)` rather than read immediately
 * after `await ingestServiceEnvelope(...)` resolves. The `ignored_nodes`
 * row itself IS awaited synchronously (`addGeoIgnoreAsync`/`liftGeoIgnoreAsync`
 * are awaited directly in the POSITION_APP branch), so those checks don't
 * need polling.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Only the protobuf decode step is mocked — real singleton databaseService
// backs everything else. See file header.
vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number, _payload: Uint8Array) => {
      if (portnum === 3 /* POSITION_APP */) {
        // Default: inside ON_BBOX (43.7, -79.3). Individual tests override
        // with mockImplementationOnce/mockReturnValueOnce for out-of-bbox.
        return { latitudeI: 437_000_000, longitudeI: -793_000_000 };
      }
      if (portnum === 1 /* TEXT_MESSAGE_APP */) {
        return 'hello';
      }
      if (portnum === 67 /* TELEMETRY_APP */) {
        return { deviceMetrics: { batteryLevel: 88 } };
      }
      return null;
    }),
  },
}));

import { ingestServiceEnvelope } from './mqttIngestion.js';
import { MqttPacketFilter, nodeNumToId, type ServiceEnvelopeShape } from './mqttPacketFilter.js';
import databaseService, { type DbMessage, type DbTelemetry } from '../services/database.js';

const SRC_A = 'geo-ps-src-a';
const SRC_B = 'geo-ps-src-b';

// Bounding box used across every case — matches mqttIngestion.test.ts's ON_BBOX.
const ON_BBOX = { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 };

// Vancouver — well outside ON_BBOX.
const OUT_POSITION = { latitudeI: 492_000_000, longitudeI: -1_230_000_000 };

function envFor(from: number, portnum: number, packetId = 0x12345678): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId: '!00000001',
    packet: {
      id: packetId,
      from,
      to: 0xffffffff,
      channel: 0,
      decoded: { portnum, payload: new Uint8Array([0]) },
    },
  };
}

describe('ingestServiceEnvelope — geo-ignore per-source isolation', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
    // Idempotent: clear out any leftovers from a prior run of this same file
    // (singleton DB persists for the whole test file — see routeTestApp.ts).
    await databaseService.sources.deleteSource(SRC_A).catch(() => {});
    await databaseService.sources.deleteSource(SRC_B).catch(() => {});
    await databaseService.sources.createSource({ id: SRC_A, name: 'Source A', type: 'meshtastic_tcp', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: SRC_B, name: 'Source B', type: 'meshtastic_tcp', config: {}, enabled: true });
  });

  afterAll(async () => {
    // FK ON DELETE CASCADE (migration 048) takes ignored_nodes/nodes/messages/
    // telemetry rows scoped to these sources with them.
    await databaseService.sources.deleteSource(SRC_A).catch(() => {});
    await databaseService.sources.deleteSource(SRC_B).catch(() => {});
  });

  it('geo-ignores (nodeNum, sourceA) on an out-of-bbox POSITION while (nodeNum, sourceB) stays un-ignored and its node row survives the purge', async () => {
    const NODE = 0x10000001;
    const NODE_ID = nodeNumToId(NODE);

    // Seed a node row on sourceB for the SAME physical nodeNum, so we can
    // prove the sourceA-scoped purge never touches it.
    await databaseService.upsertNodeAsync({
      nodeNum: NODE,
      nodeId: NODE_ID,
      longName: 'Node One B',
      shortName: 'N1B',
      hwModel: 1,
      lastHeard: Math.floor(Date.now() / 1000),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, SRC_B);
    expect(await databaseService.nodes.getNode(NODE, SRC_B)).not.toBeNull();

    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => OUT_POSITION);

    const filter = new MqttPacketFilter({ geo: ON_BBOX });
    const result = await ingestServiceEnvelope({
      sourceId: SRC_A,
      envelope: envFor(NODE, 3 /* POSITION_APP */),
      filter,
    });

    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('geo-ignored');

    // addGeoIgnoreAsync is awaited synchronously inside the POSITION_APP
    // branch, so the ignore row + cache are visible immediately.
    expect(databaseService.ignoredNodes.isIgnoredCached(NODE, SRC_A)).toBe(true);
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_A)).toBe(true);
    expect(databaseService.ignoredNodes.isIgnoredCached(NODE, SRC_B)).toBe(false);
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_B)).toBe(false);

    const onA = await databaseService.ignoredNodes.getIgnoredNodesAsync(SRC_A);
    expect(onA.find((r) => r.nodeNum === NODE)?.reason).toBe('geo');
    const onB = await databaseService.ignoredNodes.getIgnoredNodesAsync(SRC_B);
    expect(onB.find((r) => r.nodeNum === NODE)).toBeUndefined();

    // The purge itself is fire-and-forget (`void databaseService.deleteNodeAsync(...)`).
    // Wait for sourceA's node row to disappear, which proves the purge ran.
    await vi.waitFor(async () => {
      expect(await databaseService.nodes.getNode(NODE, SRC_A)).toBeNull();
    });

    // sourceB's node row must be completely untouched by the sourceA purge.
    const nodeB = await databaseService.nodes.getNode(NODE, SRC_B);
    expect(nodeB).not.toBeNull();
    expect(nodeB?.longName).toBe('Node One B');
  });

  it('still ingests non-POSITION traffic from the same nodeNum on sourceB — the ignore gate is per-source', async () => {
    // Reuses the nodeNum geo-ignored on sourceA in the previous case; that
    // ignore must have zero effect on sourceB.
    const NODE = 0x10000001;
    const PACKET_ID = 0x22223333;

    const resultA = await ingestServiceEnvelope({
      sourceId: SRC_A,
      envelope: envFor(NODE, 1 /* TEXT_MESSAGE_APP */, PACKET_ID),
    });
    expect(resultA.ingested).toBe(false);
    expect(resultA.reason).toBe('ignored');

    const resultB = await ingestServiceEnvelope({
      sourceId: SRC_B,
      envelope: envFor(NODE, 1 /* TEXT_MESSAGE_APP */, PACKET_ID),
    });
    expect(resultB.ingested).toBe(true);

    // insertMessage is fire-and-forget in the TEXT_MESSAGE_APP branch.
    await vi.waitFor(async () => {
      const msg = await databaseService.messages.getMessage(`${SRC_B}_${NODE}_${PACKET_ID}`);
      expect(msg).not.toBeNull();
    });
    // Confirm sourceA never got a matching row for the dropped packet.
    const msgA = await databaseService.messages.getMessage(`${SRC_A}_${NODE}_${PACKET_ID}`);
    expect(msgA).toBeNull();
  });

  it('an in-bbox POSITION on sourceA lifts only sourceA\'s geo-ignore; a geo row manually seeded on sourceB stays', async () => {
    const NODE = 0x10000003;
    const NODE_ID = nodeNumToId(NODE);

    // Manually seed geo-ignore rows on BOTH sources via the real repo.
    await databaseService.ignoredNodes.addGeoIgnoreAsync(NODE, SRC_A, NODE_ID, 'Node3A', 'N3A');
    await databaseService.ignoredNodes.addGeoIgnoreAsync(NODE, SRC_B, NODE_ID, 'Node3B', 'N3B');
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_A)).toBe(true);
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_B)).toBe(true);

    // Default mock POSITION_APP payload is inside ON_BBOX.
    const filter = new MqttPacketFilter({ geo: ON_BBOX });
    const result = await ingestServiceEnvelope({
      sourceId: SRC_A,
      envelope: envFor(NODE, 3 /* POSITION_APP */),
      filter,
    });

    // liftGeoIgnoreAsync is awaited synchronously before the re-check, so the
    // node reappears and ingestion proceeds in the same call.
    expect(result.ingested).toBe(true);

    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_A)).toBe(false);
    expect(databaseService.ignoredNodes.isIgnoredCached(NODE, SRC_A)).toBe(false);

    // sourceB's manually-seeded geo row must be completely untouched.
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_B)).toBe(true);
    const onB = await databaseService.ignoredNodes.getIgnoredNodesAsync(SRC_B);
    expect(onB.find((r) => r.nodeNum === NODE)?.reason).toBe('geo');
  });

  it('purge scoping: a geo-ignore transition on sourceA purges only sourceA\'s node/message/telemetry rows, leaving sourceB\'s intact', async () => {
    const NODE = 0x10000004;
    const NODE_ID = nodeNumToId(NODE);
    const PACKET_ID_A = 0xaaaa0001;
    const PACKET_ID_B = 0xbbbb0001;

    // Seed node + message + telemetry on BOTH sources for this nodeNum.
    for (const [sourceId, packetId] of [[SRC_A, PACKET_ID_A], [SRC_B, PACKET_ID_B]] as const) {
      await databaseService.upsertNodeAsync({
        nodeNum: NODE,
        nodeId: NODE_ID,
        longName: 'Node Four',
        shortName: 'N4',
        hwModel: 1,
        lastHeard: Math.floor(Date.now() / 1000),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }, sourceId);

      await databaseService.messages.insertMessage({
        id: `${sourceId}_${NODE}_${packetId}`,
        fromNodeNum: NODE,
        toNodeNum: 0xffffffff,
        fromNodeId: NODE_ID,
        toNodeId: '!ffffffff',
        text: 'seed message',
        channel: 0,
        portnum: 1,
        timestamp: Date.now(),
        createdAt: Date.now(),
      } as DbMessage, sourceId);

      await databaseService.insertTelemetryAsync({
        nodeId: NODE_ID,
        nodeNum: NODE,
        telemetryType: 'batteryLevel',
        timestamp: Date.now(),
        value: 77,
        unit: '%',
        createdAt: Date.now(),
      } as DbTelemetry, sourceId);
    }

    // Confirm the seed actually landed on both sources before triggering.
    expect(await databaseService.nodes.getNode(NODE, SRC_A)).not.toBeNull();
    expect(await databaseService.nodes.getNode(NODE, SRC_B)).not.toBeNull();
    expect(await databaseService.messages.getMessage(`${SRC_A}_${NODE}_${PACKET_ID_A}`)).not.toBeNull();
    expect(await databaseService.messages.getMessage(`${SRC_B}_${NODE}_${PACKET_ID_B}`)).not.toBeNull();

    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => OUT_POSITION);

    const filter = new MqttPacketFilter({ geo: ON_BBOX });
    const result = await ingestServiceEnvelope({
      sourceId: SRC_A,
      envelope: envFor(NODE, 3 /* POSITION_APP */),
      filter,
    });
    expect(result.reason).toBe('geo-ignored');

    // The full-purge cascade (deleteNodeAsync) is fire-and-forget — poll for
    // sourceA's node row to disappear, which proves the cascade completed.
    await vi.waitFor(async () => {
      expect(await databaseService.nodes.getNode(NODE, SRC_A)).toBeNull();
    });

    // sourceA's message + telemetry are gone too (same cascade).
    expect(await databaseService.messages.getMessage(`${SRC_A}_${NODE}_${PACKET_ID_A}`)).toBeNull();
    const telA = await databaseService.telemetry.getTelemetryByNode(NODE_ID, 100, undefined, undefined, 0, undefined, SRC_A);
    expect(telA).toHaveLength(0);

    // sourceB's node + message + telemetry must be completely intact.
    const nodeB = await databaseService.nodes.getNode(NODE, SRC_B);
    expect(nodeB).not.toBeNull();
    const msgB = await databaseService.messages.getMessage(`${SRC_B}_${NODE}_${PACKET_ID_B}`);
    expect(msgB).not.toBeNull();
    const telB = await databaseService.telemetry.getTelemetryByNode(NODE_ID, 100, undefined, undefined, 0, undefined, SRC_B);
    expect(telB.length).toBeGreaterThan(0);
  });
});
