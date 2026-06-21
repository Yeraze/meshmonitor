import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the TCP transport so constructing a manager never touches a real socket.
vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    removeAllListeners = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

// Prevent the constructor's async paths from touching the DB. The settings
// override getters return null so the legacy/default path falls through to the
// env default — letting us prove a CONFIGURED source never reaches that path.
vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
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
import { resetEnvironmentConfig } from './config/environment.js';

const ENV_DEFAULT_IP = '192.168.1.100';

describe('MeshtasticManager — reconnect uses the per-source configured address (#3611)', () => {
  beforeEach(() => {
    // Ensure the env literal is the active default so any accidental fall-through
    // would surface the wrong IP. Reset the cached env config so the env var
    // change takes effect (getEnvironmentConfig caches after first load).
    delete process.env.MESHTASTIC_NODE_IP;
    resetEnvironmentConfig();
  });

  it('getConnectionStatus().nodeIp returns the source host, not the env default', async () => {
    const mgr = new MeshtasticManager('src-1', { host: '10.20.30.40', port: 4403 });
    const status = await mgr.getConnectionStatus();
    expect(status.nodeIp).toBe('10.20.30.40');
    expect(status.nodeIp).not.toBe(ENV_DEFAULT_IP);
  });

  it('still reports the source host after a (simulated) reconnect', async () => {
    const mgr = new MeshtasticManager('src-2', { host: 'mesh.example.lan', port: 4404 });

    // A reconnect tears down the transport and re-reads config. Resolve config
    // both before and after to prove the per-source value is stable and never
    // drifts to the env default.
    const before = await mgr.getConnectionStatus();
    (mgr as any).transport = null; // mimic the post-teardown window inside connect()
    const after = await mgr.getConnectionStatus();

    expect(before.nodeIp).toBe('mesh.example.lan');
    expect(after.nodeIp).toBe('mesh.example.lan');
    expect(after.nodeIp).not.toBe(ENV_DEFAULT_IP);
  });

  it('a source configured via configureSource() also resolves to its own host', async () => {
    // The legacy singleton path: a fresh manager that is later configured from a
    // DB source record must use that record's host, not the env default.
    const mgr = new MeshtasticManager('default');
    mgr.configureSource({ host: '172.16.5.5', port: 4403 }, 'src-3');
    const status = await mgr.getConnectionStatus();
    expect(status.nodeIp).toBe('172.16.5.5');
    expect(status.nodeIp).not.toBe(ENV_DEFAULT_IP);
  });

  it('a truly-unconfigured manager (no source override) still honors the env default', async () => {
    process.env.MESHTASTIC_NODE_IP = '198.51.100.7';
    resetEnvironmentConfig();
    const mgr = new MeshtasticManager(); // no sourceConfig → legacy/env path
    const status = await mgr.getConnectionStatus();
    expect(status.nodeIp).toBe('198.51.100.7');
  });
});
