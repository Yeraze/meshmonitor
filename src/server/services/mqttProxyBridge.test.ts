/**
 * Tests for the MQTT proxy bridge helpers (#3962 Phase 4.2a PR2 §4a).
 *
 * `shouldExcludeFromPacketLog` + `isPhantomInternalPacket` gate what
 * MeshtasticManager.processMeshPacket logs as real mesh traffic vs. internal
 * device chatter. `peekServiceEnvelopePacketId` / `recordMqttEcho` /
 * `matchesMqttEcho` implement the device<->broker echo-suppression ring
 * buffers used by the MQTT link (`handleDeviceMqttProxyMessage` /
 * `handleLinkedBrokerLocalPacket`).
 *
 * The `shouldExcludeFromPacketLog` cases below were ported verbatim from the
 * former `meshtasticManager.packet-filter.test.ts` (deleted by this PR — the
 * function it tested moved here).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PortNum } from '../constants/meshtastic.js';
import {
  shouldExcludeFromPacketLog,
  isPhantomInternalPacket,
  peekServiceEnvelopePacketId,
  recordMqttEcho,
  matchesMqttEcho,
  MQTT_LINK_ECHO_MAX,
  MQTT_LINK_ECHO_TTL_MS,
  type MqttEchoEntry,
} from './mqttProxyBridge.js';

vi.mock('../meshtasticProtobufService.js', () => ({
  default: {
    decodeServiceEnvelope: vi.fn(),
  },
}));

import meshtasticProtobufService from '../meshtasticProtobufService.js';

const { ROUTING_APP, ADMIN_APP, TEXT_MESSAGE_APP, POSITION_APP, NODEINFO_APP, TELEMETRY_APP } = PortNum;

const LOCAL_NODE = 123456789;
const REMOTE_NODE_A = 987654321;
const REMOTE_NODE_B = 111222333;
const BROADCAST = 0xffffffff;

describe('shouldExcludeFromPacketLog', () => {
  describe('local internal packets (should be excluded)', () => {
    it('should exclude ADMIN_APP packets FROM local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, ADMIN_APP, LOCAL_NODE)).toBe(true);
    });

    it('should exclude ADMIN_APP packets TO local node', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, LOCAL_NODE, ADMIN_APP, LOCAL_NODE)).toBe(true);
    });

    it('should exclude ROUTING_APP packets FROM local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, ROUTING_APP, LOCAL_NODE)).toBe(true);
    });

    it('should exclude ROUTING_APP packets TO local node', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, LOCAL_NODE, ROUTING_APP, LOCAL_NODE)).toBe(true);
    });

    it('should exclude ADMIN_APP packets from local to local (self)', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, LOCAL_NODE, ADMIN_APP, LOCAL_NODE)).toBe(true);
    });
  });

  describe('remote mesh traffic (should NOT be excluded)', () => {
    it('should NOT exclude ADMIN_APP packets between remote nodes', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, REMOTE_NODE_B, ADMIN_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude ROUTING_APP packets between remote nodes', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, REMOTE_NODE_B, ROUTING_APP, LOCAL_NODE)).toBe(false);
    });
  });

  describe('regular mesh traffic (should NOT be excluded)', () => {
    it('should NOT exclude TEXT_MESSAGE_APP packets from local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, TEXT_MESSAGE_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude TEXT_MESSAGE_APP packets to local node', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, LOCAL_NODE, TEXT_MESSAGE_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude POSITION_APP packets from local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, BROADCAST, POSITION_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude NODEINFO_APP packets from local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, BROADCAST, NODEINFO_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude TELEMETRY_APP packets from local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, BROADCAST, TELEMETRY_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude TEXT_MESSAGE_APP packets between remote nodes', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, REMOTE_NODE_B, TEXT_MESSAGE_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude broadcast messages from remote nodes', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, BROADCAST, TEXT_MESSAGE_APP, LOCAL_NODE)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should NOT exclude any packets when localNodeNum is null (not connected)', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, ADMIN_APP, null)).toBe(false);
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, LOCAL_NODE, ROUTING_APP, null)).toBe(false);
    });

    it('should exclude ADMIN_APP packets from local node even when toNum is null', () => {
      // Broadcast ADMIN_APP from local node - still excluded since from local
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, null, ADMIN_APP, LOCAL_NODE)).toBe(true);
    });

    it('should handle portnum 0 (UNKNOWN_APP) correctly', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, 0, LOCAL_NODE)).toBe(false);
    });
  });
});

describe('isPhantomInternalPacket', () => {
  it('flags a local-origin, internal-transport, zero-hop packet as phantom', () => {
    expect(isPhantomInternalPacket(LOCAL_NODE, LOCAL_NODE, 0, 0)).toBe(true);
  });

  it('treats undefined transportMechanism/hopStart as INTERNAL/0 (phantom)', () => {
    expect(isPhantomInternalPacket(LOCAL_NODE, LOCAL_NODE, undefined, undefined)).toBe(true);
  });

  it('is not phantom when localNodeNum is null (not connected)', () => {
    expect(isPhantomInternalPacket(LOCAL_NODE, null, 0, 0)).toBe(false);
  });

  it('is not phantom when the packet is not from the local node', () => {
    expect(isPhantomInternalPacket(REMOTE_NODE_A, LOCAL_NODE, 0, 0)).toBe(false);
  });

  it('is not phantom when transportMechanism is non-INTERNAL', () => {
    expect(isPhantomInternalPacket(LOCAL_NODE, LOCAL_NODE, 1, 0)).toBe(false);
  });

  it('is not phantom once the packet has traveled a hop', () => {
    expect(isPhantomInternalPacket(LOCAL_NODE, LOCAL_NODE, 0, 1)).toBe(false);
  });
});

describe('MQTT echo ring buffer (recordMqttEcho / matchesMqttEcho)', () => {
  let store: MqttEchoEntry[];

  beforeEach(() => {
    store = [];
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not match before anything is recorded', () => {
    expect(matchesMqttEcho(store, 'msh/topic', 42)).toBe(false);
  });

  it('matches a (topic, packetId) pair recorded via recordMqttEcho', () => {
    recordMqttEcho(store, 'msh/topic', 42);
    expect(matchesMqttEcho(store, 'msh/topic', 42)).toBe(true);
  });

  it('does not match a different topic or packetId', () => {
    recordMqttEcho(store, 'msh/topic', 42);
    expect(matchesMqttEcho(store, 'msh/other', 42)).toBe(false);
    expect(matchesMqttEcho(store, 'msh/topic', 43)).toBe(false);
  });

  it('is a no-op when packetId is null', () => {
    recordMqttEcho(store, 'msh/topic', null);
    expect(store).toHaveLength(0);
  });

  it('expires entries after MQTT_LINK_ECHO_TTL_MS', () => {
    recordMqttEcho(store, 'msh/topic', 42);
    vi.setSystemTime(MQTT_LINK_ECHO_TTL_MS + 1);
    expect(matchesMqttEcho(store, 'msh/topic', 42)).toBe(false);
    // matchesMqttEcho itself sweeps expired entries off the front.
    expect(store).toHaveLength(0);
  });

  it('caps the store at MQTT_LINK_ECHO_MAX, evicting the oldest first', () => {
    for (let i = 0; i < MQTT_LINK_ECHO_MAX + 5; i++) {
      recordMqttEcho(store, 'msh/topic', i);
    }
    expect(store.length).toBe(MQTT_LINK_ECHO_MAX);
    // The oldest 5 entries (packetId 0..4) should have been evicted.
    expect(matchesMqttEcho(store, 'msh/topic', 0)).toBe(false);
    expect(matchesMqttEcho(store, 'msh/topic', MQTT_LINK_ECHO_MAX + 4)).toBe(true);
  });
});

describe('peekServiceEnvelopePacketId', () => {
  const decodeMock = vi.mocked(meshtasticProtobufService.decodeServiceEnvelope);

  beforeEach(() => {
    decodeMock.mockReset();
  });

  it('returns the unsigned packet id when decode succeeds', () => {
    decodeMock.mockReturnValue({ packet: { id: 0x12345678 } } as any);
    expect(peekServiceEnvelopePacketId(new Uint8Array([1, 2, 3]))).toBe(0x12345678 >>> 0);
    expect(decodeMock).toHaveBeenCalledWith(expect.any(Uint8Array), { quiet: true });
  });

  it('returns null when decode fails (quiet, no throw)', () => {
    decodeMock.mockReturnValue(null as any);
    expect(peekServiceEnvelopePacketId(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('returns null when the decoded envelope has no numeric packet id', () => {
    decodeMock.mockReturnValue({ packet: {} } as any);
    expect(peekServiceEnvelopePacketId(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
