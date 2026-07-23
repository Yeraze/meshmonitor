import { describe, it, expect, beforeAll } from 'vitest';
import { MeshtasticProtobufService, formatTakPreview } from './meshtasticProtobufService';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader';
import { existsSync } from 'fs';
import { join } from 'path';

// Check if protobufs submodule is available
const protobufPath = join(process.cwd(), 'protobufs', 'meshtastic', 'mesh.proto');
const hasProtobufs = existsSync(protobufPath);

describe('MeshtasticProtobufService', () => {
  // Use the singleton instance
  const service = MeshtasticProtobufService.getInstance();

  // Track if protobuf initialization succeeded
  let protobufInitialized = false;

  // Initialize protobuf definitions before running createNodeInfo tests
  // Only if protobufs submodule is available
  beforeAll(async () => {
    if (hasProtobufs) {
      try {
        await service.initialize();
        // Also load protobufs directly for decoding in tests
        await loadProtobufDefinitions();
        protobufInitialized = true;
      } catch {
        // Protobufs not available, tests will be skipped
        protobufInitialized = false;
      }
    }
  });

  // Helper function to decode FromRadio message
  function decodeFromRadio(data: Uint8Array): any {
    const root = getProtobufRoot();
    if (!root) return null;
    const FromRadio = root.lookupType('meshtastic.FromRadio');
    const decoded = FromRadio.decode(data);
    return FromRadio.toObject(decoded);
  }

  // Helper to check if protobuf tests should run
  function requireProtobufs() {
    if (!hasProtobufs || !protobufInitialized) {
      return false;
    }
    return true;
  }

  describe('normalizePortNum', () => {
    describe('number inputs', () => {
      it('should return valid number inputs unchanged', () => {
        expect(service.normalizePortNum(70)).toBe(70);
        expect(service.normalizePortNum(6)).toBe(6);
        expect(service.normalizePortNum(1)).toBe(1);
        expect(service.normalizePortNum(0)).toBe(0);
      });

      it('should handle all valid portnum values', () => {
        const validPorts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 32, 33, 34, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 76, 77, 256, 257, 511];
        validPorts.forEach(port => {
          expect(service.normalizePortNum(port)).toBe(port);
        });
      });

      it('should handle edge case numbers', () => {
        // MAX portnum value
        expect(service.normalizePortNum(511)).toBe(511);
        // UNKNOWN_APP
        expect(service.normalizePortNum(0)).toBe(0);
        // PRIVATE_APP
        expect(service.normalizePortNum(256)).toBe(256);
      });
    });

    describe('string enum inputs', () => {
      it('should convert TRACEROUTE_APP string to number 70', () => {
        expect(service.normalizePortNum('TRACEROUTE_APP')).toBe(70);
      });

      it('should convert ADMIN_APP string to number 6', () => {
        expect(service.normalizePortNum('ADMIN_APP')).toBe(6);
      });

      it('should convert TEXT_MESSAGE_APP string to number 1', () => {
        expect(service.normalizePortNum('TEXT_MESSAGE_APP')).toBe(1);
      });

      it('should convert all valid string enum values', () => {
        const enumMap: { [key: string]: number } = {
          'UNKNOWN_APP': 0,
          'TEXT_MESSAGE_APP': 1,
          'REMOTE_HARDWARE_APP': 2,
          'POSITION_APP': 3,
          'NODEINFO_APP': 4,
          'ROUTING_APP': 5,
          'ADMIN_APP': 6,
          'TEXT_MESSAGE_COMPRESSED_APP': 7,
          'WAYPOINT_APP': 8,
          'AUDIO_APP': 9,
          'DETECTION_SENSOR_APP': 10,
          'ALERT_APP': 11,
          'KEY_VERIFICATION_APP': 12,
          'REPLY_APP': 32,
          'IP_TUNNEL_APP': 33,
          'PAXCOUNTER_APP': 34,
          'SERIAL_APP': 64,
          'STORE_FORWARD_APP': 65,
          'RANGE_TEST_APP': 66,
          'TELEMETRY_APP': 67,
          'ZPS_APP': 68,
          'SIMULATOR_APP': 69,
          'TRACEROUTE_APP': 70,
          'NEIGHBORINFO_APP': 71,
          'ATAK_PLUGIN': 72,
          'MAP_REPORT_APP': 73,
          'POWERSTRESS_APP': 74,
          'RETICULUM_TUNNEL_APP': 76,
          'CAYENNE_APP': 77,
          'PRIVATE_APP': 256,
          'ATAK_FORWARDER': 257,
          'MAX': 511
        };

        Object.entries(enumMap).forEach(([key, value]) => {
          expect(service.normalizePortNum(key)).toBe(value);
        });
      });
    });

    describe('edge cases and invalid inputs', () => {
      it('should return undefined for undefined input', () => {
        expect(service.normalizePortNum(undefined)).toBe(undefined);
      });

      it('should return undefined for null input', () => {
        expect(service.normalizePortNum(null as any)).toBe(undefined);
      });

      it('should return undefined for unknown string values', () => {
        expect(service.normalizePortNum('INVALID_APP')).toBe(undefined);
        expect(service.normalizePortNum('random_string')).toBe(undefined);
        expect(service.normalizePortNum('')).toBe(undefined);
      });

      it('should handle numeric strings by returning undefined', () => {
        // The function explicitly does not support numeric strings
        // It expects either a number or a valid enum string
        expect(service.normalizePortNum('70' as any)).toBe(undefined);
        expect(service.normalizePortNum('6' as any)).toBe(undefined);
      });

      it('should return undefined for unexpected types', () => {
        expect(service.normalizePortNum({} as any)).toBe(undefined);
        expect(service.normalizePortNum([] as any)).toBe(undefined);
        expect(service.normalizePortNum(true as any)).toBe(undefined);
      });
    });

    describe('real-world scenarios', () => {
      it('should handle the issue #443 scenario - TRACEROUTE_APP vs ADMIN_APP confusion', () => {
        // When protobufjs returns 'TRACEROUTE_APP' as a string
        const stringPortnum = 'TRACEROUTE_APP';
        expect(service.normalizePortNum(stringPortnum)).toBe(70);

        // When protobufjs returns 70 as a number
        const numericPortnum = 70;
        expect(service.normalizePortNum(numericPortnum)).toBe(70);

        // Both should normalize to the same value
        expect(service.normalizePortNum(stringPortnum)).toBe(service.normalizePortNum(numericPortnum));

        // ADMIN_APP should be different
        expect(service.normalizePortNum('ADMIN_APP')).toBe(6);
        expect(service.normalizePortNum(6)).toBe(6);

        // Verify they're not confused
        expect(service.normalizePortNum('TRACEROUTE_APP')).not.toBe(service.normalizePortNum('ADMIN_APP'));
      });

      it('should ensure consistent normalization for blocked portnums check', () => {
        // Simulate virtualNodeServer.ts BLOCKED_PORTNUMS check
        const BLOCKED_PORTNUMS = [6]; // ADMIN_APP

        // String enum from protobufjs
        const tracerouteString = service.normalizePortNum('TRACEROUTE_APP');
        const adminString = service.normalizePortNum('ADMIN_APP');

        expect(BLOCKED_PORTNUMS.includes(tracerouteString!)).toBe(false);
        expect(BLOCKED_PORTNUMS.includes(adminString!)).toBe(true);

        // Numeric values
        const tracerouteNum = service.normalizePortNum(70);
        const adminNum = service.normalizePortNum(6);

        expect(BLOCKED_PORTNUMS.includes(tracerouteNum!)).toBe(false);
        expect(BLOCKED_PORTNUMS.includes(adminNum!)).toBe(true);
      });

      it('should work correctly in switch statements', () => {
        // Simulate meshtasticManager.ts switch statement
        const testPayloadProcessing = (portnum: number | string | undefined) => {
          const normalized = service.normalizePortNum(portnum);

          switch (normalized) {
            case 1: // TEXT_MESSAGE_APP
              return 'text';
            case 6: // ADMIN_APP
              return 'admin';
            case 70: // TRACEROUTE_APP
              return 'traceroute';
            default:
              return 'unknown';
          }
        };

        expect(testPayloadProcessing('TEXT_MESSAGE_APP')).toBe('text');
        expect(testPayloadProcessing(1)).toBe('text');

        expect(testPayloadProcessing('ADMIN_APP')).toBe('admin');
        expect(testPayloadProcessing(6)).toBe('admin');

        expect(testPayloadProcessing('TRACEROUTE_APP')).toBe('traceroute');
        expect(testPayloadProcessing(70)).toBe('traceroute');

        expect(testPayloadProcessing(undefined)).toBe('unknown');
        expect(testPayloadProcessing('INVALID')).toBe('unknown');
      });
    });
  });

  describe('getPortNumName', () => {
    it('should return correct names for numeric portnums', () => {
      expect(service.getPortNumName(70)).toBe('TRACEROUTE_APP');
      expect(service.getPortNumName(6)).toBe('ADMIN_APP');
      expect(service.getPortNumName(1)).toBe('TEXT_MESSAGE_APP');
    });

    it('should return correct names for string enum portnums', () => {
      expect(service.getPortNumName('TRACEROUTE_APP')).toBe('TRACEROUTE_APP');
      expect(service.getPortNumName('ADMIN_APP')).toBe('ADMIN_APP');
      expect(service.getPortNumName('TEXT_MESSAGE_APP')).toBe('TEXT_MESSAGE_APP');
    });

    it('should handle undefined and invalid inputs gracefully', () => {
      expect(service.getPortNumName(undefined)).toBe('UNKNOWN_undefined');
      expect(service.getPortNumName('INVALID_APP')).toBe('UNKNOWN_INVALID_APP');
    });

    it('should use normalizePortNum internally', () => {
      // Both string and number should return the same name
      expect(service.getPortNumName('TRACEROUTE_APP')).toBe(service.getPortNumName(70));
      expect(service.getPortNumName('ADMIN_APP')).toBe(service.getPortNumName(6));
    });

    // #3854 — the service keeps its own portnum tables; a portnum missing from
    // them is silently dropped when protobufjs surfaces the string enum form,
    // and labels as UNKNOWN_N in the Packet Monitor. Guard the 2.8 additions.
    it('knows MESH_BEACON_APP (37) in both string and numeric form', () => {
      expect(service.normalizePortNum('MESH_BEACON_APP')).toBe(37);
      expect(service.getPortNumName(37)).toBe('MESH_BEACON_APP');
      expect(service.getPortNumName('MESH_BEACON_APP')).toBe('MESH_BEACON_APP');
    });

    it('knows the other 2.8-era portnums the constants table carries', () => {
      expect(service.normalizePortNum('NODE_STATUS_APP')).toBe(36);
      expect(service.getPortNumName(35)).toBe('STORE_FORWARD_PLUSPLUS_APP');
      expect(service.getPortNumName(36)).toBe('NODE_STATUS_APP');
      expect(service.getPortNumName(75)).toBe('LORAWAN_BRIDGE');
      expect(service.getPortNumName(78)).toBe('ATAK_PLUGIN_V2');
      expect(service.getPortNumName(112)).toBe('GROUPALARM_APP');
    });
  });

  describe('createNodeInfo', () => {
    it('should create NodeInfo with viaMqtt=true', async () => {
      if (!requireProtobufs()) return;
      const result = await service.createNodeInfo({
        nodeNum: 123456789,
        user: {
          id: '!075bcd15',
          longName: 'MQTT Test Node',
          shortName: 'MQTT',
          hwModel: 255,
        },
        viaMqtt: true,
        isFavorite: false,
      });

      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Uint8Array);

      // Decode and verify viaMqtt is set
      const decoded = decodeFromRadio(result!);
      expect(decoded).not.toBeNull();
      expect(decoded.nodeInfo).toBeDefined();
      expect(decoded.nodeInfo.viaMqtt).toBe(true);
      expect(decoded.nodeInfo.num).toBe(123456789);
    });

    it('should create NodeInfo with viaMqtt=false', async () => {
      if (!requireProtobufs()) return;
      const result = await service.createNodeInfo({
        nodeNum: 987654321,
        user: {
          id: '!3ade68b1',
          longName: 'LoRa Test Node',
          shortName: 'LORA',
          hwModel: 43,
        },
        viaMqtt: false,
        isFavorite: true,
      });

      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Uint8Array);

      // Decode and verify viaMqtt is false
      const decoded = decodeFromRadio(result!);
      expect(decoded).not.toBeNull();
      expect(decoded.nodeInfo).toBeDefined();
      // protobufjs >= 8.2 omits proto3 scalar defaults from toObject() output
      // (upstream #2208). `viaMqtt: false` is the proto3 default for bool, so
      // it is correctly absent after decode. Treat missing as the default.
      expect(decoded.nodeInfo.viaMqtt ?? false).toBe(false);
      expect(decoded.nodeInfo.isFavorite).toBe(true);
    });

    it('should create NodeInfo without viaMqtt when not provided', async () => {
      if (!requireProtobufs()) return;
      const result = await service.createNodeInfo({
        nodeNum: 111222333,
        user: {
          id: '!06a0b8d5',
          longName: 'No MQTT Field',
          shortName: 'NONE',
        },
        // viaMqtt not provided
      });

      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Uint8Array);

      // Decode and verify nodeInfo exists
      const decoded = decodeFromRadio(result!);
      expect(decoded).not.toBeNull();
      expect(decoded.nodeInfo).toBeDefined();
      expect(decoded.nodeInfo.num).toBe(111222333);
      // viaMqtt should be undefined or false when not provided
      expect(decoded.nodeInfo.viaMqtt).toBeFalsy();
    });

    it('should include all NodeInfo fields correctly', async () => {
      if (!requireProtobufs()) return;
      const result = await service.createNodeInfo({
        nodeNum: 444555666,
        user: {
          id: '!1a7f8e12',
          longName: 'Full Test Node',
          shortName: 'FULL',
          hwModel: 14,
          role: 1,
        },
        position: {
          latitude: 40.7128,
          longitude: -74.006,
          altitude: 10,
          time: 1702300000,
        },
        deviceMetrics: {
          batteryLevel: 85,
          voltage: 4.1,
          channelUtilization: 2.5,
          airUtilTx: 1.2,
        },
        snr: 8.5,
        lastHeard: 1702300100,
        hopsAway: 2,
        viaMqtt: true,
        isFavorite: true,
      });

      expect(result).not.toBeNull();

      const decoded = decodeFromRadio(result!);
      expect(decoded.nodeInfo).toBeDefined();
      expect(decoded.nodeInfo.num).toBe(444555666);
      expect(decoded.nodeInfo.viaMqtt).toBe(true);
      expect(decoded.nodeInfo.isFavorite).toBe(true);
      expect(decoded.nodeInfo.hopsAway).toBe(2);
      expect(decoded.nodeInfo.snr).toBeCloseTo(8.5, 1);
      expect(decoded.nodeInfo.lastHeard).toBe(1702300100);
      expect(decoded.nodeInfo.user).toBeDefined();
      expect(decoded.nodeInfo.user.longName).toBe('Full Test Node');
      expect(decoded.nodeInfo.position).toBeDefined();
      expect(decoded.nodeInfo.deviceMetrics).toBeDefined();
    });
  });

  // Regression guard for firmware 2.8 (issue #3548). The 2.8 NodeDB stores SNR
  // as Q4 (dB×4, integer) in the ON-DISK deviceonly.proto NodeInfoLite, but the
  // OVER-THE-AIR mesh.proto NodeInfo that MeshMonitor decodes keeps `float snr`.
  // If a future protobufs bump ever leaked snr_q4 / integer quantization into the
  // OTA path, this test would catch it. MeshMonitor must keep reading snr as a
  // float in dB — do NOT add an snr_q4 conversion to the TCP decode path.
  describe('OTA NodeInfo.snr stays a float (2.8 snr_q4 guard, #3548)', () => {
    it('round-trips a fractional SNR that integer quantization would mangle', async () => {
      if (!requireProtobufs()) return;
      // -7.25 is not an integer and not a clean Q4 step → any accidental
      // int/quantized handling would visibly change the decoded value.
      const result = await service.createNodeInfo({
        nodeNum: 0x0badf00d,
        user: { id: '!0badf00d', longName: 'SNR Node', shortName: 'SNR', hwModel: 1 },
        snr: -7.25,
        lastHeard: 1702300100,
      });
      expect(result).not.toBeNull();

      const parsed = service.parseIncomingData(result!);
      expect(parsed?.type).toBe('nodeInfo');
      expect(typeof parsed!.data.snr).toBe('number');
      expect(parsed!.data.snr).toBeCloseTo(-7.25, 2);
      expect(Number.isInteger(parsed!.data.snr)).toBe(false);
      // The OTA NodeInfo must not carry the on-disk-only snr_q4 field.
      expect(parsed!.data.snrQ4).toBeUndefined();
    });
  });

  // ClientNotification dispatch (firmware warnings incl. 2.8 favorite/ignore cap
  // refusals). Confirms the real protobuf field maps through parseIncomingData;
  // the suppression/throttle/reconciliation policy is unit-tested separately in
  // clientNotificationPolicy.test.ts.
  describe('FromRadio.ClientNotification dispatch', () => {
    function encodeClientNotification(fields: Record<string, unknown>): Uint8Array {
      const root = getProtobufRoot()!;
      const FromRadio = root.lookupType('meshtastic.FromRadio');
      const msg = FromRadio.create({ clientNotification: fields });
      return FromRadio.encode(msg).finish();
    }

    it('parses a plain warning into a clientNotification result', () => {
      if (!requireProtobufs()) return;
      const data = encodeClientNotification({
        level: 30, // WARNING
        message: "Can't favorite 0xdeadbeef: protected-node limit (118) reached",
      });
      const parsed = service.parseIncomingData(data);
      expect(parsed?.type).toBe('clientNotification');
      expect(parsed!.data.level).toBe(30);
      expect(parsed!.data.message).toContain('protected-node limit');
      expect(parsed!.data.isKeyVerification).toBe(false);
    });

    it('flags key-verification variants so the manager can skip toasting them', () => {
      if (!requireProtobufs()) return;
      const data = encodeClientNotification({
        level: 30,
        message: 'Enter Security Number for Key Verification',
        keyVerificationNumberRequest: { nonce: 1, remoteLongname: 'Peer' },
      });
      const parsed = service.parseIncomingData(data);
      expect(parsed?.type).toBe('clientNotification');
      expect(parsed!.data.isKeyVerification).toBe(true);
    });
  });

  describe('decodeServiceEnvelope', () => {
    it('decodes a valid ServiceEnvelope with packet', () => {
      if (!protobufInitialized) return;

      const root = getProtobufRoot();
      const ServiceEnvelope = root!.lookupType('meshtastic.ServiceEnvelope');
      const MeshPacket = root!.lookupType('meshtastic.MeshPacket');

      const packet = MeshPacket.create({
        from: 0x12345678,
        to: 0xFFFFFFFF,
        id: 42,
        encrypted: new Uint8Array([1, 2, 3]),
      });

      const envelope = ServiceEnvelope.create({
        packet: packet,
        channelId: 'LongFast',
        gatewayId: '!aabbccdd',
      });

      const encoded = ServiceEnvelope.encode(envelope).finish();
      const result = service.decodeServiceEnvelope(new Uint8Array(encoded));

      expect(result).not.toBeNull();
      expect(result!.packet).toBeDefined();
      expect(result!.packet.from).toBe(0x12345678);
      expect(result!.packet.id).toBe(42);
      expect(result!.channelId).toBe('LongFast');
      expect(result!.gatewayId).toBe('!aabbccdd');
    });

    it('returns null for invalid data', () => {
      if (!protobufInitialized) return;

      const result = service.decodeServiceEnvelope(new Uint8Array([0xFF, 0xFF, 0xFF]));
      // protobuf may decode garbage without throwing — check result is valid or null
      expect(result === null || result.packet === undefined || result.packet === null).toBeTruthy();
    });

    it('returns null for envelope without packet', () => {
      if (!protobufInitialized) return;

      const root = getProtobufRoot();
      const ServiceEnvelope = root!.lookupType('meshtastic.ServiceEnvelope');
      const envelope = ServiceEnvelope.create({
        channelId: 'LongFast',
        gatewayId: '!aabbccdd',
      });
      const encoded = ServiceEnvelope.encode(envelope).finish();
      const result = service.decodeServiceEnvelope(new Uint8Array(encoded));
      expect(result).toBeNull();
    });

    it('returns null for empty data', () => {
      if (!protobufInitialized) return;

      const result = service.decodeServiceEnvelope(new Uint8Array(0));
      expect(result).toBeNull();
    });
  });

  describe('processPayload - STORE_FORWARD_APP', () => {
    it('decodes a ROUTER_HEARTBEAT payload', () => {
      if (!requireProtobufs()) return;

      const root = getProtobufRoot()!;
      const StoreAndForward = root.lookupType('meshtastic.StoreAndForward');
      const payload = StoreAndForward.encode(StoreAndForward.create({
        rr: 2, // ROUTER_HEARTBEAT
        heartbeat: { period: 900, secondary: 0 },
      })).finish();

      const result = service.processPayload(65, payload as any);
      expect(result).toBeDefined();
      expect(result.rr).toBe(2);
      expect(result.heartbeat).toBeDefined();
      expect(result.heartbeat.period).toBe(900);
    });

    it('decodes a ROUTER_TEXT_DIRECT payload', () => {
      if (!requireProtobufs()) return;

      const root = getProtobufRoot()!;
      const StoreAndForward = root.lookupType('meshtastic.StoreAndForward');
      const textBytes = new TextEncoder().encode('Hello from S&F');
      const payload = StoreAndForward.encode(StoreAndForward.create({
        rr: 8, // ROUTER_TEXT_DIRECT
        text: textBytes,
      })).finish();

      const result = service.processPayload(65, payload as any);
      expect(result).toBeDefined();
      expect(result.rr).toBe(8);
      expect(result.text).toBeDefined();
      const decoded = new TextDecoder('utf-8').decode(
        result.text instanceof Uint8Array ? result.text : new Uint8Array(result.text)
      );
      expect(decoded).toBe('Hello from S&F');
    });

    it('decodes a ROUTER_TEXT_BROADCAST payload', () => {
      if (!requireProtobufs()) return;

      const root = getProtobufRoot()!;
      const StoreAndForward = root.lookupType('meshtastic.StoreAndForward');
      const textBytes = new TextEncoder().encode('Broadcast replay');
      const payload = StoreAndForward.encode(StoreAndForward.create({
        rr: 9, // ROUTER_TEXT_BROADCAST
        text: textBytes,
      })).finish();

      const result = service.processPayload(65, payload as any);
      expect(result).toBeDefined();
      expect(result.rr).toBe(9);
    });

    it('decodes a ROUTER_STATS payload', () => {
      if (!requireProtobufs()) return;

      const root = getProtobufRoot()!;
      const StoreAndForward = root.lookupType('meshtastic.StoreAndForward');
      const payload = StoreAndForward.encode(StoreAndForward.create({
        rr: 7, // ROUTER_STATS
        stats: {
          messagesTotal: 500,
          messagesSaved: 100,
          messagesMax: 200,
          upTime: 86400,
          requests: 10,
          requestsHistory: 5,
          heartbeat: true,
          returnMax: 50,
          returnWindow: 120,
        },
      })).finish();

      const result = service.processPayload(65, payload as any);
      expect(result).toBeDefined();
      expect(result.rr).toBe(7);
      expect(result.stats).toBeDefined();
      expect(result.stats.messagesTotal).toBe(500);
      expect(result.stats.messagesSaved).toBe(100);
      expect(result.stats.upTime).toBe(86400);
    });

    it('decodes a ROUTER_HISTORY payload', () => {
      if (!requireProtobufs()) return;

      const root = getProtobufRoot()!;
      const StoreAndForward = root.lookupType('meshtastic.StoreAndForward');
      const payload = StoreAndForward.encode(StoreAndForward.create({
        rr: 6, // ROUTER_HISTORY
        history: { historyMessages: 15, window: 120, lastRequest: 3 },
      })).finish();

      const result = service.processPayload(65, payload as any);
      expect(result).toBeDefined();
      expect(result.rr).toBe(6);
      expect(result.history).toBeDefined();
      expect(result.history.historyMessages).toBe(15);
      expect(result.history.window).toBe(120);
    });

    it('decodes a CLIENT_HISTORY request payload', () => {
      if (!requireProtobufs()) return;

      const root = getProtobufRoot()!;
      const StoreAndForward = root.lookupType('meshtastic.StoreAndForward');
      const payload = StoreAndForward.encode(StoreAndForward.create({
        rr: 65, // CLIENT_HISTORY
        history: { window: 60 },
      })).finish();

      const result = service.processPayload(65, payload as any);
      expect(result).toBeDefined();
      expect(result.rr).toBe(65);
    });
  });

  // MeshBeacon (firmware 2.8+, #3854): MESH_BEACON_APP payloads decode via the
  // 2.8-preview protobufs pin (#4205).
  describe('processPayload - MESH_BEACON_APP', () => {
    it('decodes a text-only beacon', () => {
      if (!requireProtobufs()) return;

      const root = getProtobufRoot()!;
      const MeshBeacon = root.lookupType('meshtastic.MeshBeacon');
      const payload = MeshBeacon.encode(MeshBeacon.create({
        message: 'Join our mesh!',
      })).finish();

      const result = service.processPayload(37, payload as any);
      expect(result).toBeDefined();
      expect(result.message).toBe('Join our mesh!');
    });

    it('decodes a beacon with a channel/preset offer', () => {
      if (!requireProtobufs()) return;

      const root = getProtobufRoot()!;
      const MeshBeacon = root.lookupType('meshtastic.MeshBeacon');
      const payload = MeshBeacon.encode(MeshBeacon.create({
        message: 'Community mesh nearby',
        offerChannel: { name: 'Community', psk: new Uint8Array([1]) },
        offerRegion: 1, // US
        offerPreset: 4, // MEDIUM_FAST
      })).finish();

      const result = service.processPayload(37, payload as any);
      expect(result).toBeDefined();
      expect(result.message).toBe('Community mesh nearby');
      expect(result.offerChannel?.name).toBe('Community');
      expect(result.offerPreset).toBe(4);
    });

    it('returns the raw payload (not a crash) for malformed beacon bytes', () => {
      if (!requireProtobufs()) return;

      // Truncated/garbage bytes: processPayload catches decode errors and
      // falls back to returning the raw payload bytes (not a decoded object).
      const garbage = Uint8Array.from([0x0a, 0xff, 0xff]);
      const result = service.processPayload(37, garbage as any);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result as Uint8Array)).toEqual([0x0a, 0xff, 0xff]);
    });
  });

  // TAKPacket (ATAK plugin, portnum 72): PLI/GeoChat/detail oneof decode +
  // formatTakPreview one-line summaries for the Packet Monitor (ATAK/CoT
  // Phase 1, WP1). V2 (78) and Forwarder (257) are intentionally NOT decoded
  // here — that is asserted via passthrough below.
  describe('TAKPacket / ATAK', () => {
    function encodeTak(fields: Record<string, unknown>): Uint8Array {
      const root = getProtobufRoot()!;
      const TAKPacket = root.lookupType('meshtastic.TAKPacket');
      return TAKPacket.encode(TAKPacket.create(fields)).finish();
    }

    it('decodes a PLI variant and formats a coordinate preview', () => {
      if (!requireProtobufs()) return;

      const payload = encodeTak({
        contact: { callsign: 'FALKE' },
        pli: { latitudeI: 371234500, longitudeI: -1225432100, altitude: 10, speed: 3, course: 90 },
      });

      const result = service.processPayload(72, payload as any);
      expect(result).toBeDefined();
      expect(result.pli).toBeDefined();
      expect(formatTakPreview(result, payload.length)).toBe('[ATAK PLI FALKE: 37.12345°, -122.54321°]');
    });

    it('decodes a GeoChat variant and formats a message preview', () => {
      if (!requireProtobufs()) return;

      const payload = encodeTak({
        contact: { callsign: 'ALPHA' },
        chat: { message: 'moving out' },
      });

      const result = service.processPayload(72, payload as any);
      expect(result).toBeDefined();
      expect(result.chat).toBeDefined();
      expect(formatTakPreview(result, payload.length)).toBe('[ATAK GeoChat ALPHA: "moving out"]');
    });

    it('formats a GeoChat receipt (delivered/read ack) distinctly, not as chat text', () => {
      if (!requireProtobufs()) return;

      const payload = encodeTak({
        contact: { callsign: 'ALPHA' },
        chat: { message: '', receiptType: 1, receiptForUid: 'x' },
      });

      const result = service.processPayload(72, payload as any);
      expect(formatTakPreview(result, payload.length)).toBe('[ATAK GeoChat receipt ALPHA]');
    });

    it('decodes a detail (raw bytes) variant and formats a byte-count preview', () => {
      if (!requireProtobufs()) return;

      const payload = encodeTak({ detail: new Uint8Array([1, 2, 3]) });

      const result = service.processPayload(72, payload as any);
      expect(result).toBeDefined();
      expect(formatTakPreview(result, payload.length)).toBe('[ATAK detail: 3 bytes]');
    });

    it('formats a compressed GeoChat without leaking unishox2 bytes as text', () => {
      if (!requireProtobufs()) return;

      const payload = encodeTak({
        isCompressed: true,
        chat: { message: '\x01\x02garbage' },
      });

      const result = service.processPayload(72, payload as any);
      expect(formatTakPreview(result, payload.length)).toBe('[ATAK GeoChat (compressed)]');
    });

    it('does NOT decode ATAK_PLUGIN_V2 (port 78) - returns the raw payload', () => {
      if (!requireProtobufs()) return;

      const someBytes = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
      const result = service.processPayload(78, someBytes as any);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result as Uint8Array)).toEqual([0x10, 0x20, 0x30, 0x40]);
    });

    it('does not throw on malformed TAKPacket bytes and previews as undecodable', () => {
      if (!requireProtobufs()) return;

      const garbage = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
      let result: any;
      expect(() => { result = service.processPayload(72, garbage as any); }).not.toThrow();
      expect(result).toBeDefined();
      expect(formatTakPreview(result, garbage.length)).toBe('[ATAK packet, 4 bytes (undecodable)]');
    });
  });
});
