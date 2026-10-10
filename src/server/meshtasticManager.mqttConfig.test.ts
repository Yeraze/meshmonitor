/**
 * getCurrentConfig().moduleConfig.mqtt, the local Device Configuration load.
 *
 * The node's MQTTConfig arrives as a decoded protobufjs message. getCurrentConfig
 * used to spread it, which left mapReportSettings a Message whose toJSON (run by
 * res.json) drops 0 and false. The form then never saw the location consent and
 * read a stored precision of 0 as missing (and loaded it as 14). Every field must
 * now reach the JSON reply, stated.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Stub the TCP transport so constructing a manager never touches a real socket
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

// Prevent the constructor's async position-recalc path from touching the DB
vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: {
      getSource: vi.fn().mockResolvedValue(null),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

import { MeshtasticManager } from './meshtasticManager.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

function decodeMqtt(fields: Record<string, unknown>) {
  const MQTTConfig = getProtobufRoot()!.lookupType('meshtastic.ModuleConfig.MQTTConfig');
  return MQTTConfig.decode(MQTTConfig.encode(MQTTConfig.create(fields)).finish());
}

/** What the browser gets: the reply goes through res.json(). */
function loadedMqtt(mqtt: unknown) {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).actualModuleConfig = { mqtt };
  return JSON.parse(JSON.stringify(mgr.getCurrentConfig().moduleConfig.mqtt));
}

describe('getCurrentConfig: MQTT module config', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('states every field, with a stored precision of 0 and the location consent', () => {
    const MapReportSettings = getProtobufRoot()!.lookupType('meshtastic.ModuleConfig.MapReportSettings');
    const raw = decodeMqtt({
      enabled: true,
      address: 'mqtt.example.org',
      root: 'msh/US',
      mapReportingEnabled: false,
      mapReportSettings: MapReportSettings.create({ publishIntervalSecs: 3600, positionPrecision: 0, shouldReportLocation: true }),
    });

    expect(loadedMqtt(raw)).toEqual({
      enabled: true,
      address: 'mqtt.example.org',
      username: '',
      password: '',
      encryptionEnabled: false,
      jsonEnabled: false,
      tlsEnabled: false,
      root: 'msh/US',
      proxyToClientEnabled: false,
      mapReportingEnabled: false,
      mapReportSettings: { publishIntervalSecs: 3600, positionPrecision: 0, shouldReportLocation: true },
    });
  });

  it('a node with encryption off loads it as off', () => {
    expect(loadedMqtt(decodeMqtt({ enabled: true, encryptionEnabled: false })).encryptionEnabled).toBe(false);
    expect(loadedMqtt(decodeMqtt({ enabled: true, encryptionEnabled: true })).encryptionEnabled).toBe(true);
  });

  it('reads the plain object a local save caches back the same way', () => {
    const saved = {
      enabled: true, address: 'a', username: 'u', password: 'p', encryptionEnabled: true, jsonEnabled: true,
      tlsEnabled: true, root: 'r', proxyToClientEnabled: true, mapReportingEnabled: true,
      mapReportSettings: { publishIntervalSecs: 7200, positionPrecision: 12, shouldReportLocation: true },
    };
    expect(loadedMqtt(saved)).toEqual(saved);
  });
});
