/**
 * Integration tests for inline auto-delete-by-distance at MQTT ingest
 * (issue #3900).
 *
 * When an MQTT source has auto-delete-by-distance enabled, a POSITION packet
 * whose fix lands beyond the source's configured radius must be dropped as it
 * arrives — the node never touches the nodeDB — rather than being cleaned up
 * on the next periodic sweep. Follows the real-singleton-DB pattern of
 * `mqttIngestion.perSource.test.ts` (only the protobuf decode is mocked) so
 * the source-scoped settings + node writes are exercised for real.
 *
 * No geo `filter` is passed: the inline distance check is a separate, radial
 * mechanism from the geo-bbox classifier, and a bbox filter would short-circuit
 * an out-of-box POSITION before the distance check ever runs.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number, _payload: Uint8Array) => {
      if (portnum === 3 /* POSITION_APP */) {
        // Default fix: far from home (0,0). Individual tests override.
        return { latitudeI: 437_000_000, longitudeI: -793_000_000 };
      }
      return null;
    }),
  },
}));

import { ingestServiceEnvelope } from './mqttIngestion.js';
import { nodeNumToId, type ServiceEnvelopeShape } from './mqttPacketFilter.js';
import databaseService from '../services/database.js';
import { autoDeleteByDistanceService } from './services/autoDeleteByDistanceService.js';

const SRC = 'dist-inline-src';

// Home at (0,0), 100km radius. Far ≈ 43.7,-79.3 (~9000km); near ≈ 0.1,0.1 (~16km).
const FAR_POSITION = { latitudeI: 437_000_000, longitudeI: -793_000_000 };
const NEAR_POSITION = { latitudeI: 1_000_000, longitudeI: 1_000_000 };

function posEnv(from: number, packetId = 0x12345678): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId: '!00000001',
    packet: {
      id: packetId,
      from,
      to: 0xffffffff,
      channel: 0,
      decoded: { portnum: 3 /* POSITION_APP */, payload: new Uint8Array([0]) },
    },
  };
}

describe('ingestServiceEnvelope — inline auto-delete-by-distance (#3900)', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
    await databaseService.sources.deleteSource(SRC).catch(() => {});
    await databaseService.sources.createSource({ id: SRC, name: 'Dist Src', type: 'mqtt_broker', config: {}, enabled: true });
    await databaseService.settings.setSourceSettings(SRC, {
      autoDeleteByDistanceEnabled: 'true',
      autoDeleteByDistanceLat: '0',
      autoDeleteByDistanceLon: '0',
      autoDeleteByDistanceThresholdKm: '100',
      autoDeleteByDistanceAction: 'delete',
    });
  });

  afterAll(async () => {
    await databaseService.sources.deleteSource(SRC).catch(() => {});
  });

  beforeEach(() => {
    // Config is cached per-source for 60s; clear so each test's settings win.
    autoDeleteByDistanceService.clearInlineConfigCache(SRC);
  });

  it('drops an out-of-range POSITION at ingest (reason=distance) and never creates the node', async () => {
    const NODE = 0x20000001;
    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => FAR_POSITION);

    const result = await ingestServiceEnvelope({ sourceId: SRC, envelope: posEnv(NODE) });

    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('distance');
    // No node row should ever have been written.
    expect(await databaseService.nodes.getNode(NODE, SRC)).toBeNull();
  });

  it('deletes an already-present node when its out-of-range POSITION arrives', async () => {
    const NODE = 0x20000002;
    const NODE_ID = nodeNumToId(NODE);
    // Seed the node (as if a NodeInfo landed before the position).
    await databaseService.upsertNodeAsync({
      nodeNum: NODE,
      nodeId: NODE_ID,
      longName: 'Faraway',
      shortName: 'FAR',
      hwModel: 1,
      lastHeard: Math.floor(Date.now() / 1000),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, SRC);
    expect(await databaseService.nodes.getNode(NODE, SRC)).not.toBeNull();

    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => FAR_POSITION);
    const result = await ingestServiceEnvelope({ sourceId: SRC, envelope: posEnv(NODE) });

    expect(result.reason).toBe('distance');
    await vi.waitFor(async () => {
      expect(await databaseService.nodes.getNode(NODE, SRC)).toBeNull();
    });
  });

  it('ingests an in-range POSITION normally', async () => {
    const NODE = 0x20000003;
    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => NEAR_POSITION);

    const result = await ingestServiceEnvelope({ sourceId: SRC, envelope: posEnv(NODE) });

    expect(result.ingested).toBe(true);
    // upsert is fire-and-forget — poll for the row.
    await vi.waitFor(async () => {
      const node = await databaseService.nodes.getNode(NODE, SRC);
      expect(node).not.toBeNull();
      expect(node?.latitude).toBeCloseTo(0.1, 2);
    });
  });

  it('does not drop when the feature is disabled for the source', async () => {
    await databaseService.settings.setSourceSetting(SRC, 'autoDeleteByDistanceEnabled', 'false');
    autoDeleteByDistanceService.clearInlineConfigCache(SRC);

    const NODE = 0x20000004;
    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => FAR_POSITION);
    const result = await ingestServiceEnvelope({ sourceId: SRC, envelope: posEnv(NODE) });

    expect(result.ingested).toBe(true);
    await vi.waitFor(async () => {
      expect(await databaseService.nodes.getNode(NODE, SRC)).not.toBeNull();
    });

    // Restore for any later cases / re-runs.
    await databaseService.settings.setSourceSetting(SRC, 'autoDeleteByDistanceEnabled', 'true');
  });
});
