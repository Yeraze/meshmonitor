import { describe, it, expect } from 'vitest';
import {
  normalizeMeshCoreBrokerConfig,
  validateMeshCoreBrokerConfig,
  targetPointsAtListener,
  MESHCORE_BROKER_DEFAULT_MAX_CLIENTS,
  MESHCORE_BROKER_DEFAULT_MSGS_PER_SEC,
  MESHCORE_BROKER_DEFAULT_MAX_PAYLOAD,
} from './meshcoreMqttBrokerConfig.js';

const KEY = 'AB'.repeat(32);

describe('meshcore broker config', () => {
  it('fills the binding v1 defaults: 50 clients, 20 msg/s, 64 KB', () => {
    const n = normalizeMeshCoreBrokerConfig({ listener: { port: 1884 }, auth: { tokenAudience: 'a' } });
    expect(n.maxClients).toBe(MESHCORE_BROKER_DEFAULT_MAX_CLIENTS);
    expect(MESHCORE_BROKER_DEFAULT_MAX_CLIENTS).toBe(50);
    expect(n.maxMessagesPerSecond).toBe(MESHCORE_BROKER_DEFAULT_MSGS_PER_SEC);
    expect(MESHCORE_BROKER_DEFAULT_MSGS_PER_SEC).toBe(20);
    expect(n.maxPayloadBytes).toBe(MESHCORE_BROKER_DEFAULT_MAX_PAYLOAD);
    expect(MESHCORE_BROKER_DEFAULT_MAX_PAYLOAD).toBe(65536);
    expect(n.targets).toEqual([]);
  });

  it('upper-cases keys and regions and keeps only enabled forwarding targets', () => {
    const n = normalizeMeshCoreBrokerConfig({
      listener: { port: 1884 },
      auth: { tokenAudience: 'a', allowedObservers: [KEY.toLowerCase(), 'junk'] },
      regions: ['sea', 'bad region'],
      forwarding: {
        targets: [
          { id: 'on', enabled: true, url: 'mqtt://up:1883', identityMode: 'own', observers: [KEY.toLowerCase()] },
          { id: 'off', url: 'mqtt://up2:1883', identityMode: 'passthrough' },
        ],
      },
    });
    expect([...n.allowedObservers]).toEqual([KEY]);
    expect([...n.regions]).toEqual(['SEA']);
    expect(n.targets.map((t) => t.id)).toEqual(['on']);
    expect([...n.targets[0].observers]).toEqual([KEY]);
  });

  it('refuses a config with no way to log in (anonymous is never allowed)', () => {
    expect(validateMeshCoreBrokerConfig({ listener: { port: 1884 }, auth: {} })).toMatch(/anonymous/);
    expect(validateMeshCoreBrokerConfig({ listener: { port: 1884 }, auth: { password: 'p' } })).toMatch(/username/);
    expect(validateMeshCoreBrokerConfig({ listener: { port: 1884 }, auth: { username: 'u', password: 'p' } })).toBeNull();
  });

  it('refuses bad ports, limits, keys and regions', () => {
    const auth = { tokenAudience: 'a' };
    expect(validateMeshCoreBrokerConfig({ listener: { port: 0 }, auth })).toMatch(/port/);
    expect(validateMeshCoreBrokerConfig({ listener: { port: 1884 }, auth, limits: { maxClients: 0 } })).toMatch(/maxClients/);
    expect(validateMeshCoreBrokerConfig({ listener: { port: 1884 }, auth, limits: { maxMessagesPerSecond: 10_000 } })).toMatch(
      /maxMessagesPerSecond/,
    );
    expect(
      validateMeshCoreBrokerConfig({ listener: { port: 1884 }, auth: { ...auth, allowedObservers: ['nothex'] } }),
    ).toMatch(/64-character/);
    expect(validateMeshCoreBrokerConfig({ listener: { port: 1884 }, auth, regions: ['a b'] })).toMatch(/IATA/);
  });

  it('refuses a forwarding target that points back at its own listener', () => {
    const cfg = (url: string) => ({
      listener: { port: 1884 },
      auth: { tokenAudience: 'a' },
      forwarding: { targets: [{ id: 't', enabled: true, url, identityMode: 'passthrough' }] },
    });
    expect(validateMeshCoreBrokerConfig(cfg('mqtt://127.0.0.1:1884'))).toMatch(/own listener/);
    expect(validateMeshCoreBrokerConfig(cfg('localhost:1884'))).toMatch(/own listener/);
    expect(validateMeshCoreBrokerConfig(cfg('mqtt://upstream.example:1884'))).toBeNull();
    expect(targetPointsAtListener('mqtt://localhost', 1883)).toBe(true);
  });

  it('needs a token audience on an enabled own-identity target', () => {
    const err = validateMeshCoreBrokerConfig({
      listener: { port: 1884 },
      auth: { tokenAudience: 'a' },
      forwarding: { targets: [{ id: 't', enabled: true, url: 'mqtt://up:1883', identityMode: 'own' }] },
    });
    expect(err).toMatch(/token audience/);
  });
});
