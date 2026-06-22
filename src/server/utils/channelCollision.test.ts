import { describe, it, expect } from 'vitest';
import { detectChannelCollisions, normalizePsk } from './channelCollision.js';

describe('normalizePsk', () => {
  it('maps empty / null PSKs to null', () => {
    expect(normalizePsk(null)).toBeNull();
    expect(normalizePsk(undefined)).toBeNull();
    expect(normalizePsk('')).toBeNull();
    expect(normalizePsk('   ')).toBeNull();
  });
  it('trims but otherwise preserves a base64 PSK', () => {
    expect(normalizePsk(' AQ== ')).toBe('AQ==');
    expect(normalizePsk('1PG7OiApB1nwvP+rz05pAQ==')).toBe('1PG7OiApB1nwvP+rz05pAQ==');
  });
});

describe('detectChannelCollisions (#3644)', () => {
  it('flags a device channel sharing the default key with a differently-named DB entry', () => {
    // The reported case: device channel 0 named "Custom" on the default PSK,
    // and an auto-seeded "LongFast" channel_database entry on the same key.
    const channels = [{ id: 0, name: 'Custom', psk: 'AQ==' }];
    const db = [{ id: 5, name: 'LongFast', psk: 'AQ==' }];
    const collisions = detectChannelCollisions(channels, db);
    expect(collisions).toEqual([
      { channelId: 0, channelName: 'Custom', dbId: 5, dbName: 'LongFast' },
    ]);
  });

  it('does NOT flag a same-name same-key mirror', () => {
    const channels = [{ id: 0, name: 'LongFast', psk: 'AQ==' }];
    const db = [{ id: 5, name: 'LongFast', psk: 'AQ==' }];
    expect(detectChannelCollisions(channels, db)).toEqual([]);
  });

  it('does NOT flag when keys differ', () => {
    const channels = [{ id: 1, name: 'Secret', psk: 'aaaa' }];
    const db = [{ id: 9, name: 'Other', psk: 'bbbb' }];
    expect(detectChannelCollisions(channels, db)).toEqual([]);
  });

  it('ignores unencrypted (empty PSK) channels', () => {
    const channels = [{ id: 0, name: 'Open', psk: '' }];
    const db = [{ id: 1, name: 'Open2', psk: '' }];
    expect(detectChannelCollisions(channels, db)).toEqual([]);
  });

  it('matches a custom key regardless of surrounding whitespace', () => {
    const channels = [{ id: 2, name: 'Team', psk: 'Zm9vYmFy' }];
    const db = [{ id: 3, name: 'TeamMirror', psk: ' Zm9vYmFy ' }];
    const collisions = detectChannelCollisions(channels, db);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ channelId: 2, dbId: 3, dbName: 'TeamMirror' });
  });

  it('reports each colliding pair when multiple DB entries share a key', () => {
    const channels = [{ id: 0, name: 'Custom', psk: 'AQ==' }];
    const db = [
      { id: 5, name: 'LongFast', psk: 'AQ==' },
      { id: 6, name: 'Public', psk: 'AQ==' },
    ];
    expect(detectChannelCollisions(channels, db)).toHaveLength(2);
  });
});
