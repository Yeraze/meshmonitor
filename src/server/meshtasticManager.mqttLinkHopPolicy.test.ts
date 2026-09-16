/**
 * The mqttLink egress path honors the linked broker's hop-limit policy
 * (#5188, #5190).
 *
 * There are two ways a packet reaches a radio from an embedded broker: the
 * radio subscribes over MQTT (Aedes `authorizeForward`), or a TCP-connected
 * device is fed `ToRadio.mqttClientProxyMessage` from the broker's
 * `local-packet` event. That event deliberately carries the *untransformed*
 * payload, because ingestion and the uplink bridge must see the wire bytes as
 * they arrived — so this path has to apply the transform itself. Without it a
 * clamp or raise silently does nothing on the mqttLink topology.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./virtualNodeServer.js', () => ({
  VirtualNodeServer: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSettingForSource: vi.fn().mockResolvedValue(null),
    },
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: { getAllNodes: vi.fn().mockResolvedValue([]) },
  };
  return { default: shared, databaseService: shared };
});

const encodeToRadio = vi.fn((_args: { topic: string; data: Uint8Array; retained: boolean }) => new Uint8Array([0x01, 0x02]));
vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    encodeToRadioMqttClientProxyMessage: (args: { topic: string; data: Uint8Array; retained: boolean }) =>
      encodeToRadio(args),
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: unknown) => (typeof n === 'number' ? n : 0),
  };
  return { default: svc, meshtasticProtobufService: svc };
});

vi.mock('./services/packetLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
  packetLogService: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { isEnabled: () => false, tryDecrypt: vi.fn() },
}));

import { MeshtasticManager } from './meshtasticManager.js';

const ORIGINAL = Buffer.from([0xaa, 0xbb]);
const TRANSFORMED = Buffer.from([0xcc, 0xdd]);

function makeManager(broker: unknown): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };
  (mgr as any).isConnected = true;
  (mgr as any).mqttLinkBroker = broker;
  return mgr;
}

function localPacket() {
  return {
    topic: 'msh/US/2/e/LongFast/!12345678',
    payload: ORIGINAL,
    retained: false,
    envelope: { packet: { id: 0xabcdef01 } },
    clientId: 'dev',
  };
}

beforeEach(() => {
  encodeToRadio.mockClear();
});

describe('mqttLink egress applies the linked broker hop-limit policy', () => {
  it('injects the transformed payload when the broker rewrites it', async () => {
    const transformForwardedPayload = vi.fn(() => TRANSFORMED);
    const mgr = makeManager({ transformForwardedPayload });

    await (mgr as any).handleLinkedBrokerLocalPacket(localPacket());

    expect(transformForwardedPayload).toHaveBeenCalledWith('msh/US/2/e/LongFast/!12345678', ORIGINAL);
    expect(Buffer.from(encodeToRadio.mock.calls[0]![0].data)).toEqual(TRANSFORMED);
  });

  it('injects the original payload when the policy is a no-op', async () => {
    const mgr = makeManager({ transformForwardedPayload: vi.fn(() => null) });

    await (mgr as any).handleLinkedBrokerLocalPacket(localPacket());

    expect(Buffer.from(encodeToRadio.mock.calls[0]![0].data)).toEqual(ORIGINAL);
  });

  it('injects the original payload when the link target cannot transform', async () => {
    // A standalone mqtt_bridge exposes `local-packet` and `publish()` but no
    // hop-limit policy of its own — that topology forwards unchanged.
    const mgr = makeManager({});

    await (mgr as any).handleLinkedBrokerLocalPacket(localPacket());

    expect(Buffer.from(encodeToRadio.mock.calls[0]![0].data)).toEqual(ORIGINAL);
  });
});
