import { describe, it, expect } from 'vitest';
import { channelFingerprint, channelKey, unifyChannels } from './channelUnify.js';

describe('channelFingerprint', () => {
  it('is stable, key-dependent, and hides the raw psk', () => {
    expect(channelFingerprint('SECRET')).toBe(channelFingerprint('SECRET'));
    expect(channelFingerprint('SECRET')).not.toBe(channelFingerprint('OTHER'));
    expect(channelFingerprint('SECRET')).not.toContain('SECRET');
    expect(channelFingerprint('')).toBe(channelFingerprint(null)); // empty/none normalize together
    expect(channelFingerprint('SECRET')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('unifyChannels', () => {
  const A = { sourceId: 'A', sourceName: 'Alpha', channels: [
    { id: 0, name: 'Primary', psk: 'AQ==' },
    { id: 2, name: 'gauntlet', psk: 'SECRET' },
  ] };
  const B = { sourceId: 'B', sourceName: 'Bravo', channels: [
    { id: 0, name: 'Primary', psk: 'AQ==' },
    { id: 5, name: 'gauntlet', psk: 'SECRET' },     // same name+key, different slot
    { id: 6, name: 'gauntlet', psk: 'DIFFERENT' },  // same name, DIFFERENT key → distinct
  ] };

  it('groups by name + key fingerprint, recording each source slot', () => {
    const unified = unifyChannels([A, B]);
    const gauntletSame = unified.find((u) => u.name === 'gauntlet' && u.fp === channelFingerprint('SECRET'));
    expect(gauntletSame).toBeTruthy();
    expect(gauntletSame!.sources).toEqual([
      { sourceId: 'A', sourceName: 'Alpha', slot: 2 },
      { sourceId: 'B', sourceName: 'Bravo', slot: 5 },
    ]);
  });

  it('keeps same-name / different-key channels separate', () => {
    const unified = unifyChannels([A, B]);
    const gauntlets = unified.filter((u) => u.name === 'gauntlet');
    expect(gauntlets).toHaveLength(2); // SECRET and DIFFERENT
    expect(channelKey('gauntlet', channelFingerprint('SECRET')))
      .not.toBe(channelKey('gauntlet', channelFingerprint('DIFFERENT')));
  });

  it('does not expose the raw psk', () => {
    const json = JSON.stringify(unifyChannels([A, B]));
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('DIFFERENT');
  });
});
