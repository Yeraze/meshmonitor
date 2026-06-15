import { describe, it, expect } from 'vitest';
import {
  VALID_MODULE_CONFIG_TYPES,
  isValidModuleConfigType,
} from './moduleConfig.js';

describe('module config type allow-list', () => {
  // Regression for #3464: statusmessage and trafficmanagement were made editable
  // in #3457 (gated on firmware version) but were missing from the generic
  // module-config save route's allow-list, so saving them returned
  // "Invalid module type". They must be accepted.
  it('accepts statusmessage and trafficmanagement (#3464)', () => {
    expect(isValidModuleConfigType('statusmessage')).toBe(true);
    expect(isValidModuleConfigType('trafficmanagement')).toBe(true);
    expect(VALID_MODULE_CONFIG_TYPES).toContain('statusmessage');
    expect(VALID_MODULE_CONFIG_TYPES).toContain('trafficmanagement');
  });

  it('accepts every generic module type the UI can send', () => {
    // The lowercase, separator-free ids the frontend posts to
    // POST /api/config/module/:moduleType.
    const expected = [
      'extnotif',
      'storeforward',
      'rangetest',
      'cannedmsg',
      'audio',
      'remotehardware',
      'detectionsensor',
      'paxcounter',
      'serial',
      'ambientlighting',
      'statusmessage',
      'trafficmanagement',
    ];
    for (const t of expected) {
      expect(isValidModuleConfigType(t)).toBe(true);
    }
    // No accidental extras: the set should be exactly the expected list.
    expect([...VALID_MODULE_CONFIG_TYPES].sort()).toEqual([...expected].sort());
  });

  it('rejects unknown module types', () => {
    expect(isValidModuleConfigType('bogus')).toBe(false);
    expect(isValidModuleConfigType('')).toBe(false);
  });

  it('excludes types that use dedicated config routes (telemetry, neighborinfo)', () => {
    // These are valid protobuf module configs but are saved through their own
    // endpoints, not the generic one — so they are intentionally absent here.
    expect(isValidModuleConfigType('telemetry')).toBe(false);
    expect(isValidModuleConfigType('neighborinfo')).toBe(false);
  });
});
