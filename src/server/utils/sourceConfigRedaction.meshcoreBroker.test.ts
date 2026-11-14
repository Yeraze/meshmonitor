/**
 * Config redaction for the embedded MeshCore MQTT broker source (#6197): no
 * password reaches a viewer or an editor, a viewer never learns where observer
 * data is forwarded, and an editor's blank password keeps the stored one only
 * while the target URL is unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  projectSourceConfig,
  maskSourceConfigForEditor,
  mergeSourceConfigOnSave,
} from './sourceConfigRedaction.js';

const KEY = 'AB'.repeat(32);
const STORED = {
  listener: { port: 1884, host: '0.0.0.0' },
  auth: { tokenAudience: 'aud', allowedObservers: [KEY], username: 'local', password: 'local-secret' },
  regions: ['SEA'],
  limits: { maxClients: 50 },
  forwarding: {
    ownIdentityName: 'MM',
    targets: [
      {
        id: 't1',
        enabled: true,
        url: 'mqtt://upstream.example:1883',
        identityMode: 'passthrough',
        username: 'up',
        password: 'up-secret',
        observers: [KEY],
      },
    ],
  },
  autoConnect: true,
};

describe('meshcore_mqtt_broker config redaction', () => {
  it('shows a viewer the port and regions, never secrets, allowlist or targets', () => {
    const viewer = projectSourceConfig('meshcore_mqtt_broker', STORED, 'viewer');
    expect(viewer).toEqual({ listener: { port: 1884, host: '0.0.0.0' }, regions: ['SEA'], autoConnect: true });
    const pub = projectSourceConfig('meshcore_mqtt_broker', STORED, 'public');
    expect(JSON.stringify(pub)).not.toMatch(/secret|upstream|1884/);
  });

  it('masks both passwords for an editor', () => {
    const { config, masked } = maskSourceConfigForEditor('meshcore_mqtt_broker', STORED);
    expect(JSON.stringify(config)).not.toMatch(/secret/);
    expect(masked).toEqual(expect.arrayContaining(['auth.password', 'forwarding.targets.0.password']));
    expect((config.forwarding as { targets: Array<{ url: string }> }).targets[0].url).toBe('mqtt://upstream.example:1883');
  });

  it('keeps a stored target password on a blank save only for the same URL', () => {
    const blank = JSON.parse(JSON.stringify(STORED));
    delete blank.auth.password;
    delete blank.forwarding.targets[0].password;
    const kept = mergeSourceConfigOnSave('meshcore_mqtt_broker', STORED, blank, 'editor') as typeof STORED;
    expect(kept.auth.password).toBe('local-secret');
    expect(kept.forwarding.targets[0].password).toBe('up-secret');

    blank.forwarding.targets[0].url = 'mqtt://attacker.example:1883';
    const moved = mergeSourceConfigOnSave('meshcore_mqtt_broker', STORED, blank, 'editor') as typeof STORED;
    expect(moved.forwarding.targets[0].password).toBeUndefined();
  });
});
