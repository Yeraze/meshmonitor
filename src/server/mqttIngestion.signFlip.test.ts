/**
 * #5363: with sign-flip correction on for a source, MQTT ingest's geo gate and
 * inline distance check (#3900) judge the corrected point, so a node that only
 * dropped its minus sign is neither geo-ignored nor distance-deleted. With
 * correction off, both behave exactly as before.
 *
 * Real singleton DB (only the protobuf decode is mocked), like
 * mqttIngestion.distanceInline.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Tampa, with the longitude sign dropped (27.9, 82.5).
const FLIPPED_POSITION = { latitudeI: 279_000_000, longitudeI: 825_000_000 };

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number) => (portnum === 3 ? FLIPPED_POSITION : null)),
  },
}));

import { ingestServiceEnvelope } from './mqttIngestion.js';
import { MqttPacketFilter, type ServiceEnvelopeShape } from './mqttPacketFilter.js';
import databaseService from '../services/database.js';
import { autoDeleteByDistanceService } from './services/autoDeleteByDistanceService.js';
import { invalidateSignFlipContext } from './services/signFlipCorrection.js';

const DIST_SRC = 'signflip-dist-src';
const GEO_SRC = 'signflip-geo-src';

const SIGN_FLIP_ON = {
  signFlipCorrectionEnabled: 'true',
  signFlipReferenceLatitude: '27.95',
  signFlipReferenceLongitude: '-82.46',
};
const SIGN_FLIP_OFF = { signFlipCorrectionEnabled: 'false' };

// A box around Florida.
const FLORIDA_BBOX = { minLat: 24, maxLat: 31, minLng: -88, maxLng: -79 };

let packetId = 0x5363_0000;
function posEnv(from: number): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId: '!00000001',
    packet: {
      id: packetId++,
      from,
      to: 0xffffffff,
      channel: 0,
      decoded: { portnum: 3 /* POSITION_APP */, payload: new Uint8Array([0]) },
    },
  };
}

async function setSignFlip(sourceId: string, values: Record<string, string>) {
  await databaseService.settings.setSourceSettings(sourceId, values);
  invalidateSignFlipContext(sourceId);
}

describe('MQTT ingest gates use the sign-flip corrected point (#5363)', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
    for (const id of [DIST_SRC, GEO_SRC]) {
      await databaseService.sources.deleteSource(id).catch(() => {});
      await databaseService.sources.createSource({ id, name: id, type: 'mqtt_broker', config: {}, enabled: true });
    }
    // Distance source: home Tampa, 100 km, delete.
    await databaseService.settings.setSourceSettings(DIST_SRC, {
      autoDeleteByDistanceEnabled: 'true',
      autoDeleteByDistanceLat: '27.95',
      autoDeleteByDistanceLon: '-82.46',
      autoDeleteByDistanceThresholdKm: '100',
      autoDeleteByDistanceAction: 'delete',
    });
  });

  afterAll(async () => {
    for (const id of [DIST_SRC, GEO_SRC]) {
      await databaseService.sources.deleteSource(id).catch(() => {});
    }
    invalidateSignFlipContext();
  });

  beforeEach(() => {
    autoDeleteByDistanceService.clearInlineConfigCache(DIST_SRC);
  });

  describe('inline distance check', () => {
    it('keeps a flipped node near home when correction is on', async () => {
      await setSignFlip(DIST_SRC, SIGN_FLIP_ON);
      const result = await ingestServiceEnvelope({ sourceId: DIST_SRC, envelope: posEnv(0x30000001) });
      expect(result.reason).not.toBe('distance');
      expect(result.ingested).toBe(true);
    });

    it('still drops it when correction is off', async () => {
      await setSignFlip(DIST_SRC, SIGN_FLIP_OFF);
      const result = await ingestServiceEnvelope({ sourceId: DIST_SRC, envelope: posEnv(0x30000002) });
      expect(result.ingested).toBe(false);
      expect(result.reason).toBe('distance');
    });
  });

  describe('geo gate', () => {
    const filter = new MqttPacketFilter({ geo: FLORIDA_BBOX });

    it('does not geo-ignore a flipped node inside the box when correction is on', async () => {
      await setSignFlip(GEO_SRC, SIGN_FLIP_ON);
      const NODE = 0x30000003;
      const result = await ingestServiceEnvelope({ sourceId: GEO_SRC, envelope: posEnv(NODE), filter });
      expect(result.reason).not.toBe('geo-ignored');
      expect(databaseService.ignoredNodes.isIgnoredCached(NODE, GEO_SRC)).toBe(false);
    });

    it('still geo-ignores it when correction is off', async () => {
      await setSignFlip(GEO_SRC, SIGN_FLIP_OFF);
      const NODE = 0x30000004;
      const result = await ingestServiceEnvelope({ sourceId: GEO_SRC, envelope: posEnv(NODE), filter });
      expect(result.reason).toBe('geo-ignored');
    });
  });
});
