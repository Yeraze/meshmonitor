/**
 * Left-home Test panel input-mode helpers.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import {
  leftHomeInputMode,
  leftHomeModeHint,
  leftHomeThresholdFromConfig,
} from './automationTesterHelpers';

describe('leftHome test input helpers', () => {
  it('reads threshold from the automation config (default 300)', () => {
    expect(leftHomeThresholdFromConfig({
      nodes: [{ type: 'trigger.leftHome', params: { thresholdMeters: 250 } }],
    })).toBe(250);
    expect(leftHomeThresholdFromConfig({ nodes: [{ type: 'trigger.leftHome', params: {} }] })).toBe(300);
    expect(leftHomeThresholdFromConfig(null)).toBe(300);
  });

  it('coordinates win when home + current lat/lon are all set', () => {
    expect(leftHomeInputMode(
      { homeLat: '1', homeLon: '2', distanceMeters: '999' },
      { latitude: '3', longitude: '4' },
    )).toBe('coordinates');
  });

  it('falls back to distance when coords are incomplete', () => {
    expect(leftHomeInputMode(
      { homeLat: '1', distanceMeters: '80' },
      { latitude: '3', longitude: '4' },
    )).toBe('distance');
    expect(leftHomeInputMode({ distanceMeters: '80' }, {})).toBe('distance');
  });

  it('hint names the active path and the automation threshold', () => {
    const coords = leftHomeModeHint(
      { homeLat: '1', homeLon: '2', distanceMeters: '999' },
      { latitude: '3', longitude: '4' },
      150,
    );
    expect(coords).toMatch(/150 m/);
    expect(coords).toMatch(/coordinates/i);
    expect(coords).toMatch(/ignored/i);

    const dist = leftHomeModeHint({ distanceMeters: '80' }, {}, 150);
    expect(dist).toMatch(/distance field/);
    expect(dist).toMatch(/80/);
  });
});
