/**
 * Log lines on the mqttLink proxy path (#5013).
 *
 * "MQTT traffic never reaches my node" was hard to diagnose because the two
 * facts that settle it left no trace: whether MeshMonitor injected a broker
 * packet into the device, and whether the device's proxy traffic was being
 * dropped for want of a link. Pinned here:
 *   - a debug line per injected packet: source, topic, channel, packet id —
 *     never the payload;
 *   - one line per connection, not per packet, when proxy traffic arrives with
 *     no link attached; warn when nothing else can carry it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    decodeServiceEnvelope: () => ({ packet: { id: 7 } }),
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
import { logger } from '../utils/logger.js';

const TOPIC = 'msh/US/2/e/LongFast/!12345678';
const PAYLOAD = Buffer.from('secret-payload-bytes');

function makeManager(opts: { broker?: unknown; vnClients?: number; link?: unknown } = {}): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };
  (mgr as any).isConnected = true;
  (mgr as any).mqttLinkBroker = opts.broker ?? null;
  (mgr as any).mqttLink = opts.link ?? null;
  (mgr as any).virtualNodeServer =
    opts.vnClients === undefined ? undefined : { getClientCount: () => opts.vnClients };
  return mgr;
}

const proxyMsg = () => ({ topic: TOPIC, data: new Uint8Array(PAYLOAD), retained: false });
const linesWith = (spy: ReturnType<typeof vi.spyOn>, needle: string): string[] =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(needle));

let debugSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  encodeToRadio.mockClear();
  debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('broker → device injection log', () => {
  const packet = () => ({
    topic: TOPIC,
    payload: PAYLOAD,
    retained: false,
    envelope: { packet: { id: 0xabcdef01 }, channelId: 'LongFast' },
    clientId: 'dev',
  });

  it('logs source, topic, channel and packet id at debug, without the payload', async () => {
    const mgr = makeManager({ broker: {}, link: { enabled: true, mqttBrokerSourceId: 'broker-1' } });

    await (mgr as any).handleLinkedBrokerLocalPacket(packet());

    const lines = linesWith(debugSpy, 'injected broker message to device');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[src-1]');
    expect(lines[0]).toContain(`topic=${TOPIC}`);
    expect(lines[0]).toContain('channel=LongFast');
    expect(lines[0]).toContain(`packetId=${0xabcdef01}`);
    expect(lines[0]).toContain('from=broker-1');
    expect(lines[0]).not.toContain('secret-payload-bytes');
    expect(lines[0]).not.toContain(PAYLOAD.toString('hex'));
    expect(lines[0]).not.toContain(PAYLOAD.toString('base64'));
    // Per-packet volume: debug only.
    expect(linesWith(infoSpy, 'injected')).toHaveLength(0);
    expect(linesWith(warnSpy, 'injected')).toHaveLength(0);
  });

  it('does not claim an injection when the send fails', async () => {
    const mgr = makeManager({ broker: {} });
    (mgr as any).transport.send = vi.fn().mockRejectedValue(new Error('socket closed'));

    await (mgr as any).handleLinkedBrokerLocalPacket(packet());

    expect(linesWith(debugSpy, 'injected broker message to device')).toHaveLength(0);
    expect(linesWith(warnSpy, 'failed to inject')).toHaveLength(1);
  });

  it('does not claim an injection while the device is disconnected', async () => {
    const mgr = makeManager({ broker: {} });
    (mgr as any).isConnected = false;

    await (mgr as any).handleLinkedBrokerLocalPacket(packet());

    expect(linesWith(debugSpy, 'injected broker message to device')).toHaveLength(0);
  });
});

describe('proxy traffic with no link attached', () => {
  const NEEDLE = 'MQTT client proxy:';

  it('warns once per connection, not once per packet', async () => {
    const mgr = makeManager();

    for (let i = 0; i < 5; i++) await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());

    const lines = linesWith(warnSpy, NEEDLE);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[src-1]');
    expect(lines[0]).toContain('no MQTT source is linked');
    expect(lines[0]).toContain(`topic=${TOPIC}`);
    expect(lines[0]).not.toContain('secret-payload-bytes');
  });

  it('warns again after a reconnect', async () => {
    const mgr = makeManager();
    await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());
    expect(linesWith(warnSpy, NEEDLE)).toHaveLength(1);

    // handleConnected() clears the flag; the rest of it needs a live device.
    (mgr as any).transport = null;
    await (mgr as any).handleConnected().catch(() => {});
    (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };
    await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());
    await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());

    expect(linesWith(warnSpy, NEEDLE)).toHaveLength(2);
  });

  it('warns again when an attached link detaches mid-connection', async () => {
    const broker = { publish: vi.fn().mockResolvedValue(undefined), off: vi.fn() };
    const mgr = makeManager({ broker, link: { enabled: true, mqttBrokerSourceId: 'broker-1' } });
    // An earlier no-link spell on this connection already logged.
    (mgr as any).mqttProxyNoLinkLogged = true;
    (mgr as any).mqttLinkBrokerListener = () => {};

    // The linked source stops: setupMqttLink's manager-stopped handler calls this.
    (mgr as any).detachMqttLinkBroker();
    await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());
    await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());

    const lines = linesWith(warnSpy, NEEDLE);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('linked source broker-1 is not running');
  });

  it('names a configured link whose target is not running', async () => {
    const mgr = makeManager({ link: { enabled: true, mqttBrokerSourceId: 'broker-1' } });

    await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());

    expect(linesWith(warnSpy, NEEDLE)[0]).toContain('linked source broker-1 is not running');
  });

  it('logs at info, once, when a Virtual Node client takes the frames', async () => {
    const mgr = makeManager({ vnClients: 2 });

    await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());
    await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());

    expect(linesWith(warnSpy, NEEDLE)).toHaveLength(0);
    const lines = linesWith(infoSpy, NEEDLE);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 Virtual Node client(s)');
  });

  it('stays quiet when a link is attached', async () => {
    const mgr = makeManager({ broker: { publish: vi.fn().mockResolvedValue(undefined) } });

    await (mgr as any).handleDeviceMqttProxyMessage(proxyMsg());

    expect(linesWith(warnSpy, NEEDLE)).toHaveLength(0);
    expect(linesWith(infoSpy, NEEDLE)).toHaveLength(0);
  });
});

describe('getMqttClientProxyState', () => {
  it('is null until the MQTT module config has loaded', () => {
    expect(makeManager().getMqttClientProxyState()).toBeNull();
  });

  it('reports the device flags and the Virtual Node proxy client', () => {
    const mgr = makeManager();
    (mgr as any).actualModuleConfig = { mqtt: { enabled: true, proxyToClientEnabled: true } };
    expect(mgr.getMqttClientProxyState()).toEqual({
      mqttEnabled: true, proxyToClientEnabled: true, proxyClientAttached: false,
    });

    (mgr as any).virtualNodeServer = { hasMqttProxyClient: () => true };
    expect(mgr.getMqttClientProxyState()?.proxyClientAttached).toBe(true);

    (mgr as any).actualModuleConfig = { mqtt: { enabled: true } };
    expect(mgr.getMqttClientProxyState()?.proxyToClientEnabled).toBe(false);
  });
});
