import { describe, it, expect } from 'vitest';
import { applyRootToSubscriptions, defaultBridgeRegionRoot, defaultDeviceRegionRoot } from './mqttRootDefaults';

describe('defaultDeviceRegionRoot', () => {
  it('uses msh/<region> from the radio', () => {
    expect(defaultDeviceRegionRoot('', 1)).toBe('msh/US');
    expect(defaultDeviceRegionRoot('msh/US/WA/Seattle', 3)).toBe('msh/EU_868');
  });
  it('keeps a non-msh prefix', () => {
    expect(defaultDeviceRegionRoot('mesh/DE/BY', 3)).toBe('mesh/DE');
  });
  it('falls back to msh/US', () => {
    expect(defaultDeviceRegionRoot('', undefined)).toBe('msh/US');
  });
});

describe('defaultBridgeRegionRoot', () => {
  it('takes the first two segments of the first subscription', () => {
    expect(defaultBridgeRegionRoot('msh/US/TX/#\nmsh/EU_868/#')).toBe('msh/US');
    expect(defaultBridgeRegionRoot('')).toBe('msh/US');
  });
});

describe('applyRootToSubscriptions', () => {
  it('replaces a single <old>/# line', () => {
    expect(applyRootToSubscriptions('msh/US/TX/#', 'msh/US/WA')).toBe('msh/US/WA/#');
  });
  it('appends when there are several lines, once', () => {
    expect(applyRootToSubscriptions('msh/US/TX/#\nmsh/EU_868/#', 'msh/US/WA')).toBe(
      'msh/US/TX/#\nmsh/EU_868/#\nmsh/US/WA/#',
    );
    expect(applyRootToSubscriptions('a/#\nmsh/US/WA/#', 'msh/US/WA')).toBe('a/#\nmsh/US/WA/#');
  });
  it('fills an empty box', () => {
    expect(applyRootToSubscriptions('', 'msh/US/WA')).toBe('msh/US/WA/#');
  });
});
